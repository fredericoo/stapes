import type { DecayInteraction } from "../lib/interactions";
import { resolveDecay } from "../lib/interactions";
import { isItem, resolveContainer } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { countOf, peelOne, stackWithItem, stow, withCount } from "../lib/piles";
import type { StackEdit } from "../lib/mapData";
import { getStack, listCoords, replaceStack, setStacks } from "../lib/mapData";
import type { Coord, MapFile, PlacedTile, TileDef } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import { canReplaceStack } from "../lib/validation";
import { carriedInstances, EQUIPMENT_SLOTS, type Equipment } from "./equipment";
import { type SlotKind, slotAccepts } from "./itemMoves";
import { cellKey } from "./pressurePlates";
import type { Rng } from "./rng";

/**
 * Which placement a deadline belongs to, as a string.
 *
 * Cell plus tile id, and deliberately not the stack index: an index shifts the
 * moment anything is placed under or over it, so a splash of blood would forget
 * how old it was every time somebody walked across it. The trade is that two
 * placements of the *same* decaying tile in one cell share one deadline and go
 * together — which is the difference between a bounded key and one that has to
 * be minted onto the placement and then kept alive through every swap.
 *
 * Only anonymous placements are keyed this way. Anything carrying an identity
 * is keyed by {@link itemEntryKey} instead, because a thing that can be picked
 * up is a thing whose cell is about to be wrong.
 */
function entryKey(cell: Coord, tileId: string): string {
  return `${cellKey(cell)}|${tileId}`;
}

/**
 * Which *thing* a deadline belongs to.
 *
 * The item id and nothing else, which is the whole reason carried things can
 * decay at all: an id is minted once and kept across every pickup, stash and
 * drop (see `../lib/itemInstance`), so one entry follows a berry from the floor
 * into a bag into a chest without the clock ever noticing it moved.
 *
 * No collision with {@link entryKey} is possible: a cell key is digits and
 * commas, and this one is not.
 */
function itemEntryKey(itemId: string): string {
  return `item|${itemId}`;
}

/** An anonymous placement counting down, and when its time is up. */
export type PlacementDecay = {
  kind: "placement";
  cell: Coord;
  tileId: string;
  /** Session-elapsed ms at which this turns. See {@link DecayIndex.advance}. */
  dueMs: number;
};

/** One particular thing counting down, wherever it has got to by then. */
export type ItemDecay = {
  kind: "item";
  itemId: string;
  /**
   * What it was when the clock started.
   *
   * Checked again at expiry, which is what makes a stale entry harmless: a thing
   * that has already turned into something else — or been eaten and its id
   * reused by nothing — reads as an entry about a thing that no longer exists,
   * and is dropped rather than applied to whatever wears the id now.
   */
  tileId: string;
  /** Session-elapsed ms at which this turns. See {@link DecayIndex.advance}. */
  dueMs: number;
};

/** A placement or a thing, counting down. */
export type DecayEntry = PlacementDecay | ItemDecay;

/** Does anything in this cell decay, in the stack or inside a container in it? */
export function cellHasDecay(
  map: MapFile,
  cell: Coord,
  tilesById: Record<string, TileDef>,
): boolean {
  return getStack(map, cell.x, cell.y, cell.z).some((placed) => {
    if (decayOf(placed.tileId, tilesById)) return true;
    // A crate of apples is a cell that decays even when the crate does not.
    return (placed.contents ?? []).some((held) =>
      decayOf(held.tileId, tilesById),
    );
  });
}

/** This tile's decay, or null when it has none and none that parses. */
function decayOf(
  tileId: string,
  tilesById: Record<string, TileDef>,
): DecayInteraction | null {
  const def = tilesById[tileId];
  return def ? resolveDecay(def) : null;
}

/**
 * Every cell holding something that decays. Whole-map scan, for arming the index
 * once at load rather than per tick — the same discipline plates and wires are
 * indexed under.
 */
