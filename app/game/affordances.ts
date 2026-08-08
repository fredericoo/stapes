import { getStack } from "../lib/mapData";
import { isInteractive, resolvePush, resolveSwitch } from "../lib/interactions";
import type { Coord, Direction, MapFile, TileDef } from "../lib/types";
import { canReplaceStack } from "../lib/validation";
import { pushDestination } from "./push";

/** A specific placed tile in the map — cell plus slot in its stack. */
export type ObjectRef = Coord & { stackIndex: number };

/** The part of an actor these questions need: where they are standing. */
export type Actor = Coord;

/** Floors above/below an actor that still count for hover and interaction. */
export const INTERACT_LEVEL_SLACK = 1;

/**
 * What an actor can do to an object, as plain functions of the board.
 *
 * Kept out of the session because both ends of the wire ask: the server to
 * validate an interaction it is told about, and the client to decide whether to
 * draw an affordance under the cursor. A client that had to ask the server
 * whether a crate is pushable would light up a round trip late, so it answers
 * locally from the same rules — and because they are the same rules, it cannot
 * disagree with the server about what it offered.
 *
 * Nothing here reads or writes motion state. "Is this actor busy" is a session
 * question and gates these separately; see `GameSession.idle`.
 */

/**
 * Interactive object at a stack slot, if the actor could be looking at it.
 * Buried under another tile is out: only the top of a stack can be acted on.
 */
export function interactiveDefAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): TileDef | null {
  if (Math.abs(ref.z - actor.z) > INTERACT_LEVEL_SLACK) return null;
  const stack = getStack(map, ref.x, ref.y, ref.z);
  if (ref.stackIndex !== stack.length - 1) return null;
  const placed = stack[ref.stackIndex];
  if (!placed) return null;
  const def = tilesById[placed.tileId];
  if (!def || !isInteractive(def)) return null;
  return def;
}

/**
 * Direction the actor would shove this object, or null when they are not
 * standing next to it. Orthogonal only: a diagonal push has no unambiguous
 * "one cell further away" cell, and reading it off the board is guesswork.
 * Floors are not part of the test — reaching one level up or down is fine
 * (see {@link INTERACT_LEVEL_SLACK}); it is the plan view that must touch.
 */
export function pushDirectionFrom(
  actor: Actor,
  ref: ObjectRef,
): Direction | null {
  const dx = ref.x - actor.x;
  const dy = ref.y - actor.y;
  if (Math.abs(dx) + Math.abs(dy) !== 1) return null;
  if (dx === 1) return "e";
  if (dx === -1) return "w";
  return dy === 1 ? "s" : "n";
}

/** Where this object would land if pushed, or null when it cannot be. */
export function pushTargetFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): Coord | null {
  const def = interactiveDefAt(map, tilesById, actor, ref);
  const push = def && resolvePush(def);
  if (!def || !push) return null;

  const direction = pushDirectionFrom(actor, ref);
  if (!direction) return null;

  const check = pushDestination(map, ref, direction, def, push, tilesById);
  return check.ok ? check.to : null;
}

/** Would the switch target fit in this stack slot? */
export function switchWouldFit(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  ref: ObjectRef,
  targetTileId: string,
): boolean {
  if (!tilesById[targetTileId]) return false;
  const stack = getStack(map, ref.x, ref.y, ref.z);
  if (!stack[ref.stackIndex]) return false;
  const next = stack.map((p, i) =>
    i === ref.stackIndex ? { ...p, tileId: targetTileId } : p,
  );
  return canReplaceStack(map, ref.x, ref.y, ref.z, next, tilesById).ok;
}

/**
 * Can this actor switch the object? Same reach as push, plus the target tile
 * having somewhere to go.
 */
export function canSwitchFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): boolean {
  const def = interactiveDefAt(map, tilesById, actor, ref);
  const sw = def && resolveSwitch(def);
  if (!def || !sw || !pushDirectionFrom(actor, ref)) return false;
  return switchWouldFit(map, tilesById, ref, sw.targetTileId);
}

/** Can this actor push the object, ignoring whether they are mid-motion? */
export function canPushFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): boolean {
  return pushTargetFrom(map, tilesById, actor, ref) != null;
}
