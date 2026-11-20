import type { PlacedTile } from "../../app/lib/types";
import { WATER_TILES } from "../../app/verify/landscape";
import { tile, type Board } from "./board";
import { N8 } from "./grid";
import { Ground, type Island } from "./terrain";

/**
 * The ground under grass, by the ground of the land it gives way to. Grass
 * is drawn over the ground with a ragged edge, so its edge shows the ground
 * of the cell it lies on: sand by default, snow where the grass meets snow.
 */
const UNDER_GRASS: Readonly<Record<string, string>> = {
  sand: "sand",
  "sand-brink": "sand",
  snow: "snow",
  "snow-brink": "snow",
};
const BARE_BRINK: Readonly<Record<string, string>> = { sand: "sand-brink", snow: "snow-brink" };
const DEFAULT_GROUND = "sand";

/**
 * Turns the surface of the island from grass with things laid on it into
 * ground with grass on top. A cell of `grass-2` becomes its ground under
 * `grass`; one with `dirt` laid on it (a road, a bank, a yard) becomes the
 * ground alone, since a path is where the grass is not, and so does one
 * beside a river, so grass stops a cell short of a river's water. A lake or
 * the sea keeps its grass to the water's edge. A `grass-brink` with dirt on it becomes the ground's brink. The
 * ground under a cliff's wall is grassed too, so the wall stands in the same
 * grass as the land at its foot. Dirt comes off the surface only: a tunnel's
 * floor keeps it, on the ground beside it where that is sand or snow, as a
 * cave mouth opens onto the land in front of it. Runs last, after every rule that reads `grass-2` and `dirt`
 * has placed what it places.
 */
export function layGrass(island: Island, board: Board): number {
  const laid: Array<{ i: number; z: number; stack: PlacedTile[] }> = [];
  const floors: typeof laid = [];
  for (const [z, layer] of board.levels) {
    for (const [i, stack] of layer) {
      if (z < 0) continue;
      const surface = island.level[i] === z;
      const top = stack[0]?.tileId;
      const dirt = stack[1]?.tileId === "dirt";
      if (dirt ? surface && (top === "grass-2" || top === "grass-brink") : top === "grass-2")
        laid.push({ i, z, stack });
      else if (dirt && top === "grass-2") floors.push({ i, z, stack });
    }
  }
  const grounds = laid.map(({ i, z }) => groundBeside(island, board.levels.get(z)!, i, z));
  const banks = laid.map(({ i, z }) => besideRiver(island, board.levels.get(z)!, i));
  laid.forEach(({ stack }, k) => {
    const ground = grounds[k]!;
    const brink = stack[0]!.tileId === "grass-brink";
    if (stack[1]?.tileId === "dirt") {
      stack.splice(0, 2, tile(brink ? BARE_BRINK[ground]! : ground));
      return;
    }
    stack.splice(0, 1, tile(ground), ...(banks[k] ? [] : [tile("grass")]));
  });
  for (const { i, z, stack } of floors) reground(island, board.levels.get(z)!, i, z, stack);
  return laid.length;
}

/** Whether a river's water lies beside the cell on its level. */
function besideRiver(island: Island, layer: Map<number, PlacedTile[]>, i: number): boolean {
  const { width: w } = island;
  const x = i % w;
  const y = (i - x) / w;
  return N8.some(([dx, dy]) => {
    const j = (y + dy) * w + x + dx;
    if (island.ground[j] !== Ground.River) return false;
    return !!layer.get(j)?.some((p) => WATER_TILES.has(p.tileId));
  });
}

function reground(
  island: Island,
  layer: Map<number, PlacedTile[]>,
  i: number,
  z: number,
  stack: PlacedTile[],
) {
  const ground = countGrounds(island, layer, i, z);
  if (ground) stack[0] = tile(ground);
}

function groundBeside(
  island: Island,
  layer: Map<number, PlacedTile[]>,
  i: number,
  z: number,
): string {
  return countGrounds(island, layer, i, z) ?? DEFAULT_GROUND;
}

/** The ground most of the cell's neighbours on its level stand on, of those grass gives way to. */
function countGrounds(
  island: Island,
  layer: Map<number, PlacedTile[]>,
  i: number,
  z: number,
): string | undefined {
  const { width: w } = island;
  const x = i % w;
  const y = (i - x) / w;
  const counts = new Map<string, number>();
  for (const [dx, dy] of N8) {
    const j = (y + dy) * w + x + dx;
    const stack = layer.get(j);
    /** Only ground lying open counts: the ground under a cliff's wall is the hill's, not the land the grass gives way to. */
    const under = stack && island.level[j] === z ? UNDER_GRASS[stack[0]?.tileId ?? ""] : undefined;
    if (under) counts.set(under, (counts.get(under) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}