export function findDecayCells(
  map: MapFile,
  tilesById: Record<string, TileDef>,
): Coord[] {
  const out: Coord[] = [];
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { x, y } of listCoords(map, z)) {
      const cell = { x, y, z };
      if (cellHasDecay(map, cell, tilesById)) out.push(cell);
    }
  }
  return out;
}

/**
 * What is counting down, and how long each has left.
 *
 * **Beside the map, never on it**, and that is the load-bearing decision here.
 * A deadline written onto the placement would ride the wire and the checkpoint
 * for free — which sounds like the whole problem solved, and is the trap. It
 * would also land in `data/map.json` the moment somebody saved from the editor,
 * turning a hand-editable, git-diffable file into one that churns a timestamp
 * per splash of blood. Held out here, decay costs the map format nothing, the
 * protocol nothing, and the checkpoint nothing.
 *
 * What that gives up is continuity across an eviction: a world resumed from a
 * checkpoint re-arms whatever it finds with a full fresh lifetime. That is the
 * same bargain hit points and brain memory already take — a world nobody is
 * looking at owes no continuity — and it is bounded by one lifetime.
 *
 * The clock is **simulated**, summed from the ticks the session actually ran,
 * so a decay is reproducible from a seed and a tick count exactly as a fight
 * is. `Date.now()` in here would make a test's outcome depend on how fast the
 * test ran.
 *
 * ## Two kinds of thing count down here
 *
 * A placement is keyed by where it is, and a *thing* — anything carrying an item
 * id — by which thing it is. That split is the whole of "food rots in your bag":
 * a cell key stops the moment somebody picks the food up, and an item key does
 * not care that it moved. It also means picking a berry up no longer pauses its
 * clock and dropping it no longer restarts it, which was the old behaviour and
 * was not a rule anybody would have chosen.
 */
export class DecayIndex {
  private readonly entries = new Map<string, DecayEntry>();
  private readonly rng: Rng;
  private elapsedMs = 0;
  /**
   * Soonest deadline held, so a tick with nothing due costs one comparison.
   *
   * This is the whole performance story: blood is spawned under every blow
   * landed, so the index runs to hundreds of entries and is read thirty times a
   * second. Scanning it is proportional to what it holds, and this is what
   * keeps that scan off the ticks that have no reason to run it.
   */
  private nextDueMs = Number.POSITIVE_INFINITY;

  /**
   * @param rng the world's dice, shared with the brains rather than owned here.
   *   A lifetime drawn from a private generator would be reproducible on its own
   *   and unreproducible in company: two worlds on one seed would agree about
   *   where every deer walked and disagree about when the blood dried.
   */
  constructor(rng: Rng) {
    this.rng = rng;
  }

  /** Advance the simulated clock by one tick. */
  advance(tickMs: number) {
    this.elapsedMs += tickMs;
  }

  /** Is anything counting down? See `GameSession.isAtRest`. */
  pending(): boolean {
    return this.entries.size > 0;
  }

  /**
   * Start the clock on everything in this cell that decays — the placements and
   * whatever is inside them.
   *
   * Additive: a placement already counting down keeps the deadline it has.
   * Re-stamping would be the obvious reading of "this cell changed" and is
   * exactly wrong — a cell is reindexed whenever anything in it moves, so blood
   * in a doorway would have its timer reset by every person who walked over it
   * and would never dry.
   *
   * Nothing is dropped here either. A placement that has been erased or swapped
   * away leaves its entry behind until the deadline arrives, where the stack
   * read finds nothing to turn and forgets it — the same "a stale extra entry
   * costs one wasted stack read" the plate index runs on, bounded by one
   * lifetime.
   *
   * This is also where the lifetime is **drawn**, once and for good. Rolling at
   * expiry instead would be rolling to decide whether to have expired, and
   * rolling on every re-arm would let a busy cell keep winning itself a longer
   * life.
   */
  armCell(map: MapFile, cell: Coord, tilesById: Record<string, TileDef>) {
    for (const placed of getStack(map, cell.x, cell.y, cell.z)) {
      if (placed.itemId) {
        // A thing on the floor is armed as a thing, not as a placement: it is
        // one pickup away from having no cell at all.
        this.armItem(placed.itemId, placed.tileId, tilesById);
      } else {
        this.armPlacement(cell, placed.tileId, tilesById);
      }
      for (const held of placed.contents ?? []) {
        this.armItem(held.id, held.tileId, tilesById);
      }
    }
  }

