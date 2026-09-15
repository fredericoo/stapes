/**
 * Which client each part of a patch is for.
 *
 * The subscription in `./interest` decides what map a client is *sent*; this
 * decides what it is *told about afterwards*. Until this existed the two were
 * split: a joiner got the chunks near its body, and then every cell that
 * changed anywhere on every tick — so the join scaled with the player and the
 * tick stream scaled with everybody else. Twenty people in twenty corners of
 * the world meant each of them hearing nineteen other neighbourhoods walk
 * about, none of which they could see.
 *
 * **A client hears about a chunk exactly while it is subscribed to it.** That
 * is one rule covering both halves: cells are scoped by the chunk they are in,
 * and a body is scoped by the chunk it is standing in, because a body that a
 * client holds no ground for is a body it cannot draw.
 *
 * **What a client holds is therefore exact inside its subscription and frozen
 * outside it.** Outside is the weaker half and it is deliberate: a chunk that
 * falls out of reach keeps whatever cells it last had, and coming back into
 * reach re-sends it whole (`chunksEntered` drops it from the record on the way
 * out). So a stale cell can only ever be one a client cannot see, and the
 * thing that makes it current again is the same handover a chunk it has never
 * held gets.
 *
 * ## Actors are scoped too, and that is the part with the teeth
 *
 * The cheap version of this change scopes cells and leaves everything keyed on
 * an actor alone. It does not work, and the failure is quiet: a creature that
 * walks out of a client's subscription has its tile patched out of the last
 * cell that client holds, which is indistinguishable from dying —
 * `RemoteSession.forgetDeparted` drops it — and when it walks back in, the
 * server has no reason to mention it again. Its tile is drawn and nothing else
 * is: no name, no health bar, no Talk row. That is the shopkeeper bug in the
 * notes, arrived at from the other end.
 *
 * So the server keeps, per client, the set of bodies that client has been told
 * about, and a body entering the subscription is announced with the whole of
 * its state — the same thing a `hello` does, for one body. Leaving is
 * announced too (`despawned`), which is what keeps the client's actor set from
 * outliving the ground under it. A client that kept an entry for a body it has
 * no cell for pays `findActorAnywhere` — a sweep of its whole board — on every
 * frame, for ever.
 */
import { covers } from "./interest";
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
      // The end it was loosed from, because that is where the shooter is and
      // therefore the half of the flight a client is most likely to hold. A
      // shot from outside into a cell a client can see arrives as the damage
      // number in the same frame, with no arrow — the receipt is the part that
      // matters, and the picture of a flight that began off the edge of what
      // this client holds is the part that does not.
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
 * The cells of this patch that a client subscribed to `chunks` is owed.
 *
 * Returns the array itself when nothing is dropped, so the caller can tell by
 * identity that this client takes the patch whole — which is what lets the
 * common case share one serialization.
 */
export function cellsInScope(
  cells: CellPatch[],
  chunks: ReadonlySet<string>,
): CellPatch[] {
  let out: CellPatch[] | null = null;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    if (covers(chunks, cell.x, cell.y)) {
      out?.push(cell);
      continue;
    }
    // The first one dropped is where the copy starts: everything before it was
    // in scope, and everything after is decided one at a time.
    out ??= cells.slice(0, i);
  }
  return out ?? cells;
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
