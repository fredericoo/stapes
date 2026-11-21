import { parseArgs } from "node:util";
import { buildMap } from "../app/editor/compose/build";
import { COMPONENTS } from "../app/editor/compose/components";
import { parseMapDoc } from "../app/editor/compose/doc";
import { serializeMap } from "../app/lib/mapData";
import type { MapFile } from "../app/lib/types";
import { normalizeTiles } from "../app/lib/types";
import { tilesByIdFromList } from "../app/lib/validation";

const USAGE = `bun run build:map <tree.json> [--out map.json] [--scene scene.json]

Builds a map from a map tree (app/editor/compose/). --out writes the map file,
--scene writes the same cells as a scene for \`bun run scene\` to draw. Exits 1
if any node could not be built, after listing every one that was not.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" }, scene: { type: "string" }, help: { type: "boolean" } },
});

const treePath = positionals[0];
if (values.help || !treePath) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

const parsed = parseMapDoc(JSON.parse(await Bun.file(treePath).text()));
if (!parsed.ok) {
  console.error(`${treePath} is not a map tree: ${parsed.reason}`);
  process.exit(1);
}

const tilesById = tilesByIdFromList(
  normalizeTiles(JSON.parse(await Bun.file("data/tiles.json").text()) as unknown[]),
);

const started = performance.now();
const { map, layout, problems } = buildMap(parsed.doc, tilesById, COMPONENTS);
const ms = Math.round(performance.now() - started);

function cellsOf(file: MapFile) {
  const cells: Array<{ at: [number, number, number]; tiles: unknown[] }> = [];
  for (const [zk, level] of Object.entries(file.levels)) {
    for (const chunk of Object.values(level)) {
      for (const [ck, stack] of Object.entries(chunk)) {
        const [x, y] = ck.split(",").map(Number) as [number, number];
        cells.push({
          at: [x, y, Number(zk)],
          tiles: stack.map((p) =>
            p.direction ? { tile: p.tileId, facing: p.direction } : p.tileId,
          ),
        });
      }
    }
  }
  return cells;
}

const cells = cellsOf(map);
if (values.out) await Bun.write(values.out, serializeMap(map));
if (values.scene) {
  const root = layout.placements.get(parsed.doc.root.key)!.bounds;
  await Bun.write(
    values.scene,
    JSON.stringify({
      cells,
      zoom: 2,
      look: [Math.round((root.minX + root.maxX) / 2), Math.round((root.minY + root.maxY) / 2)],
    }),
  );
}

console.log(JSON.stringify({ ms, nodes: layout.order.length, cells: cells.length, problems }));
if (problems.length > 0) process.exit(1);
