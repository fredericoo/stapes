/**
 * Upload the repo's `data/` directory into the DATA R2 bucket.
 *
 * R2 starts empty, so a fresh environment has no map, no tiles and no tilesets
 * until this runs. Keys mirror the paths under `data/`, which is what lets the
 * bucket be read as the checked-in tree.
 *
 * Local by default (wrangler's own R2 emulation under .wrangler/state, which is
 * what `pnpm dev` reads); pass `--remote` to seed the deployed bucket.
 *
 *   pnpm seed
 *   pnpm seed --remote
 *
 * **Seeding is not the whole of putting an environment back.** It replaces the
 * authored content and nothing else; the world being played lives in the
 * Durable Object, which prefers its own checkpoint to the bucket. `pnpm reset`
 * is the two halves together — see `scripts/reset-world.ts`.
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(import.meta.dirname, "../data");

/** Must match `r2_buckets[].bucket_name` in wrangler.jsonc. */
const BUCKET = "stapes-data";

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".png": "image/png",
};

/** R2 keys are `/`-separated regardless of the host platform's separator. */
function keyFor(absPath: string): string {
  return path.relative(DATA_DIR, absPath).split(path.sep).join("/");
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const found = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return filesUnder(full);
      // .DS_Store and friends are not content.
      return entry.name.startsWith(".") ? [] : [full];
    }),
  );
  return found.flat();
}

/** Upload every file under `data/`, one at a time. Returns how many landed. */
export async function seedR2(remote: boolean): Promise<number> {
  const files = await filesUnder(DATA_DIR);

  if (files.length === 0) {
    console.error(`No files found under ${DATA_DIR}`);
    process.exit(1);
  }

  for (const file of files) {
    const key = keyFor(file);
    const contentType = CONTENT_TYPES[path.extname(file)];
    // One at a time: wrangler holds a lock on the local state directory, so
    // parallel puts contend for it and fail.
    execFileSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "r2",
        "object",
        "put",
        `${BUCKET}/${key}`,
        "--file",
        file,
        ...(contentType ? ["--content-type", contentType] : []),
        remote ? "--remote" : "--local",
      ],
      { stdio: "inherit" },
    );
  }

  return files.length;
}

/**
 * Only when run as `pnpm seed`, so `pnpm reset` can import {@link seedR2}
 * without the import itself seeding anything.
 */
if (import.meta.filename === process.argv[1]) {
  const remote = process.argv.includes("--remote");
  seedR2(remote)
    .then((count) => {
      console.log(
        `\n${count} objects seeded into ${BUCKET} (${remote ? "remote" : "local"}).`,
      );
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
