import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { buildMap, type BuildProblem } from "../app/editor/compose/build";
import { COMPONENTS } from "../app/editor/compose/components";
import { parseMapDoc } from "../app/editor/compose/doc";
import { serializeMap } from "../app/lib/mapData";
import { StackPool } from "../app/lib/stackPool";
import { normalizeTiles } from "../app/lib/types";
import { tilesByIdFromList } from "../app/lib/validation";

/** What the world's board was last built from, in the world's own store. */
export const AUTHORED_MAP_KEY = "authoredMap";

export type AuthoredMap = {
  /** Hash of the tree, the tile catalogue and the builder's source. */
  inputs: string;
  /** Hash of the map those inputs built. */
  map: string;
};

export type BuiltWorldMap = { text: string; problems: BuildProblem[] };

const APP_DIR = join(import.meta.dir, "..", "app");

/**
 * The directories the build imports from. Anything that changes what a tree
 * builds lives in one of these, so a change to any file in them builds the
 * world again; one that turns out to build the same map leaves the board alone.
 */
const BUILDER_DIRS = ["editor", "game", "lib"];

export function buildWorldMap(treeText: string, tilesText: string): BuiltWorldMap {
  const parsed = parseMapDoc(JSON.parse(treeText) as unknown);
  if (!parsed.ok) throw new Error(`The world's tree is not a map tree: ${parsed.reason}`);
  const tilesById = tilesByIdFromList(normalizeTiles(JSON.parse(tilesText) as unknown[]));
  const { map, problems } = buildMap(
    parsed.doc,
    tilesById,
    COMPONENTS,
    undefined,
    null,
    new StackPool(),
  );
  return { text: serializeMap(map), problems };
}

export async function builderSourceHash(appDir = APP_DIR): Promise<string> {
  const hash = createHash("sha256");
  const files: string[] = [];
  for (const dir of BUILDER_DIRS) {
    for await (const file of new Bun.Glob("**/*.{ts,json}").scan(join(appDir, dir))) {
      if (!file.endsWith(".test.ts")) files.push(join(dir, file));
    }
  }
  for (const file of files.sort()) {
    hash
      .update(file)
      .update("\0")
      .update(await readFile(join(appDir, file)));
  }
  return hash.digest("hex");
}

export function hashOf(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

const ENTRY = import.meta.path;

/**
 * Builds in a child process, so the build's garbage and the running world are
 * never in one heap. A whole island's build peaks well above the map it
 * leaves; `--smol` collects more often, which keeps that peak lower.
 */
export async function buildWorldMapApart(
  treeText: string,
  tilesText: string,
  workDir: string,
): Promise<BuiltWorldMap> {
  await mkdir(workDir, { recursive: true });
  const stem = join(workDir, `build-${process.pid}-${Date.now()}`);
  const paths = { tree: `${stem}.tree.json`, tiles: `${stem}.tiles.json`, out: `${stem}.map.json` };
  try {
    await writeFile(paths.tree, treeText);
    await writeFile(paths.tiles, tilesText);
    const child = Bun.spawn(
      [process.execPath, "--smol", ENTRY, paths.tree, paths.tiles, paths.out],
      {
        stdout: "pipe",
        stderr: "inherit",
      },
    );
    const [code, report] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    if (code !== 0) {
      throw new Error(
        `Building the world's map from ${relative(process.cwd(), paths.tree)} failed (exit ${code})`,
      );
    }
    const { problems } = JSON.parse(report) as { problems: BuildProblem[] };
    return { text: await readFile(paths.out, "utf8"), problems };
  } finally {
    await Promise.all(Object.values(paths).map((path) => rm(path, { force: true })));
  }
}

if (import.meta.main) {
  const [treePath, tilesPath, outPath] = process.argv.slice(2);
  if (!treePath || !tilesPath || !outPath) {
    console.error("usage: bun server/worldMap.ts <tree.json> <tiles.json> <out.json>");
    process.exit(1);
  }
  const { text, problems } = buildWorldMap(
    await readFile(treePath, "utf8"),
    await readFile(tilesPath, "utf8"),
  );
  await writeFile(outPath, text);
  console.log(JSON.stringify({ problems }));
}
