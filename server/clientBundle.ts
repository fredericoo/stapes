import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import type { Config } from "./config";

export class ClientBundle {
  private readonly builds = new Map<string, Map<string, Asset>>();
  private activeBuildId: string | null = null;
  private readonly root: string;

  constructor(config: Config) {
    this.root = join(config.DATA_DIR, "clients");
  }

  get active(): string | null {
    return this.activeBuildId;
  }

  async restore(preferred?: string): Promise<void> {
    const candidates = [await this.readPointer(), preferred, (await this.stored()).at(-1)];
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        await this.activate(candidate);
        return;
      } catch {}
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

  async stored(): Promise<string[]> {
    let ids: string[];
    try {
      ids = (await readdir(this.root)).filter((n) => n !== POINTER_FILE);
    } catch {
      return [];
    }

    const dated = await Promise.all(
      ids.map(async (id) => ({ id, writtenAt: await writtenAt(join(this.root, id)) })),
    );
    return dated
      .sort((a, b) => a.writtenAt - b.writtenAt || a.id.localeCompare(b.id))
      .map((build) => build.id);
  }

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
    this.builds.delete(buildId);
  }

  async activate(buildId: string): Promise<void> {
    assertSafeId(buildId);
    if (!this.builds.has(buildId)) {
      this.builds.set(buildId, await this.read(buildId));
    }
    this.activeBuildId = buildId;
    await mkdir(this.root, { recursive: true });
    await writeFile(join(this.root, POINTER_FILE), buildId);
    this.evictOldBuilds();
    await this.collectGarbage();
  }

  private async read(buildId: string): Promise<Map<string, Asset>> {
    const directory = join(this.root, buildId);
    const assets = new Map<string, Asset>();

    for (const path of await walk(directory)) {
      const relative = path
        .slice(directory.length + 1)
        .split(sep)
        .join("/");
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

  private async collectGarbage() {
    const stored = await this.stored();
    const keep = new Set(stored.slice(-KEPT_BUILDS_ON_DISK));
    if (this.activeBuildId) keep.add(this.activeBuildId);

    for (const id of stored) {
      if (keep.has(id)) continue;
      await rm(join(this.root, id), { recursive: true, force: true });
    }
  }

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

const POINTER_FILE = "active";

const MAX_RESIDENT_BUILDS = 3;
const KEPT_BUILDS_ON_DISK = 5;

type Asset = { bytes: Uint8Array; contentType: string };

const SAFE_BUILD_ID = /^[a-zA-Z0-9._-]{1,64}$/;

function assertSafeId(buildId: string) {
  if (!SAFE_BUILD_ID.test(buildId) || buildId === "." || buildId === "..") {
    throw new Error(`Unsafe build id: ${buildId}`);
  }
}

function safeJoin(root: string, path: string): string {
  const joined = normalize(join(root, path));
  if (!joined.startsWith(normalize(root) + sep)) {
    throw new Error(`Refusing to write outside ${root}: ${path}`);
  }
  return joined;
}

async function writtenAt(directory: string): Promise<number> {
  try {
    return (await stat(directory)).mtimeMs;
  } catch {
    return 0;
  }
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
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-store",
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
