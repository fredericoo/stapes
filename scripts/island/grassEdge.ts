import { COVER_TILES, WATER_TILES } from "../../app/verify/landscape";
import type { PlacedTile, TileDef } from "../../app/lib/types";
import { tile, type Board } from "./board";
import { N8 } from "./grid";
import type { Island } from "./terrain";
import { GRASS_EDGE_VARIANTS } from "../generate-grass-edge";

/** The grounds grass gives way to, and the edge drawn over each. Grass is drawn over them, never the other way round. */
const EDGE_OVER: Readonly<Record<string, string>> = {
  "sand-dunes": "grass-edge-sand",
  snow: "grass-edge-snow",
};
const GRASS_TOPS: ReadonlySet<string> = new Set(["grass-2", "grass-brink"]);

const isBare = (stack: PlacedTile[]) =>
  !stack.some((p) => COVER_TILES.has(p.tileId) || WATER_TILES.has(p.tileId));

/**
 * Lays the grass at a border with sand or snow over that ground, as
 * `grass-edge-sand` or `grass-edge-snow`, so the border is a ragged line of tufts rather than a cut
 * between two square tiles. Only cells on the border change: inside a meadow
 * plain `grass-2` is one quad, and an edge over a base would be two. A cell
 * with a neighbour on another level is left alone, since its edge would
 * fray towards a cliff. Runs after the ground has settled, as the edge's base
 * is sand or snow that `harmoniseGround` and `mergeSpecks` would otherwise
 * read as a speck of it.
 */
export function edgeGrass(
  island: Island,
  board: Board,
  tilesById: Record<string, TileDef>,
): number {
  const edged: Array<{ i: number; stack: PlacedTile[]; base: string }> = [];
  for (const [z, layer] of board.levels) {
    for (const [i, stack] of layer) {
      if (island.level[i] !== z || stack[0]?.tileId !== "grass-2" || !isBare(stack)) continue;
      const base = groundBeside(island, layer, i, tilesById);
      if (base) edged.push({ i, stack, base });
    }
  }
  for (const { i, stack, base } of edged) {
    stack.splice(0, 1, tile(base), tile(`${EDGE_OVER[base]}-${variantAt(i)}`));
  }
  return edged.length;
}

/** A cell's edge variant, from a hash of its index, so neighbours rarely share one. */
const variantAt = (i: number) => (Math.imul(i ^ (i >>> 16), 0x45d9f3b) >>> 0) % GRASS_EDGE_VARIANTS;

/**
 * The ground most of the cell's non-grass neighbours stand on, if grass
 * gives way to it. A floor or a road laid on grass beside the cell draws its
 * edge towards it unless it connects to that ground, and the grass under
 * the floor would then show as a line against the edge's base, so such a
 * cell keeps plain grass.
 */
function groundBeside(
  island: Island,
  layer: Map<number, PlacedTile[]>,
  i: number,
  tilesById: Record<string, TileDef>,
): string | undefined {
  const { width: w, level } = island;
  const x = i % w;
  const y = (i - x) / w;
  const counts = new Map<string, number>();
  const covers = new Set<string>();
  for (const [dx, dy] of N8) {
    const j = (y + dy) * w + x + dx;
    const other = layer.get(j);
    if (!other || level[j] !== level[i]) return undefined;
    if (other.some((p) => GRASS_TOPS.has(p.tileId))) {
      for (const p of other) if (COVER_TILES.has(p.tileId)) covers.add(p.tileId);
      continue;
    }
    const g = other[0]?.tileId;
    if (g && EDGE_OVER[g]) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  const base = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!base) return undefined;
  const seamed = [...covers].some((c) => !tilesById[c]?.connectsTo?.includes(base));
  return seamed ? undefined : base;
}
