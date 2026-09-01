import type { ExtractInteraction, ExtractSlot } from "../lib/interactions";
import {
  MAX_EXTRACT_CHANCE,
  extractsLeft,
  resolveExtract,
} from "../lib/interactions";
import { resolveContainer, resolveItem } from "../lib/item";
import { getStack } from "../lib/mapData";
import type { Coord, MapFile, PlacedTile, TileDef } from "../lib/types";
import {
  coveredBySomething,
  withinReach,
  type Actor,
  type ObjectRef,
} from "./affordances";
import type { Equipment } from "./equipment";
import { capacityOf } from "./itemMoves";
import { cellKey } from "./pressurePlates";

/**
 * Working a thing for what it is made of — the rules, with no world to run them
 * against.
 *
 * **Three clocks meet here and only one of them is the board's**, which is the
 * whole reason this is a module rather than three lines inside the session:
 *
 * - the placement's remaining pulls, which everybody shares and which
 *   `../lib/interactions`' `extractsLeft` reads off the map;
 * - this player's wait on this placement, which is theirs alone and reaches
 *   here as a set of {@link extractKey}s rather than as a clock, because
 *   whether it has run out is the only thing any of these rules ask;
 * - the roll, which is not a clock at all and happens exactly once, on the
 *   server, at the moment a pull is actually taken.
 *
 * Pure, and read by both ends on `./transmute`'s terms: the client to decide
 * whether to offer the row, the server to validate the message it is sent.
 * Being the same functions is what stops the client offering a pull the server
 * would refuse.
 */

/**
 * Which placement a player's wait belongs to, as a string.
 *
 * Cell plus tile id, and deliberately not the stack index, on exactly the
 * grounds `../game/decay`'s `entryKey` gives: an index shifts the moment
 * anything is placed under or over it, so a bush would forget it had been
 * picked every time somebody dropped a torch beside it.
 *
 * Including the tile id is what makes the key follow a resource through its own
 * life without following it into the next one. A picked bush and a full bush are
 * two tiles, so the wait a player owes the bush they just emptied does not carry
 * over to the one that grows back in its place — which is right: what the wait
 * paces is *pulls*, and there is nothing left to pull until it has regrown
 * anyway.
 */
export function extractKey(cell: Coord, tileId: string): string {
  return `${cellKey(cell)}|${tileId}`;
}

/**
 * The resource at a stack slot, if this actor could reach it.
 *
 * The tile's half and all of it — a resource has no placement half that could
 * make it *not* one, on `reachableTransmuteAt`'s terms: what a crystal is made
 * of is a fact about crystal. What the *placement* carries is how much of it is
 * left, and that is {@link pullsLeftAt}'s question rather than this one's.
 *
 * Reach is the round `REACH_CELLS` rather than push's orthogonal step, on the
 * grounds a reward's and a recipe's are: reaching into a bush needs no
 * unambiguous "one cell further away", and a crystal you were standing
 * diagonally from that would not be mined would read as a bug.
 *
 * Cover is the rule everything else takes — a bush under a crate is out, and a
 * body is not cover.
 */
export function reachableExtractAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): ExtractInteraction | null {
  if (!withinReach(map, tilesById, actor, ref)) return null;
  const stack = getStack(map, ref.x, ref.y, ref.z);
  if (coveredBySomething(stack, ref.stackIndex, tilesById)) return null;
  const placed = stack[ref.stackIndex];
  if (!placed) return null;
  const def = tilesById[placed.tileId];
  return def ? resolveExtract(def) : null;
}

/** The placement at a slot, or null when the slot is empty. */
function placementAt(map: MapFile, ref: ObjectRef): PlacedTile | null {
  return getStack(map, ref.x, ref.y, ref.z)[ref.stackIndex] ?? null;
}

/**
 * How many pulls are left in the thing at this slot, or zero where there is no
 * resource there at all.
 *
 * Zero for both cases on purpose, and nothing downstream distinguishes them: a
 * spent vein and a wall are equally not worth walking up to, and the moment a
 * pull empties one the placement turns into something else anyway.
 */
export function pullsLeftAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  extract: ExtractInteraction,
  ref: ObjectRef,
): number {
  const placed = placementAt(map, ref);
  if (!placed) return 0;
  const def = tilesById[placed.tileId];
  if (!def || resolveExtract(def) !== extract) return 0;
  return extractsLeft(placed, extract);
}

