import {
  canWalk,
  DIR_DELTA,
  listStandingSurfaces,
  standingAbs,
  surfacesInClimbBand,
} from "./movement";
import { cellKey } from "./pressurePlates";
import { getStack, removeTileAt } from "../lib/mapData";
import { resolveAddStatus, resolveTeleportDef } from "../lib/interactions";
import type { StatusDef } from "../lib/status";
import { fitsAtElevation } from "../lib/validation";
import type { Coord, Direction, MapFile, TileDef } from "../lib/types";
import { DIRECTIONS } from "../lib/types";
import { MAX_CLIMB_HEIGHT } from "./constants";

/**
 * A route across the board, one step at a time.
 *
 * Kept out of the session for the same reason `sight` and `affordances` are:
 * this is a question about a board and a body, and nothing here knows what a
 * brain is or how a step gets committed. The session hands it a map and gets
 * back a list of steps.
 *
 * ## The board already knows how to walk, and this does not restate it
 *
 * Every edge is one call to {@link canWalk}, which is the same function the
 * player's own step goes through. Climb bands, level promotion, climb-from
 * direction flags, whether a body fits where it is going — none of that is
 * written down twice, so a route can never contain a step the walk loop would
 * then refuse. That is also how a route gets heights and floors for free: a
 * node is a *standing cell*, and two cells on different levels are neighbours
 * exactly when a body could walk between them.
 *
 * The cost of that reuse is that `canWalk` is not cheap — a column scan and a
 * fit check per direction — which is what {@link PATH_MAX_NODES} is for.
 *
 * ## Arriving means standing next to them, not on them
 *
 * A body is not walkable, so the target's own cell never passes a fit check and
 * a search for it would exhaust the board every time. The goal is therefore
 * *adjacency on the target's own floor*: one plan step away, same level. A
 * creature that is already there gets an empty route rather than a failure,
 * which is what lets "hit them, else close on them, else hold" read straight
 * down a priority list — the closing line has nothing left to offer and falls
 * through to the next.
 *
 * Requiring the same level rather than ignoring z is what makes somebody on the
 * balcony above worth walking a staircase for. Standing under them is not
 * standing beside them, and a route that thought otherwise would stop dead at
 * the bottom of the stairs.
 *
 * A player walking to a cell they pointed at wants the other answer — the cell
 * itself, not a neighbour of it — so {@link PathOptions.arrive} chooses, and
 * "beside" is the default because every caller that predates the option means
 * a body it is walking up to. @see ../game/walkTo
 *
 * ## A cell that does something to you on arrival is not a way through
 *
 * A flame burns whoever lands in it and a portal sends them somewhere else, and
 * both fire on the *step* with nothing to press. Neither is a floor, so neither
 * is an edge: {@link unsafeToStepOn} takes them out of {@link neighbours}, and
 * every search in this file inherits that — a creature chasing you, a creature
 * running from you, and a player's clicked walk alike.
 *
 * **Only what the tile actually does to the body is read.** A teleport is
 * always avoided, because a route through one is not a route: you arrive
 * somewhere the search never considered and the plan behind it is void. A
 * status is avoided when its tone is `bad`, so a route goes round a fire and
 * straight over a shrine — the two are the same block with different content,
 * and treating them alike would have a pathfinder deciding that being blessed
 * is a hazard.
 *
 * **The goal is exempt, and has to be.** A portal is a place you walk into on
 * purpose and a click on a flame is a click on a flame, so a cell that is
 * *itself* what was asked for stays an edge — the same shape
 * {@link PathOptions.drops}' `"toGoal"` takes, and for the same reason. Only
 * with `arrive: "on"`, because that is the only mode in which a caller has
 * pointed at a cell to stand in.
 *
 * What this rules out is a room whose only entrance is a flame or a portal:
 * nothing will route into it, and walking in by hand is the way in. That is the
 * intended trade — a route is a plan, and a plan that walks you through fire to
 * save two steps is not one anybody asked for.
 *
 * ## Two facts about the searcher, not one
 *
 * Where a search starts and where the searcher's body is are different
 * questions, and {@link PathStart} makes a caller answer both. They are the same
 * cell for anything standing still, which is why they were one parameter for as
 * long as only brains asked — and they are two cells for a body mid-step, which
 * commits to the board only on landing. @see PathStart.self
 *
 * ## Saying which limit was hit
 *
 * A search comes back with a route or with a reason ({@link PathOutcome}), and
 * the reasons are not interchangeable: nowhere left to look is a fact about the
 * board, while the two caps below are facts about what this module is willing to
 * spend. A caller with a sentence to write needs to know which — see
 * `./notices`' `noRouteNotice`, which said "there is no way there" about a room
 * the player was looking straight into for as long as all three were one null.
 */

