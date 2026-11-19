import { writeFile } from "node:fs/promises";
import { PNG } from "pngjs";
import { PLACES, type PlaceId } from "./island/layout";
import { countLevelCells, renderIsland } from "./island/preview";
import { readSketch } from "./island/sketch";
import { GROUND_NAMES, Ground, buildIsland } from "./island/terrain";
import { WALK_DURATION_MS } from "../app/game/constants";

function argValue(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

const seed = Number(argValue("--seed") ?? 75599);
const cellsPerPixel = Number(argValue("--scale") ?? 0.5);
const zoom = Number(argValue("--zoom") ?? 2);
const out = argValue("--out") ?? "island-preview.png";

const sketch = await readSketch();
const t0 = performance.now();
const island = buildIsland(sketch, { seed, cellsPerPixel, peakLevel: 7, seaRing: 20 });
const ms = performance.now() - t0;
await writeFile(out, PNG.sync.write(renderIsland(island, zoom)));

let minX = Infinity;
let minY = Infinity;
let maxX = -Infinity;
let maxY = -Infinity;
let land = 0;
const byGround = new Map<number, number>();
for (let i = 0; i < island.level.length; i++) {
  const g = island.ground[i]!;
  if (g === Ground.DeepSea || g === Ground.Shallows) continue;
  land++;
  byGround.set(g, (byGround.get(g) ?? 0) + 1);
  const x = i % island.width;
  const y = (i - x) / island.width;
  minX = Math.min(minX, x);
  maxX = Math.max(maxX, x);
  minY = Math.min(minY, y);
  maxY = Math.max(maxY, y);
}
const cells = countLevelCells(island);
const places = Object.fromEntries(
  (Object.keys(PLACES) as PlaceId[]).map((id) => [id, island.place(id)]),
);
console.log(
  JSON.stringify(
    {
      seed,
      cellsPerPixel,
      generateMs: Math.round(ms),
      grid: [island.width, island.height],
      land: { cells: land, across: maxX - minX + 1, down: maxY - minY + 1 },
      levelCells: cells.surface,
      perLevel: cells.perLevel,
      ground: Object.fromEntries([...byGround].map(([g, c]) => [GROUND_NAMES[g] ?? g, c])),
      roads: island.roadLengths.map((r) => ({
        ...r,
        seconds: Math.round((r.cells * WALK_DURATION_MS) / 1000),
      })),
      places,
    },
    null,
    1,
  ),
);