  /**
   * Start the clock on everything this actor is carrying.
   *
   * The counterpart to {@link armCell} for the half of the world that has no
   * cells in it. Called from the one place a kit is ever written, on the same
   * terms the cell indexes are rebuilt from the one place a stack is: an arming
   * hook next to the assignment is a fact about that function, where one spread
   * over every caller would be a discipline that eventually slips.
   *
   * Additive like {@link armCell}, and for a sharper reason: a kit is rewritten
   * on every equip, stash and loot, so a berry moved from bag to hand would
   * otherwise come back fresh every time it was touched.
   */
  armEquipment(equipment: Equipment, tilesById: Record<string, TileDef>) {
    for (const instance of carriedInstances(equipment)) {
      this.armItem(instance.id, instance.tileId, tilesById);
    }
  }

  private armPlacement(
    cell: Coord,
    tileId: string,
    tilesById: Record<string, TileDef>,
  ) {
    const decay = decayOf(tileId, tilesById);
    if (!decay) return;
    const key = entryKey(cell, tileId);
    if (this.entries.has(key)) return;
    this.file(key, {
      kind: "placement",
      cell: { ...cell },
      tileId,
      dueMs: this.elapsedMs + this.rollLifetimeMs(decay),
    });
  }

  private armItem(
    itemId: string | undefined,
    tileId: string,
    tilesById: Record<string, TileDef>,
  ) {
    // An anonymous item is one the minting pass missed. It gets no clock rather
    // than a key shared with every other anonymous thing in the world.
    if (!itemId) return;
    const decay = decayOf(tileId, tilesById);
    if (!decay) return;
    const key = itemEntryKey(itemId);
    // Re-armed under the *same* key after it turned into something else, which
    // is how a chain runs: the entry for what it was has already been taken, so
    // this starts the next leg rather than being mistaken for it.
    if (this.entries.has(key)) return;
    this.file(key, {
      kind: "item",
      itemId,
      tileId,
      dueMs: this.elapsedMs + this.rollLifetimeMs(decay),
    });
  }

  /** Hold an entry, and keep the soonest deadline true. */
  private file(key: string, entry: DecayEntry) {
    this.entries.set(key, entry);
    if (entry.dueMs < this.nextDueMs) this.nextDueMs = entry.dueMs;
  }

  /**
   * A lifetime from the authored range, both ends included.
   *
   * **Always exactly one draw**, even where the two ends are equal and the
   * answer was never in doubt. This is the same discipline a swing's three draws
   * are under: a draw count that varied with what an author typed would mean
   * widening one tile's range by a millisecond changed what every creature in
   * the world rolled after it, and a reproducible world is the whole reason
   * these dice are seeded.
   */
  private rollLifetimeMs(decay: DecayInteraction): number {
    return decay.fromMs + this.rng.int(decay.toMs - decay.fromMs + 1);
  }

  /**
   * Everything whose time is up, forgotten on the way out.
   *
   * One pass serves every entry due at this instant and re-reads the soonest
   * deadline while it is already walking the map, so a tick either does nothing
   * or does all of it.
   */
  takeDue(): DecayEntry[] {
    if (this.elapsedMs < this.nextDueMs) return [];

    const due: DecayEntry[] = [];
    let soonest = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.entries) {
      if (entry.dueMs <= this.elapsedMs) {
        due.push(entry);
        this.entries.delete(key);
      } else if (entry.dueMs < soonest) {
        soonest = entry.dueMs;
      }
    }
    this.nextDueMs = soonest;
    return due;
  }
}

