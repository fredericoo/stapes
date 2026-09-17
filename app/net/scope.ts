/**
 * Which client each part of a patch is for.
 *
 * The subscription in `./interest` decides what map a client is sent; this
 * decides what it is told about afterwards, so the tick stream scales with the
 * player's own neighbourhood rather than with everybody else's.
 *
 * Terrain is scoped by the chunk it is in, and a body by how far away it is.
 * Two reaches, because the two are bounded by different things. A client's
 * copy of the map has to cover what its light bake reads, which is
 * `INTEREST_REACH_CELLS` — 79 cells, most of it the cached bake's own apron. A
 * body feeds none of that (every body tile is `lightPassing` and
 * `terrainHeight` skips a person), so what bounds a body is what the client
 * could draw or be lit by, which is `BODY_REACH_CELLS` — 49 cells. Scoping
 * bodies at the terrain reach would save nothing: the subscription is a square
 * 176 cells across, wider than the map, so every client would be told about
 * every creature the brain budget walks each round.
 *
 * A client is never sent a body it has not been told about, which is what
 * keeps the two reaches from disagreeing: cells go out with the bodies outside
 * the body reach taken out of them (`visibleStack`), so a client's board holds
 * a creature only while it holds the creature. Leaving them in leaves a deer
 * tile standing in a cell for ever; see `visibleStack`.
 *
 * What a client holds is therefore exact inside its subscription and frozen
 * outside it. A chunk that falls out of reach keeps whatever cells it last
 * had, and coming back into reach re-sends it whole (`chunksEntered` drops it
 * from the record on the way out). So a stale cell can only ever be one a
 * client cannot see.
 *
 * Actors are scoped too. Scoping cells and leaving everything keyed on an
 * actor alone fails quietly: a creature that walks out of a client's
 * subscription has its tile patched out of the last cell that client holds,
 * which is indistinguishable from dying (`RemoteSession.forgetDeparted` drops
 * it), and when it walks back in the server has no reason to mention it
 * again. Its tile is drawn and nothing else is: no name, no health bar, no
 * Talk row. That is the shopkeeper bug in the notes, arrived at from the other
 * end.
 *
 * So the server keeps, per client, the set of bodies that client has been told
 * about, and a body entering the subscription is announced with the whole of
 * its state, as a `hello` does for one body. Leaving is announced too
 * (`despawned`), which keeps the client's actor set from outliving the ground
 * under it: a client that kept an entry for a body it has no cell for pays
 * `findActorAnywhere`, a sweep of its whole board, on every frame.
 */
import { covers, visibleStack } from "./interest";
import type { CellPatch, MotionEvent } from "./protocol";

/**
 * Who a piece of a patch is about.
 *
 * Three cases rather than two, because an event may name a body, a place, or
 * neither:
 *
 * - **`everybody`** is the headcount. `joined` and `left` carry the number of
 *   people in the world, which is a fact about the world rather than about
 *   anywhere in it, and a client that missed one would draw a wrong number for
 *   the rest of the session with nothing to correct it.
 * - **`actor`** is anything keyed on a body — its walk, its fall, its lean, its
 *   arrival, its going.
 * - **`cell`** is for the events that deliberately carry no actor id: an arrow
 *   in flight and a floating damage number both outlive whoever they were
 *   measured against, so they are placed rather than owned, and the place is
 *   what decides who hears them.
 */
export type Audience =
  | { kind: "everybody" }
  | { kind: "actor"; actorId: string }
  | { kind: "cell"; x: number; y: number };

const EVERYBODY: Audience = { kind: "everybody" };

/** Who this event is for. @see Audience */
export function audienceOf(event: MotionEvent): Audience {
  switch (event.kind) {
    case "joined":
    case "left":
      return EVERYBODY;
    case "projectileFired":
      // The end it was loosed from, where the shooter is and so the half of
      // the flight a client is most likely to hold. A shot from outside into a
      // cell a client can see arrives as the damage number alone, with no
      // arrow; the receipt matters and the flight that began off the edge does
      // not.
      return { kind: "cell", x: event.from.x, y: event.from.y };
    case "damage":
    case "tileTransition":
      return { kind: "cell", x: event.x, y: event.y };
    default:
      return { kind: "actor", actorId: event.actorId };
  }
}