/**
 * How many cells a search may take off the queue before giving up.
 *
 * A ceiling on work rather than a tuning knob, and the two numbers that set it
 * are far apart. Routes anybody actually walks on the shipped map settle in
 * seven to twenty-five cells, because an exact plan-distance heuristic barely
 * fans out in the open. What costs is the target with *no* way to it — visible
 * across a courtyard through a window, say — where the only proof is exhausting
 * everywhere a body could stand, and a whole floor is thousands of cells.
 *
 * So this is set several times over what a real route needs and nowhere near
 * what an impossible one would take: enough headroom for a detour round a
 * building, and about five milliseconds spent on somebody unreachable rather
 * than twenty.
 *
 * Giving up hands back no route at all, deliberately. A half-explored search
 * has a best-so-far cell it could walk towards, and following it is how a
 * creature ends up pressed against the wall nearest you having "made progress"
 * — which is the behaviour this module exists to remove. What it does say is
 * that this is the limit it hit rather than the board: `"budget"`, not
 * `"unreachable"`. @see PathRefusal
 */
export const PATH_MAX_NODES = 128;

/**
 * How far out of its way a route may go, in steps.
 *
 * A *behaviour* rule that happens to also be what makes the search cheap, and
 * the two agree rather than trading off. Walking forty cells round a building
 * to reach somebody standing eight cells away is not a creature chasing you —
 * it is one that has worked out where the door is, and nothing in this game has
 * any business knowing that.
 *
 * Additive rather than a multiple of the gap, and that is the whole of why it
 * bounds the work: what A* explores is the cells whose detour is still under
 * the cap, so a fixed slack is a fixed-size region to search whether the target
 * is two cells away or twenty. A multiple would let a distant target open the
 * search back out to the whole floor, which is exactly the case that hurts.
 *
 * The case it removes is the one that actually costs: somebody visible through
 * a window with no way round. Proving *that* means exhausting everywhere a body
 * could stand — on the shipped map, the whole ground floor, and about twenty
 * milliseconds every time the creature has a turn. The answer is the same
 * either way; only the price of it changes.
 */
export const PATH_DETOUR_SLACK = 16;

/** One leg of a route: the direction to press, and where it lands. */
export type PathStep = { direction: Direction; to: Coord };

/** Who is searching, and from where. */
export type PathStart = {
  /** The cell the first leg is taken from. */
  at: Coord;
  /**
   * The searcher's own body on the board, which is not a wall to itself.
   *
   * Left out of the board for the length of the search, so the cell it stands
   * in is measured as the cell rather than as an occupied one — its own
   * standing surface included, since a body standing on its own head is the
   * elevation nonsense this removes.
   *
   * **Not the same cell as {@link at} whenever a step is in flight.** A walk
   * commits to the map on landing, so a body mid-step is still placed in the
   * cell it is leaving while the next leg is owed from the cell it is landing
   * in. Told only one of the two, the search treats the walker's own body as a
   * wall behind it: in a one-wide corridor there is then no way back the way it
   * came, and the walk is refused with a sentence about a route that plainly
   * exists. Anything standing still passes the same cell twice, which is what
   * the parameter looked like when only brains asked.
   */
  self: Coord & { stackIndex: number };
};

/**
 * Why a search has no route to offer.
 *
 * Three different facts, and a caller that has to say something out loud needs
 * them apart: only one of them is about the board.
 *
 * - `"unreachable"` — everywhere a body could get to from here was searched and
 *   offered, and the goal was not among it. The board's own answer, and the
 *   only one of the three that is.
 * - `"detour"` — the search ran out of cells having turned some away at
 *   {@link PATH_DETOUR_SLACK}, so it has not seen the whole board and a way
 *   round may exist. The cap is a rule about what counts as going *towards*
 *   something, not about what exists.
 * - `"budget"` — {@link PATH_MAX_NODES} ran out with cells still queued. The
 *   search stopped before it had an answer, and nothing was established either
 *   way.
 *
 * **`"detour"` swallows a good many sealed cells**, and deliberately. Any open
 * board has far corners whose detour is over the cap, so a goal that is truly
 * walled off is usually reported as a detour rather than as unreachable — the
 * search turned cells away and cannot honestly say it looked everywhere. The
 * error is deliberately in that direction: `./notices` writes `"detour"` as
 * "there is no short way there", which is true of a long way round and of no
 * way at all, while "there is no way there" about a room with a door round the
 * back is false and stops a player who could have walked to it.
 */
