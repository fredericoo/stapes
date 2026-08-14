/**
 * Dump the quads the world renderer would build for a window of cells, as JSON.
 *
 * A debugging aid for depth work: it resolves tiles exactly the way
 * `WorldRenderer.cellItems` does — same frame resolution, same elevation
 * accumulation, same depth box — so an offline compositor can reproduce a
 * frame's ordering pixel for pixel without a GPU.
 */
import { readFileSync } from "node:fs";
import {
  absoluteElevation,
  baseCellWorldOrigin,
  depthBox,
  depthStackBias,
  spriteWorldOrigin,
  type DepthBox,
} from "../app/lib/geometry";
import { getStack, parseMap, setStacks } from "../app/lib/mapData";
import { getFrames } from "../app/lib/tileResolve";
import type {
  CellRect,
  MapFile,
  PlacedTile,
  TileDef,
  TilesetDef,
} from "../app/lib/types";
import { CELL_SIZE, physicalHeight } from "../app/lib/types";

const [x0, x1, y0, y1, zMin, zMax] = process.argv.slice(2, 8).map(Number) as number[];
const extraArg = process.argv[8];

let map: MapFile = parseMap(readFileSync("data/map.json", "utf8"));
const tiles = JSON.parse(readFileSync("data/tiles.json", "utf8")) as TileDef[];
const tilesets = JSON.parse(readFileSync("data/tilesets.json", "utf8")) as TilesetDef[];
const tilesById: Record<string, TileDef> = Object.fromEntries(
  tiles.map((t) => [t.id, t]),
);
const tilesetById = new Map(tilesets.map((t) => [t.id, t]));

/** `x,y,z,tileId[,direction]` per tile to add on top of that cell, `;`-joined. */
for (const spec of extraArg ? extraArg.split(";") : []) {
  const [ex, ey, ez, tileId, direction] = spec.split(",");
  const [x, y, z] = [Number(ex), Number(ey), Number(ez)];
  const stack = [
    ...getStack(map, x, y, z),
    { tileId, ...(direction ? { direction } : {}) } as PlacedTile,
  ];
  map = setStacks(map, [{ x, y, z, stack }]);
}

/**
 * One sprite the renderer would draw, in the shape the offline compositor
 * reads. Written down rather than inferred from the first `push`: the pushes
 * happen inside a callback, which is exactly where TypeScript gives up on
 * evolving an empty array's type and leaves it `any[]`.
 */
type Quad = {
  id: string;
  tilesetId: string;
  rect: CellRect;
  x: number;
  y: number;
  w: number;
  h: number;
  box: DepthBox;
  stackBias: number;
};

const quads: Quad[] = [];
for (let z = zMin!; z <= zMax!; z++) {
  for (let y = y0!; y <= y1!; y++) {
    for (let x = x0!; x <= x1!; x++) {
      let elev = 0;
      getStack(map, x, y, z).forEach((placed, stackIndex) => {
        const def = tilesById[placed.tileId];
        if (!def) return;
        const frame = getFrames(def, { direction: placed.direction, map, x, y, z })?.[0];
        const tileset = frame && tilesetById.get(frame.sprite.tilesetId);
        if (!frame || !tileset) return;

        const foot = absoluteElevation(z, elev);
        const origin = spriteWorldOrigin(
          baseCellWorldOrigin(x, y, z, elev),
          frame.sprite.base,
        );
        quads.push({
          id: `${placed.tileId}@${x},${y},${z}#${stackIndex}`,
          tilesetId: tileset.id,
          rect: frame.sprite.rect,
          x: origin.x,
          y: origin.y,
          w: frame.sprite.rect.w * CELL_SIZE,
          h: frame.sprite.rect.h * CELL_SIZE,
          box: depthBox(x, y, foot, foot + def.height),
          stackBias: depthStackBias(z, stackIndex),
        });
        elev += physicalHeight(def);
      });
    }
  }
}

process.stdout.write(JSON.stringify(quads, null, 1));