export type DecayResult = {
  map: MapFile;
  /** Cells whose stack changed — every index over them is now suspect. */
  changed: Coord[];
};

/**
 * `stack` with every anonymous placement of `tileId` turned, or null when
 * nothing in it turns.
 *
 * A placement somebody is driving is left alone. Deleting a body out from under
 * its runtime would strand an actor whose next `locate` throws, and a decaying
 * tile that has been adopted as somebody's avatar is a map an author can fix —
 * not a world that has to fall over to tell them.
 *
 * A placement carrying an item id is left alone too: it is counting down under
 * its own key, and turning it from here would turn every other copy of the same
 * tile in the cell along with it.
 */
function decayedStack(
  map: MapFile,
  cell: Coord,
  tileId: string,
  tilesById: Record<string, TileDef>,
): PlacedTile[] | null {
  const decay = decayOf(tileId, tilesById);
  if (!decay) return null;
  // A target that does not exist leaves the tile where it is rather than
  // erasing it: a typo in `tiles.json` should read as a decay that never
  // happened, not as content quietly deleting itself.
  if (decay.tileId && !tilesById[decay.tileId]) return null;

  const stack = getStack(map, cell.x, cell.y, cell.z);
  const next: PlacedTile[] = [];
  let turned = false;
  for (const placed of stack) {
    if (placed.tileId !== tileId || placed.owner || placed.itemId) {
      next.push(placed);
      continue;
    }
    turned = true;
    if (decay.tileId) next.push({ ...placed, tileId: decay.tileId });
  }
  if (!turned) return null;

  // Refused rather than forced, exactly as a plate's swap is: whatever a decay
  // becomes has to fit under what has been stacked on it in the meantime.
  return canReplaceStack(map, cell.x, cell.y, cell.z, next, tilesById).ok
    ? next
    : null;
}

/**
 * Turn every anonymous placement in `entries`, in one pass.
 *
 * A decay that cannot happen — the placement is gone, the target does not fit,
 * somebody is driving the body — is abandoned rather than retried. Retrying
 * would hold the world awake spinning on a swap that is never going to fit, and
 * the cell is re-armed for free the next time anything disturbs it.
 */
export function applyDecay(
  map: MapFile,
  entries: Iterable<PlacementDecay>,
  tilesById: Record<string, TileDef>,
): DecayResult {
  const changed: Coord[] = [];
  let next = map;
  for (const { cell, tileId } of entries) {
    const stack = decayedStack(next, cell, tileId, tilesById);
    if (!stack) continue;
    next = replaceStack(next, cell.x, cell.y, cell.z, stack);
    changed.push(cell);
  }
  return { map: next, changed };
}

/**
 * Where a thing is when its time comes, as far as the rules care.
 *
 * Every slot kind, plus the floor — which is not a slot and has no rule, because
 * the ground will hold anything.
 */
type ItemSite = SlotKind | "floor";

/** What becomes of a thing whose time is up. */
type Turn =
  /** Nothing. It was not due, or what it would become cannot go where it is. */
  | { kind: "stays" }
  /** It ceases to exist. */
  | { kind: "gone" }
  /** It is this now. */
  | { kind: "turned"; tileId: string }
  /**
   * One of a pile turns and the rest of the pile does not.
   *
   * **A pile rots a berry at a time, not twelve at once**, which is the reading
   * that makes a pile worth keeping: a heap you cannot touch for a minute
   * without losing all of it is a heap nobody would gather. The clock is the
   * pile's own — one entry, one roll, one berry — and the pile is armed again
   * the moment its holder is rewritten, so the next one is a fresh lifetime
   * later rather than on the same tick.
   *
   * `tileId` absent means the one simply ceases, which needs nowhere to go and
   * so is the one peel a square on a body can do. Where it *does* become
   * something, that something has to land beside the pile — a square in the
   * container, or a slot in the cell — and the caller is what knows whether
   * there is one. There is never one on a body: see {@link slotAfter}.
   */
  | { kind: "peeled"; tileId?: string };

