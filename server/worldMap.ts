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
import type { StartingWorld } from "./startingWorld";

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

/** Where an image keeps the maps it built, beside the trees in its data directory. */
export const PREBUILT_DIR = "built";

function prebuiltPaths(dataDir: string, treeFile: string) {
  const stem = join(dataDir, PREBUILT_DIR, treeFile.replace(/\.json$/, ""));
  return { stem, map: `${stem}.map.json`, inputs: `${stem}.inputs`, hash: `${stem}.hash` };
}

/** Hashed as parsed, so the image's file and the store's copy of it compare equal. */
export function traitsHash(traits: readonly unknown[]): string {
  return hashOf(JSON.stringify(traits));
}

/** `outDir` is where `built/` goes, so a dev server can prepare its start beside its database. */
export async function prebuildWorldMap(
  dataDir: string,
  treeFile: string,
  outDir = dataDir,
): Promise<BuiltWorldMap> {
  const tree = await readFile(join(dataDir, treeFile), "utf8");
  const tiles = await readFile(join(dataDir, "tiles.json"), "utf8");
  const built = buildWorldMap(tree, tiles);
  const paths = prebuiltPaths(outDir, treeFile);
  await mkdir(join(outDir, PREBUILT_DIR), { recursive: true });
  await writeFile(paths.map, built.text);
  await writeFile(paths.hash, hashOf(built.text));
  await prepareStartingWorld(dataDir, paths.stem, built.text);
  await writeFile(paths.inputs, hashOf(tree, tiles, await builderSourceHash()));
  return built;
}

/**
 * Prepares the store's rows for a first start from this map, so a world
 * starting on it never parses the whole board. Imported here only, so the
 * build child does not load the game.
 */
export async function prepareStartingWorld(dataDir: string, stem: string, text: string) {
  const [{ startingWorldOf }, { writeStartingWorld }] = await Promise.all([
    import("./startingWorld"),
    import("./startingWorldFile"),
  ]);
  const { DataStore } = await import("../app/lib/dataStore");
  const { DiskBlobs } = await import("./blobs");
  const { parseSharedMap } = await import("../app/lib/mapData");
  const { traitsById } = await import("../app/lib/traits");
  const store = new DataStore(new DiskBlobs(dataDir));
  const traits = await store.readTraits();
  const start = startingWorldOf(parseSharedMap(text), await store.readTiles(), traitsById(traits));
  await writeStartingWorld(stem, start, traitsHash(traits));
}

/** The map an image built for `treeFile`, when it was built from exactly these inputs. */
export async function readPrebuiltMap(
  dataDir: string,
  treeFile: string,
  inputs: string,
): Promise<string | null> {
  const paths = prebuiltPaths(dataDir, treeFile);
  try {
    if ((await readFile(paths.inputs, "utf8")) !== inputs) return null;
    return await readFile(paths.map, "utf8");
  } catch {
    return null;
  }
}

/**
 * The starting world an image prepared for `treeFile`, when it was built from
 * exactly these inputs and with these traits.
 */
export async function readPrebuiltStart(
  dataDir: string,
  treeFile: string,
  inputs: string,
  traits: readonly unknown[],
): Promise<{
  hash: string;
  start: StartingWorld;
  mapPath: string;
} | null> {
  const paths = prebuiltPaths(dataDir, treeFile);
  try {
    if ((await readFile(paths.inputs, "utf8")) !== inputs) return null;
    const hash = await readFile(paths.hash, "utf8");
    const { readStartingWorld } = await import("./startingWorldFile");
    const start = await readStartingWorld(paths.stem, traitsHash(traits));
    if (!start) return null;
    return { hash, start, mapPath: paths.map };
  } catch {
    return null;
  }
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

/**
 * Prepares what `prebuildWorldMap` does in a child process, for the same
 * reason the build runs in one.
 */
export async function prebuildWorldMapApart(
  dataDir: string,
  treeFile: string,
  outDir: string,
): Promise<BuildProblem[]> {
  const child = Bun.spawn(
    [process.execPath, "--smol", ENTRY, "--prebuild-into", outDir, dataDir, treeFile],
    { stdout: "pipe", stderr: "inherit" },
  );
  const [code, report] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (code !== 0)
    throw new Error(`Preparing the world's map from ${treeFile} failed (exit ${code})`);
  const last = report.trim().split("\n").at(-1) ?? "{}";
  return (JSON.parse(last) as { problems: BuildProblem[] }).problems;
}

if (import.meta.main && process.argv[2] === "--prebuild-into") {
  const [outDir, dataDir, treeFile] = process.argv.slice(3);
  if (!outDir || !dataDir || !treeFile) {
    console.error("usage: bun server/worldMap.ts --prebuild-into <out dir> <data dir> <tree.json>");
    process.exit(1);
  }
  const { problems } = await prebuildWorldMap(dataDir, treeFile, outDir);
  console.log(JSON.stringify({ problems }));
} else if (import.meta.main && process.argv[2] === "--prebuild") {
  const [dataDir, ...trees] = process.argv.slice(3);
  if (!dataDir || trees.length === 0) {
    console.error("usage: bun server/worldMap.ts --prebuild <data dir> <tree.json>...");
    process.exit(1);
  }
  for (const treeFile of trees) {
    const started = performance.now();
    const { problems } = await prebuildWorldMap(dataDir, treeFile);
    for (const problem of problems) {
      console.warn(`${treeFile}: ${problem.key} was left out of the map: ${problem.reason}`);
    }
    console.log(`built ${treeFile} in ${Math.round(performance.now() - started)} ms`);
  }
} else if (import.meta.main) {
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