/**
 * Does this reach a client subscribed to `chunks` and holding `known` bodies?
 *
 * `known` rather than a position test, so the answer agrees with what the
 * client was actually told: a body that has entered the subscription but whose
 * announcement has not gone out yet is not somebody this client can hang an
 * event on.
 */
export function reaches(
  audience: Audience,
  chunks: ReadonlySet<string>,
  known: ReadonlySet<string>,
): boolean {
  switch (audience.kind) {
    case "everybody":
      return true;
    case "actor":
      return known.has(audience.actorId);
    case "cell":
      return covers(chunks, audience.x, audience.y);
  }
}

/**
 * A changed cell, with what is needed to decide who it is news to.
 *
 * Both fields are worked out once per tick, off the two boards the diff was
 * taken between, because they are the same answer for every client — only the
 * `held` set they are asked against differs.
 */
export type ScopedCell = {
  cell: CellPatch;
  /**
   * Whether anything other than a body changed here.
   *
   * A cell that only moved bodies is news to a client that holds one of them
   * and to nobody else: with the bodies taken out it is the cell that client
   * already has. That is the whole of the saving — a creature's step is two
   * such cells, and the world walks two dozen creatures a round.
   */
  terrain: boolean;
  /** Whose bodies were in this cell before or after; empty for almost all. */
  bodies: readonly string[];
};

/**
 * The cells of this patch that a client is owed, each carrying only the bodies
 * that client holds.
 *
 * Returns null when every cell survives untouched, which is how the caller
 * tells that this client takes the patch whole — and what lets all of them
 * share one serialization. A same-length answer would not do: a cell can come
 * back with a body taken out of it and the count unchanged.
 */
export function cellsInScope(
  cells: readonly ScopedCell[],
  chunks: ReadonlySet<string>,
  held: ReadonlySet<string>,
  known: ReadonlySet<string>,
): CellPatch[] | null {
  let out: CellPatch[] | null = null;
  for (let i = 0; i < cells.length; i++) {
    const scoped = cells[i]!;
    const mine = cellInScope(scoped, chunks, held, known);
    if (mine === scoped.cell) {
      out?.push(mine);
      continue;
    }
    // The first one dropped or rewritten is where the copy starts: everything
    // before it was this client's as it stood, and everything after is decided
    // one at a time.
    out ??= cells.slice(0, i).map((each) => each.cell);
    if (mine) out.push(mine);
  }
  return out;
}

/** One cell as this client should have it, or null when it is not news. */
function cellInScope(
  scoped: ScopedCell,
  chunks: ReadonlySet<string>,
  held: ReadonlySet<string>,
  known: ReadonlySet<string>,
): CellPatch | null {
  const { cell, terrain, bodies } = scoped;
  // Ground this client has not been handed. What it holds instead is the
  // subscription, and the chunk is handed over whole when it comes into reach.
  if (!covers(chunks, cell.x, cell.y)) return null;
  // Only bodies moved, and this client is holding none of them — so with them
  // taken out, this is the cell it already has.
  //
  // Held *or* known. The two sets differ for exactly one tick, the tick a body
  // died or walked out of reach, and that is the tick whose patch takes the
  // tile off this client's board. Asking only about `held` drops that patch,
  // nothing rewrites the cell again, and the corpse stays where it fell as a
  // tile `fitsTile` calls solid.
  if (!terrain && !bodies.some((o) => held.has(o) || known.has(o))) return null;
  const stack = visibleStack(cell.stack, held);
  return stack === cell.stack ? cell : { ...cell, stack };
}

/** The events of this patch that such a client is owed. @see cellsInScope */
export function eventsInScope(
  events: MotionEvent[],
  chunks: ReadonlySet<string>,
  known: ReadonlySet<string>,
): MotionEvent[] {
  let out: MotionEvent[] | null = null;
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (reaches(audienceOf(event), chunks, known)) {
      out?.push(event);
      continue;
    }
    out ??= events.slice(0, i);
  }
  return out ?? events;
}

/** Entries of an actor-keyed diff that such a client is owed. @see cellsInScope */
export function patchesInScope<T extends { actorId: string }>(
  patches: T[],
  known: ReadonlySet<string>,
): T[] {
  let out: T[] | null = null;
  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i]!;
    if (known.has(patch.actorId)) {
      out?.push(patch);
      continue;
    }
    out ??= patches.slice(0, i);
  }
  return out ?? patches;
}