const STAYS: Turn = { kind: "stays" };
const GONE: Turn = { kind: "gone" };
/** One off the pile and nothing left behind — the peel that needs no room. */
const PEELED_GONE: Turn = { kind: "peeled" };

/**
 * What one thing turns into, given where it is standing.
 *
 * The single place the item half of decay decides anything, asked identically of
 * a berry in a hand, a berry in a bag, a berry in a chest and a berry on the
 * floor. Four call sites and one rule is the point: a berry that rots in your
 * bag but not in a crate would be a distinction nobody authored.
 *
 * Every refusal reads the same way — it stays what it is, and is armed again for
 * free the next time its holder is touched, so nothing is stuck forever on a
 * turn that could not happen this time.
 */
function turnOf(
  thing: {
    id: string;
    tileId: string;
    contents?: ItemInstance[];
    /** How many of it, for the piles. See `../lib/piles`. */
    count?: number;
  },
  site: ItemSite,
  due: ReadonlyMap<string, string>,
  tilesById: Record<string, TileDef>,
): Turn {
  // Not due, or due as something it is no longer: an entry names both the thing
  // and what it was, and a thing that has moved on since is not this entry's.
  if (due.get(thing.id) !== thing.tileId) return STAYS;
  const decay = decayOf(thing.tileId, tilesById);
  if (!decay) return STAYS;

  // A pile is asked the same two questions and answers them one berry at a
  // time. It is never a container — nothing that piles holds anything, see
  // `../lib/piles` — so the two guards below about contents cannot apply to one,
  // which is why this branch comes first and reads so much shorter.
  const pile = countOf(thing) > 1;
  if (pile && !decay.tileId) return PEELED_GONE;

  // Nothing decays out from under what it is holding. A pack that rotted away
  // would take a sword and three apples with it, silently, and there is no
  // reading of "your bag went off" that should destroy what was inside it — so
  // a full container simply waits until it is empty.
  const held = thing.contents?.length ?? 0;
  if (!decay.tileId) return held > 0 ? STAYS : GONE;

  // The same refusal `decayedStack` makes for the same reason: a typo in
  // `tiles.json` reads as a decay that never happened.
  const target = tilesById[decay.tileId];
  if (!target) return STAYS;
  if (held > (resolveContainer(target)?.size ?? 0)) return STAYS;

  // The floor asks nothing; a slot asks exactly what it asks of a thing dragged
  // into it, because arriving by rot is still arriving. `isItem` on top, which
  // moves never need: a move can only ever carry a thing that was already an
  // item, and a decay is the one way a slot could come to hold scenery.
  if (site === "floor") {
    return pile
      ? { kind: "peeled", tileId: decay.tileId }
      : { kind: "turned", tileId: decay.tileId };
  }
  // What is asked about is what will actually be *there*: for a pile that is the
  // single thing that comes off it, which carries none of the pile's count and
  // none of its contents, and for anything else the thing itself.
  const next: ItemInstance = pile
    ? { id: thing.id, tileId: decay.tileId }
    : { ...thing, tileId: decay.tileId };
  if (!isItem(target) || !slotAccepts(site, next, tilesById)) return STAYS;
  return pile
    ? { kind: "peeled", tileId: decay.tileId }
    : { kind: "turned", tileId: decay.tileId };
}

/** How many things fit in this tile, or none when it holds nothing. */
function roomIn(tileId: string, tilesById: Record<string, TileDef>): number {
  const def = tilesById[tileId];
  return def ? (resolveContainer(def)?.size ?? 0) : 0;
}