export type PathRefusal = "unreachable" | "detour" | "budget";

/**
 * What a search found: a route, or why there is not one.
 *
 * An **empty** route is a success and not a failure — it is a body that has
 * already arrived — and telling that from having no route is what lets a brain
 * fall through to whatever it does once it is standing next to somebody. That
 * distinction predates this type and is the reason it is `ok` with an empty
 * list rather than a fourth refusal.
 */
export type PathOutcome =
  | { ok: true; route: PathStep[] }
  | { ok: false; why: PathRefusal };

export type PathOptions = {
  /**
   * May a leg of the route leave the ground, and where may it land?
   *
   * The board lets anybody walk into open air so gravity can pull them through,
   * and whether that is a route or a mistake is the caller's to decide. A drop
   * that is allowed is a **one-way edge** — the search resolves where gravity
   * would put the body down and carries on from there, and nothing offers a way
   * back up.
   *
   * - `"never"` — the default, and what every caller meant before there was
   *   anything else: a leg that leaves the ground is not an edge at all.
   * - `"toGoal"` — a drop is allowed only when it lands somewhere
   *   {@link arrived} accepts, so falling is the last leg of a route and never a
   *   way through to somewhere else. What that rules out is the reason it
   *   exists: a fall costs one step like any other leg, so a search free to take
   *   one anywhere steps off the nearest ledge whenever that is shortest, and
   *   somebody who asked to walk across a room gets thrown off the balcony on
   *   the way.
   * - `"anywhere"` — a drop is an edge like any other, wherever it lands. What
   *   a creature's `allowDrops` has always meant, and the leaping is fine there
   *   because a brain that is given the flag is one an author wants falling.
   *
   * One setting with three values rather than two booleans side by side,
   * because "may it fall" and "may it fall on the way" are not independent
   * questions: three of the four pairs mean something and the fourth means
   * nothing at all.
   */
  drops?: "never" | "toGoal" | "anywhere";
  /** Cells to give up after taking off the queue. @see PATH_MAX_NODES */
  maxNodes?: number;
  /**
   * Where the route ends: beside the goal cell, or in it.
   *
   * `"beside"` by default, which is what closing on a body means and what every
   * caller before this option existed asked for. `"on"` is for a cell somebody
   * pointed at: a patch of floor is not something you stop next to.
   *
   * The mode is read by {@link arrived} *and* by {@link remaining}, and the two
   * cannot be changed apart. `remaining` is the heuristic the queue is ordered
   * on, so a search that gave up one step early while measuring the distance to
   * the cell after it would order the frontier by a figure the goal test
   * disagrees with, and return a route that is not the shortest.
   */
  arrive?: "beside" | "on";
};

/** Which legs may leave the ground. @see PathOptions.drops */
type Drops = NonNullable<PathOptions["drops"]>;

/** Where a route ends. @see PathOptions.arrive */
type Arrival = NonNullable<PathOptions["arrive"]>;

const DEFAULT_ARRIVAL: Arrival = "beside";

const DEFAULT_DROPS: Drops = "never";

/**
 * A stack with nobody in it to leave out.
 *
 * What every cell of a search is, since the one body that would have had a slot
 * to skip is taken off the board before the first step. @see PathStart.self
 */
const NOBODY_IN_THIS_STACK = -1;

