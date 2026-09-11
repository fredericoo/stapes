import type { ExtractInteraction, ExtractSlot } from "../lib/interactions";
import {
  MAX_EXTRACT_CHANCE,
  extractsLeft,
  extractsReserved,
  resolveExtract,
} from "../lib/interactions";
import { resolveContainer, resolveItem } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { getStack, listCoords, replaceStack } from "../lib/mapData";
import { stow } from "../lib/piles";
import { MAX_LEVEL, MIN_LEVEL } from "../lib/types";
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
 * **A pull is something you are part-way through**, which is the whole reason
 * this is a module rather than three lines inside the session. Three things
 * meet here and only one of them is a clock:
 *
 * - the placement's remaining pulls, which everybody shares and which
 *   `../lib/interactions`' `extractsLeft` reads off the map, minus the ones
 *   people are already part-way through taking (`extractsReserved`). The
 *   difference is what a fourth person walking up may still start;
 * - one player's {@link Extraction}, which is the pull they are making right
 *   now — a remainder and the duration it is a fraction of, so a bar can draw
 *   it. At most one, because a person mines one thing at a time;
 * - the roll, which is not a clock at all and happens exactly once, on the
 *   server, at the moment the pull finishes.
 *
 * Pure, and read by both ends on `./transmute`'s terms: the client to decide
 * whether to offer the row, the server to validate the message it is sent.
 * Being the same functions is what stops the client offering a pull the server
 * would refuse.
 */

/**
 * Which placement a player's pull is being made out of, as a string.
 *
 * Cell plus tile id, and deliberately not the stack index, on exactly the
 * grounds `../game/decay`'s `entryKey` gives: an index shifts the moment
 * anything is placed under or over it, so a bush would forget it was being
 * picked every time somebody dropped a torch beside it.
 *
 * Including the tile id is what ends a pull the moment the thing being pulled
 * from stops being that thing. A picked bush and a full bush are two tiles, so
 * a player half way through picking a bush somebody else just emptied is
 * working something that is no longer there — which is exactly when the pull
 * should be taken off them.
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
 * The resource here worth walking up to, or null — leaving aside every fact
 * about the player and about who else is already working it.
 *
 * **Two refusals and neither of them distinguished**, on `canRewardFrom`'s
 * terms: out of reach, or spent. Both are facts about the *world*, and a row
 * for either would name a bush that is not worth crossing the field for — so
 * there is no row and no outline, and a bush somebody has stripped bare reads
 * as a bush rather than as something withholding.
 *
 * **What is left out is everything a row could still usefully say**, and that
 * split is the whole reason this is its own function. A bush you have no room
 * for is still a bush worth walking up to; so is one you are half way through
 * picking; so is one whose last pull the person beside you is already taking.
 * None of the three may be *started* — that is {@link canBeginExtract}'s
 * answer and the server's — but taking the row away for any of them tells a
 * player that the world changed, which is the one thing a list of affordances
 * must never do. So the row is offered and the reason travels beside it, as
 * `./interactionOptions`' `OptionBlock`.
 *
 * Note that a placement whose every remaining pull is reserved is *offered*
 * here: what is left in the vein is the world's answer, and who is holding it
 * is a fact about the room that resolves itself the moment they step away.
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
 * How many pulls at this slot nobody has started on, which is what a player
 * walking up may still take.
 *
 * The shared count minus the ones being held. Two people may work a three-pull
 * vein at once and a third may not, which is the whole of the arrangement: a
 * pull that is being made is a pull that is gone, and finding that out twelve
 * seconds later would be the same bug as two players looting one chest.
 */
export function pullsFreeAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  extract: ExtractInteraction,
  ref: ObjectRef,
): number {
  const placed = placementAt(map, ref);
  if (!placed) return 0;
  const left = pullsLeftAt(map, tilesById, extract, ref);
  return Math.max(0, left - extractsReserved(placed));
}

/**
 * Is there a resource here this actor could start working — leaving aside
 * whether they are already part-way through a pull of their own?
 *
 * {@link extractOfferedAt}'s two refusals plus the two that decide whether a
 * pull can be *begun*: room, all or nothing against the best roll on
 * {@link extractFits}' terms, and a free pull to hold. Together they are
 * **permission** — what the session asks before it reserves anything and what
 * the server asks before it believes a message — where the halves apart are
 * what the list draws.
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
  if (pullsFreeAt(map, tilesById, extract, ref) <= 0) return false;
  return extractFits(extract, tilesById, equipment);
}

/**
 * The pull this actor is making out of the placement at this slot, or null when
 * they are not making one out of *this* one.
 *
 * Read off the tile standing there rather than off the ref alone, because the
 * key names both — see {@link extractKey}. A cell holding no placement is
 * nobody's pull, on the same terms it offers nothing.
 */
export function extractionAt(
  map: MapFile,
  extracting: Extraction | null,
  ref: ObjectRef,
): Extraction | null {
  if (!extracting) return null;
  const placed = placementAt(map, ref);
  if (!placed) return null;
  return extracting.key === extractKey(ref, placed.tileId) ? extracting : null;
}

