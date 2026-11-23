import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { ChunkCells } from "../app/lib/types";
import type { startingWorldOf, StartingWorld } from "./startingWorld";

type StartingWorldFile = Omit<StartingWorld, "rows"> & { traits: string };

function paths(stem: string) {
  return { start: `${stem}.start.json`, rows: `${stem}.rows.ndjson` };
}

/**
 * `traits` is a hash of the trait catalogue the board was prepared with:
 * residents are found through traits, and the inputs hash a prebuilt map is
 * checked against does not cover them.
 */
export async function writeStartingWorld(
  stem: string,
  start: ReturnType<typeof startingWorldOf>,
  traits: string,
) {
  const { authored: _authored, whole: _whole, rows, ...rest } = start;
  const out = Bun.file(paths(stem).rows).writer();
  for await (const { levelKey, chunkKey, cells } of rows()) {
    out.write(`${JSON.stringify([levelKey, chunkKey, cells])}\n`);
  }
  await out.end();
  await writeFile(
    paths(stem).start,
    JSON.stringify({ ...rest, traits } satisfies StartingWorldFile),
  );
}

/** The starting world written beside a prebuilt map, when it was prepared with the same traits. */
export async function readStartingWorld(
  stem: string,
  traits: string,
): Promise<StartingWorld | null> {
  let file: StartingWorldFile;
  try {
    file = JSON.parse(await readFile(paths(stem).start, "utf8")) as StartingWorldFile;
  } catch {
    return null;
  }
  if (file.traits !== traits) return null;
  const { traits: _traits, ...rest } = file;
  const rowsPath = paths(stem).rows;
  return {
    ...rest,
    async *rows() {
      const lines = createInterface({ input: createReadStream(rowsPath), crlfDelay: Infinity });
      for await (const line of lines) {
        if (line === "") continue;
        const [levelKey, chunkKey, cells] = JSON.parse(line) as [string, string, ChunkCells];
        yield { levelKey, chunkKey, cells };
      }
    },
  };
}