/**
 * A container's contents after the clock, or null when none of them turned.
 *
 * ## Where what comes off a pile goes
 *
 * A peel is the one turn that produces a *second* thing, and it has to land in
 * the same container the pile is in — that is what "one berry in the bag went
 * off" means. So the peels are collected while the list is being walked and
 * placed once it is whole, through the same `stow` a player's drag goes through:
 * poured into a pile of the same rot where one will take it, into a free square
 * otherwise, and refused when there is neither.
 *
 * **A refused peel is put back**, which is why the position is remembered. There
 * is no half state where a berry has left a pile and become nothing; a bag with
 * no room simply keeps the pile it had, and the pile is armed again on the way
 * out — this function reports the container as touched either way, so its holder
 * is rewritten and the clock starts over rather than stalling forever.
 */
function decayedContents(
  contents: readonly ItemInstance[],
  site: ItemSite,
  due: ReadonlyMap<string, string>,
  tilesById: Record<string, TileDef>,
  capacity: number,
  mintId: () => string,
): ItemInstance[] | null {
  const next: ItemInstance[] = [];
  const peels: { at: number; shed: ItemInstance }[] = [];
  let touched = false;
  for (const held of contents) {
    const turn = turnOf(held, site, due, tilesById);
    if (turn.kind === "stays") {
      next.push(held);
      continue;
    }
    touched = true;
    // Gone leaves no hole: contents are a list that fills in order, so a thing
    // rotting out of the middle of a bag closes up behind it exactly as one
    // taken out of it does.
    if (turn.kind === "turned") next.push({ ...held, tileId: turn.tileId });
    if (turn.kind !== "peeled") continue;
    // Only ever reported for a pile of more than one, so this never comes back
    // null — the fallback is a guard against a rule changing over there, not a
    // case that happens.
    const rest = peelOne(held) ?? held;
    if (turn.tileId) {
      peels.push({
        at: next.length,
        shed: { id: mintId(), tileId: turn.tileId },
      });
    }
    next.push(rest);
  }
  if (!touched) return null;

  let out = next;
  for (const { at, shed } of peels) {
    const stowed = stow(out, shed, capacity, tilesById);
    out =
      stowed ??
      out.map((held, i) =>
        i === at ? withCount(held, countOf(held) + 1) : held,
      );
  }
  return out;
}

/** A slot after its contents were offered to the clock. */
type SlotAfter = { changed: boolean; instance: ItemInstance | null };

const UNCHANGED: SlotAfter = { changed: false, instance: null };

/**
 * One slot after the clock, inside and out.
 *
 * Contents are turned first, so the holder's own turn is judged against what it
 * is holding *now* — a pack down to its last apple can rot away on the same tick
 * the apple does, rather than being held back a lifetime by something that is
 * about to go too.
 *
 * Every slot walks its contents, not just the bag: a hand takes a spare pack
 * now, so the thing on your back is no longer the only thing on a body with
 * things inside it. One function over every slot is what stops that staying true
 * of the *decay* rules a release after it stopped being true of the kit.
 */
function slotAfter(
  instance: ItemInstance | null,
  site: SlotKind,
  due: ReadonlyMap<string, string>,
  tilesById: Record<string, TileDef>,
  mintId: () => string,
): SlotAfter {
  if (!instance) return UNCHANGED;
  const contents = instance.contents
    ? decayedContents(
        instance.contents,
        "contents",
        due,
        tilesById,
        roomIn(instance.tileId, tilesById),
        mintId,
      )
    : null;
  const held = contents ?? instance.contents;
  const inside = contents ? { ...instance, contents } : instance;

  const turn = turnOf({ ...instance, contents: held }, site, due, tilesById);
  if (turn.kind === "stays") {
    return { changed: contents != null, instance: inside };
  }
  if (turn.kind === "gone") return { changed: true, instance: null };
  if (turn.kind === "peeled") {
    // **A square on a body has no beside.** It holds one thing, so a berry that
    // came off a pile in your fist would have nowhere at all to be — which is
    // why a peel that becomes something is refused here and only the peel that
    // becomes nothing goes through. A pile held in a hand therefore waits until
    // it is down to its last, and that last one turns in place exactly as a
    // single berry always did. In a bag — where there *is* a beside — it rots
    // one at a time like everything else.
    if (turn.tileId) return { changed: contents != null, instance: inside };
    const rest = peelOne(inside);
    return { changed: true, instance: rest };
  }
  return { changed: true, instance: { ...inside, tileId: turn.tileId } };
}