/**
 * May this actor *start* a pull here right now?
 *
 * The halves read together, which is what the session and the server ask and
 * what the client asks before it lets a tap through. Everything that decides it
 * is above; this only joins them, in one place, so no caller can remember one
 * and forget the other.
 *
 * A pull already running on this placement is the last refusal, and it is the
 * only one that is about the actor's own hands: the row is drawing their bar,
 * and a second tap on it must not start the pull over. Starting one *elsewhere*
 * is allowed and abandons this one — see `GameSession.extract` — because a
 * player who has changed their mind about which crystal to mine should not have
 * to walk away to say so.
 */
export function canBeginExtract(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  ref: ObjectRef,
  extracting: Extraction | null,
): boolean {
  if (!canExtractFrom(map, tilesById, actor, equipment, ref)) return false;
  return extractionAt(map, extracting, ref) === null;
}

/**
 * One pull in progress, as the player making it sees it.
 *
 * **Both halves travel, and the second one is what draws the bar.** The
 * remainder alone says how much longer; the duration beside it says how far
 * through the pull that is, which is the difference between a row that is
 * merely busy and one that visibly answers "how much longer". Exactly the
 * pairing `StatusPatch` makes, and for exactly its reason: a client that never
 * saw the pull start cannot work the second number out from the first.
 *
 * **Wound in place, never replaced.** One object is the runtime's and the one
 * handed out — see `GameSession.setExtraction` — so a tick advancing the pull
 * costs no allocation and leaves the value's identity alone. That identity is
 * the change signal the renderer gates its whole interaction list on, so a
 * fresh object per tick would rebuild the list thirty times a second for
 * something that changes twice a pull. Same bargain a `walk` or a `strike` is
 * handed over on.
 *
 * At most one per actor, unlike the set of waits this replaced: a person mines
 * one thing at a time, and the whole point of the redesign is that working a
 * resource is something you are *doing* rather than something you have done.
 */
export type Extraction = {
  /** Which placement, as {@link extractKey}. */
  key: string;
  /** How much of the pull is left to make. Wound to zero, never below. */
  remainingMs: number;
  /** How long the whole pull takes, so a bar knows what it is a fraction of. */
  durationMs: number;
};

/**
 * How far through a pull a body is, without saying what it is pulling.
 *
 * What everybody else is told about a pull, as against what its owner is told.
 * A bar over somebody's head needs the two numbers of the fraction and nothing
 * more; the key is what the owner's interaction row matches against, and it
 * stays on the owner's own channel.
 */
export type ExtractionProgress = Pick<Extraction, "remainingMs" | "durationMs">;

/**
 * How much of a pull is done, from 0 to 1.
 *
 * Clamped at both ends because the wire does not clamp the remainder against
 * the duration, and the two are wound on different clocks — the server's tick
 * and the client's frame. A pull authored at zero is finished rather than a
 * division by zero.
 */
export function extractionFraction(progress: ExtractionProgress): number {
  if (progress.durationMs <= 0) return 1;
  const done = 1 - progress.remainingMs / progress.durationMs;
  return Math.max(0, Math.min(1, done));
}

/**
 * The placement with one more, or one fewer, pull held out of its count.
 *
 * The field goes entirely rather than sitting at zero, on
 * {@link PlacedTile.extractsLeft}'s terms: a vein nobody is working is as small
 * on the wire and in the checkpoint as it was before reservations existed, and
 * a `0` left behind would be a cell patch saying nothing.
 */
export function withReservation(placed: PlacedTile, delta: number): PlacedTile {
  const held = extractsReserved(placed) + delta;
  if (held > 0) return { ...placed, extractsReserved: held };
  return withoutReservations(placed);
}

/** The placement with nothing held out of its count at all. */
export function withoutReservations(placed: PlacedTile): PlacedTile {
  const { extractsReserved: _held, ...rest } = placed;
  return rest;
}

/**
 * The map with every reservation dropped.
 *
 * Run once as a world loads, because a reservation says somebody is standing
 * there *this second* and nobody is standing anywhere in a checkpoint. Without
 * it, a world that went down while three people were mining would come back
 * with three pulls held for ever by nobody, and the vein would be unworkable
 * until it respawned.
 *
 * A sweep, and it is bounded by the map and runs once — the standing rule
 * against sweeping is about answering *local* questions in the tick loop, which
 * this is not. Returns the same map object when nothing was held, which is
 * every load of a world that shut down cleanly.
 */
export function clearExtractReservations(map: MapFile): MapFile {
  let next = map;
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    // Read off `map` rather than `next`, on `mintItemIds`' terms: the only edit
    // is a field coming off a placement, so nothing moves out from under the
    // walk.
    for (const { x, y, stack } of listCoords(map, z)) {
      if (!stack.some((placed) => placed.extractsReserved != null)) continue;
      next = replaceStack(
        next,
        x,
        y,
        z,
        stack.map((placed) =>
          placed.extractsReserved == null ? placed : withoutReservations(placed),
        ),
      );
    }
  }
  return next;
}

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
 * The placement after a pull has been finished out of it, or null when it is
 * spent and should be swapped for the tile the author named.
 *
 * **Both counts move**, because the pull that just landed was one the finisher
 * had been holding: it comes out of the vein and out of the reservations in the
 * same write, so a vein with one pull left and one person on it never looks
 * momentarily free to the third person watching.
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
  return { ...withReservation(placed, -1), extractsLeft: left };
}
