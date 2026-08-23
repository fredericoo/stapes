import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import type { Config } from "./config";

/**
 * The built client, served from disk.
 *
 * The client is only files, so the process that already owns the origin serves
 * them — which is what collapses the deployment to one container, removes the
 * reverse-proxy routing table, and makes the actor cookie first-party by
 * construction rather than by configuration.
 *
 * **There is no object storage.** An earlier draft read builds from an S3
 * bucket; on a single box that meant either paying for storage somewhere else
 * or running a MinIO container to talk to itself over HTTP. Continuous
 * integration can simply post the build here, so it does — the store is a
 * directory on the same volume the world lives on.
 *
 * **Builds are immutable and activation is a pointer flip.** CI uploads to
 * `clients/<sha>/` and then activates it. That is the same work as overwriting
 * one directory, and it removes three failure modes:
 *
 * - An upload is not atomic. Overwriting one directory leaves a window where
 *   `index.html` is the new build and a chunk is still the old one.
 * - A tab that loaded five minutes ago still asks for *its* chunks. Old builds
 *   stay on disk and are still served, so those requests are answered rather
 *   than 404ing into a white screen mid-session.
 * - Rollback is activating the previous id, with no rebuild and no deploy.
 */
export class ClientBundle {
  /** Builds held in memory, by id. Serving from disk per request is pointless. */
  private readonly builds = new Map<string, Map<string, Asset>>();
  private activeBuildId: string | null = null;
  private readonly root: string;

  constructor(config: Config) {
    this.root = join(config.DATA_DIR, "clients");
  }

  get active(): string | null {
    return this.activeBuildId;
  }

  /**
   * Come back up serving whatever was being served before.
   *
   * **This is what makes a server deploy safe for the client.** Builds live on
   * the mounted volume rather than in the image, so they survive a new
   * container — but the knowledge of *which* one was live is in memory, and
   * without writing it down a server restart would come back with files on disk
   * and no page to serve. The pointer is a file beside them.
   *
   * Falls back to `CLIENT_BUILD_ID` for the very first deploy, when nothing has
   * been activated yet, and to the newest build on disk after that — so a
   * corrupted or hand-deleted pointer degrades to "serve the latest" rather than
   * to a blank site.
   */
  async restore(preferred?: string): Promise<void> {
    const candidates = [
      await this.readPointer(),
      preferred,
      (await this.stored()).at(-1),
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        await this.activate(candidate);
        return;
      } catch {
        // Try the next one. A build whose directory is half-written should not
        // stop the server coming up — the previous one is very likely fine.
      }
    }
  }

  private async readPointer(): Promise<string | undefined> {
    try {
      const id = (await readFile(join(this.root, POINTER_FILE), "utf8")).trim();
      return id || undefined;
    } catch {
      return undefined;
    }
  }

  /** Build ids on disk, newest last. */
  async stored(): Promise<string[]> {
    try {
      return (await readdir(this.root)).filter((n) => n !== POINTER_FILE).sort();
    } catch {
      return [];
    }
  }

  /**
   * Take an uploaded build and write it out.
   *
   * Written to a directory named for the build, never merged into an existing
   * one: a re-upload of the same id replaces it wholesale rather than leaving a
   * mixture of two attempts.
   */
  async store(buildId: string, files: Map<string, Uint8Array>): Promise<void> {
    assertSafeId(buildId);
    if (!files.has("index.html")) {
      throw new Error(`Build ${buildId} has no index.html — refusing to store it`);
    }

    const directory = join(this.root, buildId);
    await rm(directory, { recursive: true, force: true });

    for (const [path, bytes] of files) {
      const destination = safeJoin(directory, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    // A newly stored build is not yet the one being served. Activation is
    // separate so an upload interrupted halfway can never become the live page.
    this.builds.delete(buildId);
  }

  /**
   * Load a build into memory and make it the one `/` serves.
   *
   * The swap happens after the read, never during: a half-loaded build would
   * serve an `index.html` whose chunks are not there yet, which is the
   * non-atomic upload this design exists to avoid re-inventing.
   */
  async activate(buildId: string): Promise<void> {
    assertSafeId(buildId);
    if (!this.builds.has(buildId)) {
      this.builds.set(buildId, await this.read(buildId));
    }
    this.activeBuildId = buildId;
    // Written before the tidy-up below, so a crash in between leaves the
    // pointer naming a build that is definitely still there.
    await mkdir(this.root, { recursive: true });
    await writeFile(join(this.root, POINTER_FILE), buildId);
    this.evictOldBuilds();
    await this.collectGarbage();
  }

  private async read(buildId: string): Promise<Map<string, Asset>> {
    const directory = join(this.root, buildId);
    const assets = new Map<string, Asset>();

    for (const path of await walk(directory)) {
      const relative = path.slice(directory.length + 1).split(sep).join("/");
      assets.set(relative, {
        bytes: new Uint8Array(await readFile(path)),
        contentType: contentTypeFor(relative),
      });
    }

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
   * Delete builds nobody is on any more.
   *
   * The volume is small and shared with the world, so this is not optional
   * housekeeping — a deploy a day would otherwise fill the disk, and a full disk
   * stops the world checkpointing. The active build and the few before it stay,
   * for tabs that have not reloaded.
   */
  private async collectGarbage() {
    const stored = await this.stored();
    const keep = new Set(stored.slice(-KEPT_BUILDS_ON_DISK));
    if (this.activeBuildId) keep.add(this.activeBuildId);

    for (const id of stored) {
      if (keep.has(id)) continue;
      await rm(join(this.root, id), { recursive: true, force: true });
    }
  }

  /**
   * Answer a request for a static file.
   *
   * Any *resident* build's assets are served, not only the active one — see the
   * mid-session tab above. Content-hashed filenames make that safe: two builds
   * that disagree about a path disagree about its name too.
   *
   * Anything unrecognised falls through to `index.html`, because the client is a
   * single-page app and `/map` is a route rather than a file. `index.html` itself
   * is `no-store`, which is what lets a deploy be noticed at all; the hashed
   * assets beside it are immutable for a year.
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

/** Names the build being served, so a restart comes back on the same one. */
const POINTER_FILE = "active";

/** How many past builds stay in memory for tabs still on them. */
const MAX_RESIDENT_BUILDS = 3;
/** How many stay on disk, so a rollback does not need a rebuild. */
const KEPT_BUILDS_ON_DISK = 5;

type Asset = { bytes: Uint8Array; contentType: string };

/**
 * A build id names a directory, so it is the whole attack surface.
 *
 * Same discipline as `DataStore`'s tileset filenames, and for the same reason:
 * the value arrives over HTTP and is turned into a path.
 */
const SAFE_BUILD_ID = /^[a-zA-Z0-9._-]{1,64}$/;

function assertSafeId(buildId: string) {
  if (!SAFE_BUILD_ID.test(buildId) || buildId === "." || buildId === "..") {
    throw new Error(`Unsafe build id: ${buildId}`);
  }
}

/** Join a path from an archive, refusing anything that climbs out. */
function safeJoin(root: string, path: string): string {
  const joined = normalize(join(root, path));
  if (!joined.startsWith(normalize(root) + sep)) {
    throw new Error(`Refusing to write outside ${root}: ${path}`);
  }
  return joined;
}

async function walk(directory: string): Promise<string[]> {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(directory, entry);
    const info = await stat(path);
    if (info.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

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