/**
 * Is there room in the bag for everything a pull could possibly hand over?
 *
 * **All or nothing, measured against the best roll rather than the actual
 * one**, and both halves of that are deliberate.
 *
 * All or nothing is `rewardFits`' rule and it is here for a sharper reason than
 * a reward has: a pull spends the world's durability, so a player who mined a
 * vein and could only carry half of what came out would have destroyed the rest
 * on everybody's behalf. Nothing this hands over is ever dropped, discarded or
 * left on the floor — the row is simply not offered.
 *
 * Against the *best* roll because the roll has not happened yet and must not:
 * asking "does what I am about to draw fit" would mean drawing to decide whether
 * to draw, and a player with one free square would get a different answer from
 * one frame to the next while nothing moved. Every slot could come up, so every
 * slot needs a square. `MAX_EXTRACT_SLOTS` is what keeps that from being a
 * demand nobody can meet.
 *
 * Containers are refused outright, exactly as a reward's are: nothing nests, so
 * a container's only home is a bare back, and a bush that quietly took your
 * backpack off is not something an author can see themselves writing.
 */
export function extractFits(
  extract: ExtractInteraction,
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
): boolean {
  const bag = equipment.bag;
  if (!bag) return false;
  const free =
    capacityOf(bag, tilesById) - (bag.contents?.length ?? 0);
  if (extract.slots.length > free) return false;

  return extract.slots.every((slot) => {
    const def = tilesById[slot.tileId];
    if (!def) return false;
    return resolveItem(def) != null && resolveContainer(def) == null;
  });
}

/**
 * Could this actor work this thing right now?
 *
 * Four refusals and none of them distinguished, on `canRewardFrom`'s terms: out
 * of reach, spent, still cooling, or nowhere to put what comes out. Whichever it
 * is there is no row and no outline, so a bush somebody has just stripped reads
 * as a bush rather than as something withholding.
 *
 * @param cooling the placements this actor may not work yet, as
 *   {@link extractKey}s. See {@link CoolingResources}.
 */
export function canExtractFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  ref: ObjectRef,
  cooling: CoolingResources,
): boolean {
  const extract = reachableExtractAt(map, tilesById, actor, ref);
  if (!extract) return false;
  if (pullsLeftAt(map, tilesById, extract, ref) <= 0) return false;
  const placed = placementAt(map, ref);
  if (!placed) return false;
  if (cooling.has(extractKey(ref, placed.tileId))) return false;
  return extractFits(extract, tilesById, equipment);
}

/**
 * The placements one actor may not work yet, as something to ask.
 *
 * A membership test rather than a `Set`, and that is what lets the two ends
 * hold it in the shapes they already have: the server's truth is a
 * `Map<key, remainingMs>` on the actor, the client's is a `Set` built from the
 * list the server sent, and both answer `has`. Nothing here needs to know how
 * long is left — only whether the wait is over — so nothing here asks.
 */
export type CoolingResources = { has(key: string): boolean };

/** Did this slot's chance come up? Certain is certain; zero is never. */
function drawn(slot: ExtractSlot, random: () => number): boolean {
  return random() * MAX_EXTRACT_CHANCE < slot.chance;
}

/**
 * What one pull actually yields, in the order the author wrote the slots.
 *
 * **Every slot is drawn for, every time, whatever has already come up.** The
 * same fixed-draw-count discipline a swing's three draws and a decay's one
 * lifetime are under, and for the same reason: a draw skipped because the bag
 * had filled would make one player's luck change what the next player rolled,
 * and a reproducible world is the whole point of seeded dice. Nothing here can
 * overflow anyway — {@link extractFits} has already found a square for every
 * slot before the row was ever offered.
 *
 * May legitimately come back empty. A crystal authored as one slot at 40% is a
 * crystal you sometimes chip for nothing, and the pull is still spent: the
 * durability went into the swing, not into what came out of it.
 */
export function rollExtract(
  extract: ExtractInteraction,
  random: () => number,
): string[] {
  const out: string[] = [];
  for (const slot of extract.slots) {
    if (drawn(slot, random)) out.push(slot.tileId);
  }
  return out;
}

/**
 * The placement after a pull has been taken out of it, or null when it is spent
 * and should be swapped for the tile the author named.
 *
 * The count is written down only once it *means* something — a placement with
 * pulls still on the def's own number carries no field, so the first pull out of
 * a three-pull bush writes `2` and a bush nobody has touched stays as small on
 * the wire and in the checkpoint as it was before this existed.
 */
export function placementAfterPull(
  placed: PlacedTile,
  extract: ExtractInteraction,
): PlacedTile | null {
  const left = extractsLeft(placed, extract) - 1;
  if (left <= 0) return null;
  return { ...placed, extractsLeft: left };
}