/** Steps apart on the plan, ignoring elevation. */
function stepsApart(a: Coord, b: Coord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function sameCell(a: Coord, b: Coord): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

/**
 * A search with no cell anybody pointed at, which is every flood in this file.
 * Named so that the argument reads as the fact it is rather than as a stub.
 */
const NOTHING_ASKED_FOR = () => false;

/**
 * Close enough to have arrived: beside them on their floor, or standing in the
 * goal cell itself. @see PathOptions.arrive
 *
 * `<= 1` rather than `=== 1` so a body somehow sharing a cell with its target
 * is finished rather than searching the world for a cell it is already in.
 *
 * The level has to match in both modes, and for the same reason: standing under
 * somebody is not standing beside them, and the floor below a cell is not that
 * cell.
 */
function arrived(at: Coord, goal: Coord, arrive: Arrival): boolean {
  if (at.z !== goal.z) return false;
  const steps = stepsApart(at, goal);
  return arrive === "on" ? steps === 0 : steps <= 1;
}

/**
 * Steps still owed at best, from here.
 *
 * Plan distance to whichever cell {@link arrived} would accept — the goal
 * itself, or one short of it — and it stays admissible for the same reason
 * `stepsApart` does: every step moves exactly one cell on the plan, whatever it
 * does to elevation, so no route can be shorter than the cells between here and
 * there.
 *
 * Moves with the mode rather than being written once, and the dangerous half is
 * the *over*estimate: the plan distance to the goal itself is one step more than
 * a route that stops beside it owes, and A* handed a figure that is too big
 * returns a route that is not the shortest — as well as pruning legitimate ones
 * against {@link PATH_DETOUR_SLACK}, which is measured in the same figure.
 */
function remaining(at: Coord, goal: Coord, arrive: Arrival): number {
  const steps = stepsApart(at, goal);
  return arrive === "on" ? steps : Math.max(0, steps - 1);
}

/**
 * Where gravity would put a body that stepped off here, or null over a
 * bottomless one.
 *
 * The highest standing surface below the climb band, which is the same surface
 * a fall settles onto — asked here so a route that takes a ledge knows which
 * cell it continues from rather than planning the rest of the way from mid-air.
 */
/**
 * Where a body entering this column from `fromAbs` comes to rest, or null when
 * nothing down there will hold it.
 *
 * Exported because a click into a hole asks exactly this question — see
 * `./walkTo`'s `standingCellOn`. The pointer names whatever is *visible* at the
 * bottom, which is not the same as what a body lands on: a sealed surface under
 * a half-wall is drawn and cannot be stood on, so the fall carries past it. One
 * definition, because a click that aimed somewhere the search would not put the
 * body is a route to a cell nobody ends up in.
 */
export function dropLanding(
  map: MapFile,
  x: number,
  y: number,
  fromAbs: number,
  tileDef: TileDef,
  tilesById: Record<string, TileDef>,
): Coord | null {
  const below = listStandingSurfaces(map, x, y, tilesById)
    .filter((surface) => surface.abs < fromAbs - MAX_CLIMB_HEIGHT)
    .sort((a, b) => b.abs - a.abs);

  for (const surface of below) {
    if (fitsAtElevation(map, x, y, surface.abs, tileDef, tilesById).ok) {
      return { x, y, z: surface.z };
    }
  }
  return null;
}

/**
 * Whether a leg that leaves the ground is an edge, asked of where it lands — or
 * null when no such leg is an edge at all.
 *
 * Built once per search so the three modes are one decision rather than a
 * condition repeated at every ledge, and `"toGoal"` is expressed as the goal
 * test itself rather than as a second opinion about what arriving means. It has
 * to be: a drop landing one cell short under `"beside"`, or onto the floor under
 * the goal cell under `"on"`, is a fall that got somewhere *else*, and the
 * search would carry on walking from where it landed.
 *
 * Null rather than a predicate that always says no, so `"never"` can be
 * answered before the column scan {@link dropLanding} costs. @see neighbours
 */
function dropRule(
  drops: Drops,
  goal: Coord,
  arrive: Arrival,
): ((landing: Coord) => boolean) | null {
  if (drops === "never") return null;
  if (drops === "anywhere") return () => true;
  return (landing) => arrived(landing, goal, arrive);
}

/**
 * What landing in this cell would set off: the status handed over, and whether
 * it sends the body somewhere else.
 *
 * One pass, two answers, each of them "top down and the first wins" — which is
 * `GameSession.statusOnArrival` and `teleportOnArrival`'s own rule read from
 * the other end: an author can bury a pad under a second one and the top of
 * the pile is what fires. They are read together because a route asks both of
 * every cell it accepts, and two passes is two stack lookups for one question.
 *
 * The whole stack rather than the part under the body, because no body has been
 * placed here yet and everything a walker can stand on, it stands on top of.
 */
function firesOnStepAt(
  map: MapFile,
  at: Coord,
  tilesById: Record<string, TileDef>,
): { statusId: string | null; teleports: boolean } {
  const stack = getStack(map, at.x, at.y, at.z);
  let statusId: string | null = null;
  let found = false;
  let teleports = false;

  for (let i = stack.length - 1; i >= 0; i--) {
    const def = tilesById[stack[i]!.tileId];
    if (!def) continue;
    if (!found) {
      const addStatus = resolveAddStatus(def);
      if (addStatus?.trigger === "step") {
        statusId = addStatus.statusId;
        found = true;
      }
    }
    if (!teleports) teleports = resolveTeleportDef(def)?.trigger === "step";
  }

  return { statusId, teleports };
}

/**
 * Would landing in this cell do something to whoever lands there?
 *
 * The question every search in this file asks before calling a cell a way
 * through — see the section on it at the top of the file for what is avoided
 * and why the goal is not. @see firesOnStepAt for what the cell is asked.
 *
 * **A status nothing in the catalogue answers to is not a hazard**, which is
 * the reading `resolveAddStatus` already documents: an id the catalogue does
 * not hold is an effect that does not happen. So a caller with no catalogue to
 * hand — a renderer built before its route finished loading, a test about
 * geometry — routes exactly as it did before this existed, while a portal is
 * still avoided, because a teleport needs no catalogue to be read.
 */
export function unsafeToStepOn(
  map: MapFile,
  at: Coord,
  tilesById: Record<string, TileDef>,
  statusDefs: Record<string, StatusDef>,
): boolean {
  const fires = firesOnStepAt(map, at, tilesById);
  if (fires.teleports) return true;
  return (
    fires.statusId !== null && statusDefs[fires.statusId]?.tone === "bad"
  );
}

/**
 * Which cells a route refuses to pass through, with the one exception folded in.
 *
 * Built once per search rather than asked per node, so the catalogues and the
 * exemption are closed over and {@link neighbours} takes one predicate rather
 * than three more arguments.
 *
 * The exemption is tested first: it is a coordinate comparison against a stack
 * scan, and it is true of at most one cell in the whole search.
 */
function avoidRule(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  statusDefs: Record<string, StatusDef>,
  asked: (cell: Coord) => boolean,
): (cell: Coord) => boolean {
  return (cell) =>
    !asked(cell) && unsafeToStepOn(map, cell, tilesById, statusDefs);
}

/**
 * Every cell one step from `at`, as the board would allow it.
 *
 * `map` is the board with the searcher's own body already off it — see
 * {@link PathStart.self} — so every cell here, the one being stood in included,
 * is measured as it is rather than as somewhere somebody is.
 */
function neighbours(
  map: MapFile,
  at: Coord,
  tileDef: TileDef,
  tilesById: Record<string, TileDef>,
  mayDropTo: ((landing: Coord) => boolean) | null,
  avoid: (cell: Coord) => boolean,
): PathStep[] {
  const fromAbs = standingAbs(
    map,
    at.x,
    at.y,
    at.z,
    NOBODY_IN_THIS_STACK,
    tilesById,
  );
  const out: PathStep[] = [];

  for (const direction of DIRECTIONS) {
    const { dx, dy } = DIR_DELTA[direction];
    const x = at.x + dx;
    const y = at.y + dy;

    // Asked before `canWalk` rather than after it, and the order is the saving:
    // a column scan is the expensive half of a step check, and a ledge nothing
    // is willing to go over is answered here without paying for the other half.
    const grounded =
      surfacesInClimbBand(
        map,
        { x: at.x, y: at.y, abs: fromAbs },
        x,
        y,
        tilesById,
      ).length > 0;
    // Where this leg would have to land to be worth taking, or null when it is
    // not a fall at all or when this search does not take them. One value
    // rather than two, so the question is asked once and answered once.
    const mayFallTo = grounded ? null : mayDropTo;
    if (!grounded && !mayFallTo) continue;

    const check = canWalk(
      map,
      { ...at, stackIndex: NOBODY_IN_THIS_STACK },
      direction,
      tileDef,
      tilesById,
    );
    if (!check.ok) continue;

    // A step the board allows onto nothing at all. `canWalk` says yes so that
    // gravity can pull a body through a drop it could not climb; a route has to
    // decide for itself whether that is a way through, a way down, or neither.
    if (mayFallTo) {
      const landing = dropLanding(map, x, y, fromAbs, tileDef, tilesById);
      if (!landing || !mayFallTo(landing)) continue;
      // Asked of where the fall *lands* rather than of the cell it was stepped
      // off into, because a drop is one edge and what it does to the body is
      // settled where the body stops. @see avoidRule
      if (avoid(landing)) continue;
      out.push({ direction, to: landing });
      continue;
    }

    // Last of the three checks, so a stack scan is paid only for a cell the
    // board has already agreed can be walked into — in a built-up place, the
    // minority of the four directions. @see avoidRule
    if (avoid(check.to)) continue;
    out.push({ direction, to: check.to });
  }

  return out;
}

/** A cell on the frontier, with the leg that reached it. */
type Node = {
  at: Coord;
  /** Steps taken to get here. */
  g: number;
  /** `g` plus what is still owed at best — what the queue is ordered on. */
  f: number;
  /** Where this came from, for walking the route back out. */
  cameFrom: Node | null;
  step: PathStep | null;
};

/**
 * The frontier, cheapest first.
 *
 * A heap rather than a sorted array because the whole point of
 * {@link PATH_MAX_NODES} is that a hard case really does queue hundreds of
 * cells, and a linear scan over those turns a bounded search into a quadratic
 * one at five decisions a second per creature.
 *
 * Ties break towards the node nearest the goal — deeper rather than wider —
 * which is what keeps an open-field route from fanning out across a diamond of
 * equally good cells before it commits to any of them.
 */
class Frontier {
  private heap: Node[] = [];

  /** Nowhere left to look — which is a different answer from having stopped. */
  get empty(): boolean {
    return this.heap.length === 0;
  }

  private before(a: Node, b: Node): boolean {
    return a.f === b.f ? a.g > b.g : a.f < b.f;
  }

  push(node: Node) {
    this.heap.push(node);
    for (let i = this.heap.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (!this.before(this.heap[i]!, this.heap[parent]!)) break;
      [this.heap[i], this.heap[parent]] = [this.heap[parent]!, this.heap[i]!];
      i = parent;
    }
  }

  pop(): Node | null {
    const top = this.heap[0];
    if (top === undefined) return null;

    const last = this.heap.pop()!;
    if (this.heap.length === 0) return top;

    this.heap[0] = last;
    for (let i = 0; ; ) {
      const left = i * 2 + 1;
      const right = left + 1;
      let best = i;
      const heap = this.heap;
      if (left < heap.length && this.before(heap[left]!, heap[best]!)) best = left;
      if (right < heap.length && this.before(heap[right]!, heap[best]!)) best = right;
      if (best === i) break;
      [this.heap[i], this.heap[best]] = [this.heap[best]!, this.heap[i]!];
      i = best;
    }
    return top;
  }
}

/** The legs of a route, in the order they are walked. */
function unwind(node: Node): PathStep[] {
  const steps: PathStep[] = [];
  for (let at: Node | null = node; at?.step; at = at.cameFrom) {
    steps.push(at.step);
  }
  return steps.reverse();
}

/**
 * What an emptied frontier means.
 *
 * Nowhere left to look is only "there is no way there" when everywhere was
 * *offered*: a search that turned candidates away at {@link PATH_DETOUR_SLACK}
 * has not seen the whole board and must not claim to have. @see PathRefusal
 */
function exhausted(pruned: boolean): PathOutcome {
  return { ok: false, why: pruned ? "detour" : "unreachable" };
}

/**
 * A route from `start.at` to somewhere beside `goal` — or into it, on
 * {@link PathOptions.arrive} — or the reason there is not one.
 *
 * The searcher's own body comes off the board first and stays off for the whole
 * search, which is the one place the two facts in {@link PathStart} are used
 * and why they have to be given apart. Off the board rather than skipped by
 * index, because the body obstructs cells it is not the *source* of: a walker
 * mid-step has to be able to route back through the cell it is leaving. It
 * costs one copy-on-write cell edit per search — about 12µs of the 170µs an
 * eight-step route across `app/lib/fixtureTown.ts` takes, measured with `bun`
 * on an M2 Pro.
 *
 * Other bodies count as walls, because `canWalk` counts them as walls — which
 * is right for a route asked afresh every time somebody decides where to go,
 * and would be wrong for one kept. A creature blocked by its own flock this
 * tick is blocked by different cells the next, and the route it is handed says
 * so.
 */
/**
 * How many cells a flee may look at before running with the best it has found.
 *
 * Deliberately well under {@link PATH_MAX_NODES}, and the reason is behaviour
 * rather than cost. A flood of this size reaches about six cells in the open,
 * which is enough to round the corner of a building or find the gap in a fence
 * and nowhere near enough to know the layout of a town. That is the same limit
 * {@link PATH_DETOUR_SLACK} puts on a chase, arrived at from the other side: a
 * creature here is allowed to see what is around it and not allowed to have
 * worked out where the doors are.
 *
 * It is also a *hard* bound in a way the chase's is not. A chase has an
 * admissible heuristic and settles in seven to twenty-five cells; a flood has
 * nothing to prune with and always spends its whole budget, so this number is
 * what a flee costs every time rather than a ceiling it rarely reaches.
 */
export const REFUGE_MAX_NODES = 64;

export type RefugeOptions = {
  /** @see PathOptions.drops */
  drops?: Drops;
  /** Cells to look at before running. @see REFUGE_MAX_NODES */
  maxNodes?: number;
  /**
   * Can the threat see this cell?
   *
   * Optional, and the whole of the difference between an animal that runs and
   * one that hides. Asked only about cells that are already at least as far
   * from the threat as the best found so far — a handful over a whole flood —
   * because a line of sight costs a walk down a column and the answer changes
   * nothing for a cell that is not in the running.
   */
  seenFrom?: (cell: Coord) => boolean;
};

/** A cell worth running to, and why it is the best one so far. */
type Refuge = {
  node: Node;
  /** Steps from the threat, which is what a refuge is mostly judged on. */
  away: number;
  /** Out of the threat's sight, which is how a tie is broken. */
  hidden: boolean;
};

/**
 * Somewhere to run, and the way there — or an empty route for an animal with
 * nowhere better than where it stands.
 *
 * **The other shape of search in this module, and it is inside out from
 * {@link findPath}.** A chase knows where it wants to be and looks for the way
 * there; a flee knows only what it wants to be away from, so there is no goal
 * to aim at and no heuristic to order a frontier by. What it does instead is
 * flood outward from the animal, score every cell it reaches, and hand back the
 * route to the best one — which is why picking the refuge and routing to it are
 * one call rather than two. The came-from tree is already there.
 *
 * ## Fleeing used to be greedy, and this is why it stopped being
 *
 * `step_away_from` scored the four neighbouring cells and took whichever one
 * opened the distance most. That is defeated by any wall: a rabbit backed into
 * a corner has no neighbour that gains anything, gives up, and stands there —
 * and before it gives up it shuffles, because the best of four cells flips
 * between two of them as the threat moves and the animal re-decides from
 * scratch every round.
 *
 * `docs/notes.md` used to argue that this was right, on the grounds that "away"
 * is a direction rather than a place and inventing a goal cell would be the
 * pathfinder deciding where something wants to hide. The argument is sound and
 * the behaviour it produced was worse: an animal that flickers in a corner and
 * quits reads as broken, and one that puts a building between you and it reads
 * as an animal.
 *
 * ## What makes one cell better than another
 *
 * Steps from the threat first, and out of its sight to break a tie. Distance is
 * what fleeing means; sight is what turns a run into hiding, and it is a
 * tie-break rather than a term of its own so that an animal never doubles back
 * towards a threat for the sake of a wall. @see RefugeOptions.seenFrom
 *
 * Ties beyond that go to whichever cell was reached first, which the flood
 * gives for nothing: cells come off the queue in order of how many steps away
 * they are, so the earliest of two equally good refuges is the nearer one. An
 * animal should not run the long way round to somewhere no better.
 *
 * **An empty route means cornered**, on exactly the terms an empty route from
 * `findPath` means arrived: nowhere the animal can reach improves on where it
 * is standing. The caller reads it as a failure and the author's next line gets
 * its turn — which for the deer and the rabbit is the `stuck` that puts them in
 * `cornered`. The difference from before is what that state now means. It used
 * to be reached after two steps of hill-climbing; it is now reached having
 * looked at everywhere within six cells.
 */
export function findRefuge(
  map: MapFile,
  start: PathStart,
  threat: Coord,
  tileDef: TileDef,
  tilesById: Record<string, TileDef>,
  statusDefs: Record<string, StatusDef>,
  opts: RefugeOptions = {},
): PathOutcome {
  const board = removeTileAt(
    map,
    start.self.x,
    start.self.y,
    start.self.z,
    start.self.stackIndex,
  );
  const from = { x: start.at.x, y: start.at.y, z: start.at.z };
  // Nothing is ruled out by where the animal is going, because it is not going
  // anywhere in particular: a drop it is allowed to take is allowed wherever it
  // lands, and one it is not is not an edge. The middle mode `findPath` has is
  // about a goal, and there is no goal here.
  const mayDropTo = (opts.drops ?? DEFAULT_DROPS) === "never" ? null : () => true;
  // Nothing is exempt, on the same grounds: there is no goal here, so there is
  // no cell anybody has pointed at. An animal cornered against a fire is
  // cornered — running into it is not an escape. @see avoidRule
  const avoid = avoidRule(board, tilesById, statusDefs, NOTHING_ASKED_FOR);

  const frontier = new Frontier();
  const best = new Map<string, number>();
  const root: Node = { at: from, g: 0, f: 0, cameFrom: null, step: null };
  frontier.push(root);
  best.set(cellKey(from), 0);

  // Where it already is, which every candidate has to beat. Seeded rather than
  // left null so that "nowhere better" needs no case of its own: the animal
  // stays the best answer and the route back to itself is empty.
  let refuge: Refuge = {
    node: root,
    away: stepsApart(from, threat),
    hidden: opts.seenFrom ? !opts.seenFrom(from) : false,
  };

  for (let expanded = 0; expanded < (opts.maxNodes ?? REFUGE_MAX_NODES); expanded++) {
    const node = frontier.pop();
    if (!node) break;
    if (node.g > (best.get(cellKey(node.at)) ?? Infinity)) continue;

    const away = stepsApart(node.at, threat);
    // Only a cell already in the running is worth asking about sight, which is
    // what keeps the line-of-sight checks to a handful across a whole flood.
    if (away >= refuge.away) {
      const hidden = opts.seenFrom ? !opts.seenFrom(node.at) : false;
      if (away > refuge.away || (hidden && !refuge.hidden)) {
        refuge = { node, away, hidden };
      }
    }

    for (const step of neighbours(
      board,
      node.at,
      tileDef,
      tilesById,
      mayDropTo,
      avoid,
    )) {
      const key = cellKey(step.to);
      const g = node.g + 1;
      if (g >= (best.get(key) ?? Infinity)) continue;
      best.set(key, g);
      // No heuristic: there is nowhere to measure towards, so the queue is
      // ordered on steps taken alone and the flood comes off it in rings.
      frontier.push({ at: step.to, g, f: g, cameFrom: node, step });
    }
  }

  return { ok: true, route: unwind(refuge.node) };
}

export function findPath(
  map: MapFile,
  start: PathStart,
  goal: Coord,
  tileDef: TileDef,
  tilesById: Record<string, TileDef>,
  statusDefs: Record<string, StatusDef>,
  opts: PathOptions = {},
): PathOutcome {
  const board = removeTileAt(
    map,
    start.self.x,
    start.self.y,
    start.self.z,
    start.self.stackIndex,
  );
  const from = { x: start.at.x, y: start.at.y, z: start.at.z };
  const arrive = opts.arrive ?? DEFAULT_ARRIVAL;
  if (arrived(from, goal, arrive)) return { ok: true, route: [] };
  const mayDropTo = dropRule(opts.drops ?? DEFAULT_DROPS, goal, arrive);
  // The cell that was pointed at, and only when a caller pointed at a cell to
  // stand *in*: a route that stops beside its goal never lands on it, so there
  // is nothing for `beside` to exempt. @see avoidRule
  const avoid = avoidRule(board, tilesById, statusDefs, (cell) =>
    arrive === "on" && sameCell(cell, goal),
  );

  const budget = opts.maxNodes ?? PATH_MAX_NODES;
  // How long a route is still a chase. @see PATH_DETOUR_SLACK
  const longest = remaining(from, goal, arrive) + PATH_DETOUR_SLACK;
  const frontier = new Frontier();
  const best = new Map<string, number>();
  /** Whether anything was turned away at `longest`. @see exhausted */
  let pruned = false;

  frontier.push({
    at: from,
    g: 0,
    f: remaining(from, goal, arrive),
    cameFrom: null,
    step: null,
  });
  best.set(cellKey(from), 0);

  for (let expanded = 0; expanded < budget; expanded++) {
    const node = frontier.pop();
    if (!node) return exhausted(pruned);

    // Stale: a cheaper way to this cell was queued after it and has already
    // been expanded. Skipping is what a decrease-key would have done, without
    // a heap that has to find an entry it already gave away.
    if (node.g > (best.get(cellKey(node.at)) ?? Infinity)) continue;

    if (arrived(node.at, goal, arrive)) return { ok: true, route: unwind(node) };

    const legs = neighbours(
      board,
      node.at,
      tileDef,
      tilesById,
      mayDropTo,
      avoid,
    );
    for (const step of legs) {
      const key = cellKey(step.to);
      const g = node.g + 1;
      if (g >= (best.get(key) ?? Infinity)) continue;
      // `f` is the shortest this route could still turn out to be, so a node
      // over the cap cannot lead anywhere under it.
      const f = g + remaining(step.to, goal, arrive);
      if (f > longest) {
        pruned = true;
        continue;
      }
      best.set(key, g);
      frontier.push({ at: step.to, g, f, cameFrom: node, step });
    }
  }

  // The queue decides which of the two limits this was: cells still waiting is
  // the budget stopping a search that had somewhere to go, and an empty one is
  // the board or the detour cap having already answered on the last expansion.
  return frontier.empty ? exhausted(pruned) : { ok: false, why: "budget" };
}