/**
 * A kit after the clock, or null when nothing in it turned.
 *
 * Over `EQUIPMENT_SLOTS` rather than over the fields by name, which it was: a
 * slot left out here is a square whose contents never rot, and this function had
 * already been the second place the off hand was forgotten. The list is the one
 * the runtime shape is held to, so a square that exists is a square that ages.
 */
function decayedEquipment(
  equipment: Equipment,
  due: ReadonlyMap<string, string>,
  tilesById: Record<string, TileDef>,
  mintId: () => string,
): Equipment | null {
  const next = { ...equipment };
  let changed = false;
  for (const slot of EQUIPMENT_SLOTS) {
    const after = slotAfter(equipment[slot], slot, due, tilesById, mintId);
    if (!after.changed) continue;
    changed = true;
    next[slot] = after.instance;
  }
  return changed ? next : null;
}

/**
 * A placement rewritten as what it turned into.
 *
 * A target that is not an item comes out **anonymous**: a berry that rots into a
 * stain is scenery, and an item id on a tile nobody can pick up is a promise the
 * world has no way to keep — worse, it would keep the thing counting down under
 * an item key when what it has become belongs under a cell key. Dropping the id
 * hands it back to `armCell` as the plain decaying tile it now is.
 */
function placementAfterTurn(
  placed: PlacedTile,
  tileId: string,
  contents: ItemInstance[] | undefined,
  tilesById: Record<string, TileDef>,
): PlacedTile {
  const next: PlacedTile = { ...placed, tileId };
  if (contents) next.contents = contents;
  const def = tilesById[tileId];
  if (def && isItem(def)) return next;
  delete next.itemId;
  return next;
}

/**
 * One cell's stack after the clock, or null when nothing in it turned.
 *
 * A peel on the floor sheds its thing straight into the cell, through the same
 * pour every other way an item reaches one goes through — so a berry rotting out
 * of a pile of twelve joins the rotten berries already lying there rather than
 * starting a thirteenth placement beside them. A cell has no capacity, so this
 * is the one place a peel can never be refused for want of room; whether the
 * *stack* will take the extra height is asked once, over the whole cell, by
 * {@link decayedBoard}.
 */
function decayedItemsInStack(
  stack: readonly PlacedTile[],
  due: ReadonlyMap<string, string>,
  tilesById: Record<string, TileDef>,
  mintId: () => string,
): PlacedTile[] | null {
  let next: PlacedTile[] = [];
  const shed: PlacedTile[] = [];
  let touched = false;
  for (const placed of stack) {
    const contents = placed.contents
      ? decayedContents(
          placed.contents,
          "ground",
          due,
          tilesById,
          roomIn(placed.tileId, tilesById),
          mintId,
        )
      : null;
    const held = contents ?? placed.contents;
    if (contents) touched = true;

    const turn = placed.itemId
      ? turnOf(
          {
            id: placed.itemId,
            tileId: placed.tileId,
            contents: held,
            count: placed.count,
          },
          "floor",
          due,
          tilesById,
        )
      : STAYS;
    if (turn.kind === "gone") {
      touched = true;
      continue;
    }
    if (turn.kind === "turned") {
      touched = true;
      next.push(placementAfterTurn(placed, turn.tileId, held, tilesById));
      continue;
    }
    if (turn.kind === "peeled") {
      touched = true;
      const rest = peelOne(placed) ?? placed;
      next.push(contents ? { ...rest, contents } : rest);
      // Anonymous when what it became is not an item, on exactly the terms
      // {@link placementAfterTurn} drops an id: a berry that rots into a stain
      // is scenery, and an id on a tile nobody can pick up is a promise the
      // world cannot keep.
      if (turn.tileId) shed.push(shedPlacement(turn.tileId, tilesById, mintId));
      continue;
    }
    next.push(contents ? { ...placed, contents } : placed);
  }
  if (!touched) return null;
  for (const placed of shed) next = stackWithItem(next, placed, tilesById);
  return next;
}

