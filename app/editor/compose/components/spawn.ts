import * as v from "valibot";
import { PLAYER_TILE_ID } from "../../../game/constants";
import { stackHeight } from "../../../lib/mapData";
import { placed } from "../../generator";
import type { Component } from "../build";
import { field } from "../field";
import { isWet } from "./line";

const SpawnSchema = v.object({
  at: field.point({ level: true }),
  facing: v.optional(field.direction(), "s"),
});

export type SpawnProps = v.InferOutput<typeof SpawnSchema>;

/**
 * Stands the authored `player` marker on the cell at `at`, which is where a
 * new character enters the world and where a death with no respawn point
 * comes back. A world needs exactly one, so a tree meant to be played has
 * one spawn node.
 */
export const spawn: Component<SpawnProps> = {
  type: "spawn",
  label: "Spawn",
  starter: { props: { at: { x: 0, y: 0, pinX: "center", pinY: "center" } } },
  schema: SpawnSchema,
  build(ctx, props) {
    const at = ctx.point(props.at);
    if (!at) return { ok: false, reason: `There is no node called ${props.at.in ?? ""}` };
    const z = ctx.z + (props.at.z ?? 0);
    const stack = ctx.stackAt(at.x, at.y, z);
    if (stack.length === 0) return { ok: false, reason: `There is no ground at ${at.x},${at.y}` };
    if (isWet(stack)) return { ok: false, reason: `${at.x},${at.y} is water` };
    if (stackHeight(stack, ctx.tilesById) > 0) {
      return { ok: false, reason: `Something already stands at ${at.x},${at.y}` };
    }
    return {
      ok: true,
      edits: [
        {
          x: at.x,
          y: at.y,
          z,
          stack: [...stack, placed(PLAYER_TILE_ID, ctx.tilesById, props.facing)],
        },
      ],
    };
  },
};
