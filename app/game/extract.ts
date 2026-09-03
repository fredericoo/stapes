import type { ExtractInteraction, ExtractSlot } from "../lib/interactions";
import {
  MAX_EXTRACT_CHANCE,
  extractsLeft,
  resolveExtract,
} from "../lib/interactions";
import { resolveContainer, resolveItem } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { getStack } from "../lib/mapData";
import { stow } from "../lib/piles";
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
 * A shared identity for the things a *hypothetical* pull would hand over.
 *
 * Asking whether a pull fits must cost no identities — the question is asked per
 * reachable cell on every pointer move, where the answer is wanted a few times a
 * minute. Safe because an id is one of the fields two piles may differ in and
 * still fuse (see `../lib/piles`' `PILE_FIELDS`), so a placeholder changes no
 * answer this function gives. Nothing minted here ever reaches a kit:
 * {@link extractFits} throws the whole arrangement away and only reports whether
 * there was one.
 */
const HYPOTHETICAL = () => "itm_hypothetical";

/**
 * The bag's contents with this yield stowed into them, or null when it will not
 * fit.
 *
 * **The room check and the placement are one question**, which is the shape
 * `landingsFor` explicitly is not — see the two "deliberate gaps" in
 * `docs/notes.md`, where a recipe's outputs cannot pour precisely because its
 * check counts empty squares and its run fills them separately. Extract has one
 * destination and no landings list, so the two halves can be the same function,
 * and being the same function is what lets a pull *pour*.
 *
 * Pouring matters here more than anywhere: the motivating resource is a bush and
 * the thing it yields is a berry, which is exactly what piles. Counting squares
 * would refuse to pick a bush because you were already carrying berries.
 *
 * Refuses anything that is not a plain carryable item, on `rewardFits`' terms: a
 * container's only home is a bare back — nothing nests — and a bush that quietly
 * took your backpack off is not something an author can see themselves writing.
 * Refused in *this* function rather than beside it, so the check and the run
 * cannot disagree about what is carryable.
 */
export function stowExtracted(
  bag: ItemInstance,
  tileIds: readonly string[],
  tilesById: Record<string, TileDef>,
  mintId: () => string,
): ItemInstance[] | null {
  const capacity = capacityOf(bag, tilesById);
  let contents: ItemInstance[] = [...(bag.contents ?? [])];

  for (const tileId of tileIds) {
    const def = tilesById[tileId];
    if (!def) return null;
    if (!resolveItem(def) || resolveContainer(def)) return null;
    // One at a time and in the authored order, so the arrangement this works
    // out is the arrangement the run produces: a second berry pouring into the
    // pile the first one started is a square the third may then use.
    const next = stow(contents, { id: mintId(), tileId }, capacity, tilesById);
    if (!next) return null;
    contents = next;
  }

  return contents;
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
 * one frame to the next while nothing moved. Every slot could come up, so room
 * is found for every slot. `MAX_EXTRACT_SLOTS` is what keeps that from being a
 * demand nobody can meet — and pouring is what keeps it from being one anyway
 * for the resource this exists for.
 */
export function extractFits(
  extract: ExtractInteraction,
  tilesById: Record<string, TileDef>,
  equipment: Equipment,
): boolean {
  const bag = equipment.bag;
  if (!bag) return false;
  const tileIds = extract.slots.map((slot) => slot.tileId);
  return stowExtracted(bag, tileIds, tilesById, HYPOTHETICAL) !== null;
}

/**
 * The resource here worth walking up to, or null — leaving aside both whether
 * this actor could carry what comes out and whether they have waited long
 * enough.
 *
 * **Two refusals and neither of them distinguished**, on `canRewardFrom`'s
 * terms: out of reach, or spent. Both are facts about the *world*, and a row
 * for either would name a bush that is not worth crossing the field for — so
 * there is no row and no outline, and a bush somebody has stripped bare reads
 * as a bush rather than as something withholding.
 *
 * **What is left out is everything that is a fact about the player**, and that
 * split is the whole reason this is its own function. A bush you have no room
 * for is still a bush worth walking up to; so is one you are counting down on.
 * Neither may be *pulled* — that is {@link canWorkNow}'s answer and the
 * server's — but taking the row away for either tells a player who did nothing
 * that the world changed, which is the one thing a list of affordances must
 * never do. So the row is offered and the reason travels beside it, as
 * `./interactionOptions`' `OptionBlock`.
 */
export function extractOfferedAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): ExtractInteraction | null {
  const extract = reachableExtractAt(map, tilesById, actor, ref);
  if (!extract) return null;
  if (pullsLeftAt(map, tilesById, extract, ref) <= 0) return null;
  return extract;
}

/**
 * Is there a resource here this actor could work — leaving aside whether they
 * have waited long enough?
 *
 * {@link extractOfferedAt}'s two refusals plus the third one, which is room:
 * all or nothing against the best roll, on {@link extractFits}' terms. Together
 * they are **permission** — what the session asks before it spends a pull and
 * what the server asks before it believes a message — where the two halves
 * apart are what the list draws. The client asks both, through
 * {@link canWorkNow}, which is what stops it offering a pull the server would
 * refuse.
 */
export function canExtractFrom(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  ref: ObjectRef,
): boolean {
  const extract = extractOfferedAt(map, tilesById, actor, ref);
  if (!extract) return false;
  return extractFits(extract, tilesById, equipment);
}

/**
 * What this actor still owes the placement at this slot, or null when they may
 * work it now.
 *
 * Read off the tile standing there rather than off the ref alone, because the
 * key names both — see {@link extractKey}. A cell holding no placement owes
 * nothing, on the same terms it offers nothing.
 */
export function extractCooldownAt(
  map: MapFile,
  cooling: CoolingResources,
  ref: ObjectRef,
): ExtractCooling | null {
  const placed = placementAt(map, ref);
  if (!placed) return null;
  return cooling.get(extractKey(ref, placed.tileId)) ?? null;
}

/**
 * May this actor take a pull right now?
 *
 * The two halves read together, which is what the session and the server ask
 * and what the client asks before it lets a tap through. Everything that
 * decides it is above; this only joins them, in one place, so no caller can
 * remember one and forget the other.
 */
export function canWorkNow(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  ref: ObjectRef,
  cooling: CoolingResources,
): boolean {
  if (!canExtractFrom(map, tilesById, actor, equipment, ref)) return false;
  return extractCooldownAt(map, cooling, ref) === null;
}

/**
 * One wait, as the player it belongs to sees it.
 *
 * **Both halves travel, and the second one is what draws the bar.** The
 * remainder alone says whether the row can be pressed; the duration beside it
 * says how far through the wait that is, which is the difference between a
 * disabled row and one that visibly answers "how long". Exactly the pairing
 * `StatusPatch` makes, and for exactly its reason: a client that never saw the
 * wait start cannot work the second number out from the first.
 *
 * **Wound in place, never replaced.** One object is the entry in the owner's
 * map *and* the entry in the list handed out — see
 * `GameSession.setExtractCooldowns` — so a tick advancing the wait costs no
 * allocation and leaves the list's identity alone. That identity is the change
 * signal the renderer gates its whole interaction list on, so a fresh array per
 * tick would rebuild the list thirty times a second for a set that changes
 * twice a pull. Same bargain a `walk` or a `strike` is handed over on.
 */
export type ExtractCooling = {
  /** Which placement, as {@link extractKey}. */
  key: string;
  /** How much of the wait is left. Wound to zero, never below. */
  remainingMs: number;
  /** How long the whole wait was, so a bar knows what it is a fraction of. */
  durationMs: number;
};

/**
 * The waits one actor owes, as something to ask.
 *
 * A lookup rather than a `Map`, which is what lets each end hold it in the
 * shape it already has: the server's truth is a `Map<key, ExtractCooling>` on
 * the actor, and the client's is one built from the list it was sent.
 */
export type CoolingResources = { get(key: string): ExtractCooling | undefined };

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
