import * as v from "valibot";
import type { StackEdit } from "../../../lib/mapData";
import type { Component } from "../build";
import { TILES, field } from "../field";
import { fill } from "./fill";

const GrassSchema = v.object({
  tile: v.optional(field.tile(TILES.ground), "grass"),
  onlyOn: v.optional(field.tiles(TILES.ground), ["sand", "snow"]),
});

export type GrassProps = v.InferOutput<typeof GrassSchema>;

/** The fewest cells a piece of grass apart from the rest may have; `MIN_PATCH_CELLS` in `app/verify/landscape.ts` is the same bar. */
const MIN_PIECE_CELLS = 16;

const SIDES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** Drops each piece of the edits joined side to side that is smaller than `MIN_PIECE_CELLS`, unless it is the only piece. */
function withoutSpecks(edits: StackEdit[]): StackEdit[] {
  const at = new Map(edits.map((e) => [`${e.x},${e.y},${e.z}`, e]));
  const seen = new Set<StackEdit>();
  const pieces: StackEdit[][] = [];
  for (const start of edits) {
    if (seen.has(start)) continue;
    const piece = [start];
    seen.add(start);
    for (let k = 0; k < piece.length; k++) {
      const { x, y, z } = piece[k]!;
      for (const [dx, dy] of SIDES) {
        const next = at.get(`${x + dx},${y + dy},${z}`);
        if (!next || seen.has(next)) continue;
        seen.add(next);
        piece.push(next);
      }
    }
    pieces.push(piece);
  }
  if (pieces.length < 2) return edits;
  return pieces.filter((p) => p.length >= MIN_PIECE_CELLS).flat();
}

/**
 * A cover laid on every open cell of its frame whose top tile is in `onlyOn`,
 * which is a `fill` in its `on top` mode with no edge. A piece of fewer than
 * `MIN_PIECE_CELLS` apart from the rest, which a ragged mask leaves along its
 * edge, is not laid. Layers after it take it out again: a road `cuts` it, and
 * a `clear` removes it under a mask.
 */
export const grass: Component<GrassProps> = {
  type: "grass",
  label: "Grass",
  starter: {},
  schema: GrassSchema,
  build(ctx, props) {
    const plan = fill.build(ctx, {
      tiles: [props.tile],
      mode: "on top",
      edge: [],
      edgeWidth: 0,
      onlyOn: props.onlyOn,
    });
    if (!plan.ok || !("edits" in plan)) return plan;
    const kept = plan.edits.filter((e) => ctx.covered(e.x, e.y));
    return { ...plan, edits: withoutSpecks(kept) };
  },
};
