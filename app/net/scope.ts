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
 * **Terrain is scoped by the chunk it is in, and a body by how far away it is.**
 * Two reaches rather than one, because the two are bounded by different things.
 * A client's copy of the *map* has to cover what its light bake reads, which is
 * `INTEREST_REACH_CELLS` — 79 cells, most of it the cached bake's own apron. A
 * *body* feeds none of that: every body tile is `lightPassing` and
 * `terrainHeight` skips a person, so what bounds a body is what the client
 * could draw or be lit by, which is `BODY_REACH_CELLS` — 49 cells.
 *
 * **Scoping bodies at the terrain reach is what the first version of this did,
 * and it saved nothing.** The subscription is a square 176 cells across;
 * `data/map.json` is 168 wide. So every client held the whole width of the
 * world, and the brain budget walks two dozen creatures somewhere on it every
 * round — which is exactly the deer, in exactly the town, that the player far
 * out in the hills could not see and was told about anyway.
 *
 * **A client is never sent a body it has not been told about**, which is what
 * keeps the two reaches from disagreeing: cells go out with the bodies outside
 * the body reach taken out of them (`visibleStack`), so a client's board holds
 * a creature only while it holds the creature. Leaving them in is the version
 * that looks cheaper and leaves a deer tile standing in a cell for ever — see
 * `visibleStack` for what that costs.
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
import { chunkKeyFor } from "../lib/mapData";
import { visibleStack } from "./interest";
import type { CellPatch, MotionEvent } from "./protocol";

/**
 * Who a piece of a patch is about.
 *
 * Two cases, because an event names either a body or a place:
 *
 * - **`actor`** is anything keyed on a body — its walk, its fall, its lean, its
 *   arrival, its going. `joined` and `left` are here too: they once carried
 *   the headcount and went to everybody, and a player is no longer told how
 *   many others are online — so they also do not hear about arrivals and
 *   departures out of reach, which they could count.
 * - **`cell`** is for the events that deliberately carry no actor id: an arrow
 *   in flight and a floating damage number both outlive whoever they were
 *   measured against, so they are placed rather than owned, and the place is
 *   what decides who hears them.
 */
export type Audience = { kind: "actor"; actorId: string } | { kind: "cell"; x: number; y: number };

/** Who this event is for. @see Audience */
export function audienceOf(event: MotionEvent): Audience {
  switch (event.kind) {
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
  /**
   * The chunk the cell is in, when it has been worked out already.
   *
   * Optional because it is the same fact as the cell's `x` and `y`, and only a
   * saving: a tick's cells are asked about once per client, and building the
   * chunk's key string for each of those questions was a measurable share of
   * cutting a patch for a thousand players.
   */
  chunk?: string;
};

/**
 * One cell as this client should have it, or null when it is not news.
 *
 * The same object when nothing in it had to change for this client, which is
 * how the server tells a patch it can send whole — and what lets every client
 * that takes it whole share one serialization. An equal copy would not do.
 */
export function cellInScope(
  scoped: ScopedCell,
  chunks: ReadonlySet<string>,
  held: ReadonlySet<string>,
  known: ReadonlySet<string>,
): CellPatch | null {
  const { cell, terrain, bodies } = scoped;
  // Ground this client has not been handed. What it holds instead is the
  // subscription, and the chunk is handed over whole when it comes into reach.
  if (!chunks.has(scoped.chunk ?? chunkKeyFor(cell.x, cell.y))) return null;
  // Only bodies moved, and this client is holding none of them — so with them
  // taken out, this is the cell it already has.
  //
  // **Held *or* known, and asking only about `held` was a bug that shipped.**
  // The two sets differ for exactly one tick, and it is the tick that matters:
  // a body that died is off the board before the patch is cut, and a body that
  // walked out of reach is out of it — so in both cases the one patch that
  // takes the tile off this client's board is the one that was dropped, and
  // nothing rewrites that cell again. A corpse stayed where it fell, and a
  // creature that wandered off left a tile behind that `fitsTile` calls solid.
  if (!terrain && !bodies.some((o) => held.has(o) || known.has(o))) return null;
  const stack = visibleStack(cell.stack, held);
  return stack === cell.stack ? cell : { ...cell, stack };
}