/** What comes off a pile on the floor, as a placement. */
function shedPlacement(
  tileId: string,
  tilesById: Record<string, TileDef>,
  mintId: () => string,
): PlacedTile {
  const def = tilesById[tileId];
  return def && isItem(def) ? { tileId, itemId: mintId() } : { tileId };
}

/** The board after the clock: loose things, and things inside things. */
function decayedBoard(
  map: MapFile,
  due: ReadonlyMap<string, string>,
  tilesById: Record<string, TileDef>,
  mintId: () => string,
): DecayResult {
  const edits: StackEdit[] = [];
  const changed: Coord[] = [];
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { x, y, stack } of listCoords(map, z)) {
      const next = decayedItemsInStack(stack, due, tilesById, mintId);
      if (!next) continue;
      // The same refusal a placement decay makes, for the same reason: whatever
      // a thing rots into has to fit under what has been stacked on it.
      if (!canReplaceStack(map, x, y, z, next, tilesById).ok) continue;
      edits.push({ x, y, z, stack: next });
      changed.push({ x, y, z });
    }
  }
  return { map: setStacks(map, edits), changed };
}

/** An actor and what it is carrying — all {@link applyItemDecay} needs of one. */
export type Kit = { id: string; equipment: Equipment };

export type ItemDecayResult = DecayResult & {
  /** Kits that changed, by actor id. Absent means untouched. */
  equipment: Map<string, Equipment>;
};

/**
 * Turn every *thing* whose time is up, wherever it has got to.
 *
 * ## Why this sweeps rather than looks up
 *
 * An item entry names a thing and not a place, which is exactly what lets it
 * survive a pickup — and leaves this pass with no address to go to. It could
 * carry a last-known whereabouts updated on every arm, and that would be exact
 * right up until the one move that forgot to update it, at which point a berry
 * stashed in a chest becomes immortal for reasons nobody can see. So: one walk
 * of the kits and one of the board, and the thing is wherever it is.
 *
 * The cost is a whole-map walk, which is affordable only because it is charged
 * per *tick that has an item due*, not per item — {@link DecayIndex.takeDue}
 * hands over everything ripe at that instant, and the ticks in between pay one
 * comparison. Blood, which is the population that actually runs to hundreds,
 * never reaches here at all: it is anonymous, so it decays by cell.
 *
 * @param mintId a fresh identity for what comes off a pile — a peel is the one
 *   turn that makes a *second* thing, and it needs an id like anything else that
 *   can be picked up. Taken rather than called for the reason `../game/transmute`
 *   takes one: this walk runs on both ends of the wire and in tests, and a
 *   module that reached for `crypto` on its own would be a decay whose outcome
 *   depended on where it ran.
 */
export function applyItemDecay(
  map: MapFile,
  kits: Iterable<Kit>,
  entries: Iterable<ItemDecay>,
  tilesById: Record<string, TileDef>,
  mintId: () => string,
): ItemDecayResult {
  const due = new Map<string, string>();
  for (const entry of entries) due.set(entry.itemId, entry.tileId);

  const equipment = new Map<string, Equipment>();
  for (const kit of kits) {
    const next = decayedEquipment(kit.equipment, due, tilesById, mintId);
    if (next) equipment.set(kit.id, next);
  }
  return { ...decayedBoard(map, due, tilesById, mintId), equipment };
}
