import type { Config } from "./config";

/**
 * The built client, served out of a bucket.
 *
 * The client is just files, so the process that already owns the origin serves
 * them — which is what collapses the deployment to one container, removes the
 * reverse-proxy routing table, and makes the actor cookie first-party by
 * construction rather than by configuration.
 *
 * **Builds are immutable and activation is a pointer flip.** CI writes
 * `builds/<sha>/…` and then calls `POST /api/client/activate`. It is the same
 * amount of work as overwriting a fixed prefix and clearing a cache, and it
 * removes three failure modes:
 *
 * - A bucket push is not atomic. Overwriting one prefix leaves a window where
 *   `index.html` is the new build and a chunk is still the old one.
 * - A tab that loaded five minutes ago still asks for *its* chunks. Old builds
 *   stay resident here (see {@link builds}), so those requests are answered
 *   rather than 404ing into a white screen mid-session.
 * - Rollback is flipping the pointer back, with no rebuild and no deploy.
 */
export class ClientBundle {
  /**
   * Every build this process has loaded, by id.
   *
   * Kept rather than replaced, for the mid-session tab above. Bounded by
   * {@link MAX_RESIDENT_BUILDS} because this is memory and a long-lived process
   * could otherwise accumulate a fortnight of deploys.
   */
  private readonly builds = new Map<string, Map<string, Asset>>();
  private activeBuildId: string | null = null;
  private readonly client: Bun.S3Client | null;

  constructor(private readonly config: Config) {
    this.client = config.CLIENT_BUCKET
      ? new Bun.S3Client({
          bucket: config.CLIENT_BUCKET,
          endpoint: config.CLIENT_BUCKET_ENDPOINT,
          region: config.CLIENT_BUCKET_REGION,
          accessKeyId: config.CLIENT_BUCKET_ACCESS_KEY_ID,
          secretAccessKey: config.CLIENT_BUCKET_SECRET_ACCESS_KEY,
        })
      : null;
  }

  get active(): string | null {
    return this.activeBuildId;
  }

  /** Whether this deployment serves a client at all. False under Vite in dev. */
  get enabled(): boolean {
    return this.client !== null;
  }

  /**
   * Load a build and make it the one `/` serves.
   *
   * The swap happens after the download, never during: a half-loaded build
   * would serve a `index.html` whose chunks are not there yet, which is exactly
   * the non-atomic push this design exists to avoid re-inventing.
   */
  async activate(buildId: string): Promise<void> {
    if (!this.client) throw new Error("No client bucket configured");
    if (!this.builds.has(buildId)) {
      this.builds.set(buildId, await this.download(buildId));
    }
    this.activeBuildId = buildId;
    this.evictOldBuilds();
  }

  private async download(buildId: string): Promise<Map<string, Asset>> {
    const client = this.client!;
    const prefix = `builds/${buildId}/`;
    const assets = new Map<string, Asset>();

    // `list` rather than a manifest: the manifest would be a second thing CI
    // has to write correctly, and its being wrong is invisible until a chunk
    // 404s in somebody's browser.
    let continuationToken: string | undefined;
    do {
      const page = await client.list({ prefix, continuationToken });
      for (const entry of page.contents ?? []) {
        const path = entry.key.slice(prefix.length);
        if (!path) continue;
        const bytes = await client.file(entry.key).bytes();
        assets.set(path, { bytes, contentType: contentTypeFor(path) });
      }
      continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (continuationToken);

    if (!assets.has("index.html")) {
      throw new Error(`Build ${buildId} has no index.html — refusing to serve it`);
    }
    return assets;
  }

  private evictOldBuilds() {
    while (this.builds.size > MAX_RESIDENT_BUILDS) {
      const oldest = [...this.builds.keys()].find((id) => id !== this.activeBuildId);
      if (!oldest) return;
      this.builds.delete(oldest);
    }
  }

  /**
   * Answer a request for a static file.
   *
   * Any *known* build's assets are served, not only the active one — see the
   * mid-session tab above. Content-hashed filenames make that safe: two builds
   * that disagree about a path disagree about its name too.
   *
   * Anything unrecognised falls through to `index.html`, because the client is
   * a single-page app and `/map` is a route rather than a file. `index.html`
   * itself is `no-store`, which is what lets a deploy be noticed at all; the
   * hashed assets beside it are immutable for a year.
   */
  respond(pathname: string): Response | null {
    if (!this.activeBuildId) return null;
    const path = pathname.replace(/^\/+/, "") || "index.html";

    const fromActive = this.builds.get(this.activeBuildId)!.get(path);
    if (fromActive) return toResponse(fromActive, path);

    for (const [id, assets] of this.builds) {
      if (id === this.activeBuildId) continue;
      const asset = assets.get(path);
      if (asset) return toResponse(asset, path);
    }

    const index = this.builds.get(this.activeBuildId)!.get("index.html")!;
    return toResponse(index, "index.html");
  }
}

/** How many past builds stay in memory for tabs that are still on them. */
const MAX_RESIDENT_BUILDS = 3;

type Asset = { bytes: Uint8Array; contentType: string };

function toResponse(asset: Asset, path: string): Response {
  const immutable = path !== "index.html";
  return new Response(asset.bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": asset.contentType,
      "Cache-Control": immutable
        ? "public, max-age=31536000, immutable"
        : "no-store",
    },
  });
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  ico: "image/x-icon",
  map: "application/json",
};

function contentTypeFor(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}
