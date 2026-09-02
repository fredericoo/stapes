import {
  canWalk,
  DIR_DELTA,
  listStandingSurfaces,
  standingAbs,
  surfacesInClimbBand,
} from "./movement";
import { cellKey } from "./pressurePlates";
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
 * Giving up reads as no route at all, deliberately. A half-explored search has
 * a best-so-far cell it could walk towards, and following it is how a creature
 * ends up pressed against the wall nearest you having "made progress" — which
 * is the behaviour this module exists to remove.
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

export type PathOptions = {
  /**
   * May a leg of the route leave the ground?
   *
   * Off by default, on the same terms the brain action is: the board lets
   * anybody walk into open air so gravity can pull them through, and whether
   * that is a route or a mistake is the caller's to decide. Allowed, a drop
   * becomes a **one-way edge** — the search resolves where gravity would put
   * the body down and carries on from there, and nothing offers a way back up.
   */
  allowDrops?: boolean;
  /** Cells to give up after taking off the queue. @see PATH_MAX_NODES */
  maxNodes?: number;
};

/** Steps apart on the plan, ignoring elevation. */
function stepsApart(a: Coord, b: Coord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Close enough to have arrived: beside them, on their floor.
 *
 * `<= 1` rather than `=== 1` so a body somehow sharing a cell with its target
 * is finished rather than searching the world for a cell it is already in.
 */
function arrived(at: Coord, goal: Coord): boolean {
  return at.z === goal.z && stepsApart(at, goal) <= 1;
}

/**
 * Steps still owed at best, from here.
 *
 * Plan distance to the cell *beside* the goal, since that is what arriving
 * means — and it stays admissible for the same reason `stepsApart` does: every
 * step moves exactly one cell on the plan, whatever it does to elevation, so no
 * route can be shorter than the cells between here and there.
 */
function remaining(at: Coord, goal: Coord): number {
  return Math.max(0, stepsApart(at, goal) - 1);
}

/**
 * Where gravity would put a body that stepped off here, or null over a
 * bottomless one.
 *
 * The highest standing surface below the climb band, which is the same surface
 * a fall settles onto — asked here so a route that takes a ledge knows which
 * cell it continues from rather than planning the rest of the way from mid-air.
 */
function dropLanding(
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
 * Every cell one step from `at`, as the board would allow it.
 *
 * `stackIndex` is the searcher's own slot in its *starting* cell and only means
 * anything there — a body is not standing in any of the cells further along, so
 * there is nothing to leave out of those stacks.
 */
function neighbours(
  map: MapFile,
  at: Coord,
  stackIndex: number,
  tileDef: TileDef,
  tilesById: Record<string, TileDef>,
  opts: PathOptions,
): PathStep[] {
  const fromAbs = standingAbs(map, at.x, at.y, at.z, stackIndex, tilesById);
  const out: PathStep[] = [];

  for (const direction of DIRECTIONS) {
    const { dx, dy } = DIR_DELTA[direction];
    const x = at.x + dx;
    const y = at.y + dy;

    // Asked before `canWalk` rather than after it, and the order is the saving:
    // a column scan is the expensive half of a step check, and a ledge nothing
    // is willing to go over is answered here without paying for the other half.
    const grounded =
      surfacesInClimbBand(map, x, y, fromAbs, tilesById).length > 0;
    if (!grounded && !opts.allowDrops) continue;

    const check = canWalk(
      map,
      { ...at, stackIndex },
      direction,
      tileDef,
      tilesById,
    );
    if (!check.ok) continue;

    // A step the board allows onto nothing at all. `canWalk` says yes so that
    // gravity can pull a body through a drop it could not climb; a route has to
    // decide for itself whether that is a way through or a way down.
    if (!grounded) {
      const landing = dropLanding(map, x, y, fromAbs, tileDef, tilesById);
      if (landing) out.push({ direction, to: landing });
      continue;
    }

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

  private before(a: Node, b: Node): boolean {
    return a.f === b.f ? a.g > b.g : a.f < b.f;
  }

  push(node: Node) {
    this.heap.push(node);
    for (let i = this.heap.length - 1; i > 0;) {
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
    for (let i = 0; ;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let best = i;
      const heap = this.heap;
      if (left < heap.length && this.before(heap[left]!, heap[best]!))
        best = left;
      if (right < heap.length && this.before(heap[right]!, heap[best]!))
        best = right;
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
 * A route from `from` to somewhere beside `goal`, or null when there is no way
 * there within {@link PATH_MAX_NODES}.
 *
 * An **empty** route is not a failure: it is a body that has already arrived,
 * and telling the two apart is what lets a caller fall through to whatever it
 * does once it is standing next to somebody.
 *
 * Other bodies count as walls, because `canWalk` counts them as walls — which
 * is right for a route asked afresh every time somebody decides where to go,
 * and would be wrong for one kept. A creature blocked by its own flock this
 * tick is blocked by different cells the next, and the route it is handed says
 * so.
 */
export function findPath(
  map: MapFile,
  from: Coord & { stackIndex: number },
  goal: Coord,
  tileDef: TileDef,
  tilesById: Record<string, TileDef>,
  opts: PathOptions = {},
): PathStep[] | null {
  const start = { x: from.x, y: from.y, z: from.z };
  if (arrived(start, goal)) return [];

  const budget = opts.maxNodes ?? PATH_MAX_NODES;
  // How long a route is still a chase. @see PATH_DETOUR_SLACK
  const longest = remaining(start, goal) + PATH_DETOUR_SLACK;
  const frontier = new Frontier();
  const best = new Map<string, number>();

  frontier.push({
    at: start,
    g: 0,
    f: remaining(start, goal),
    cameFrom: null,
    step: null,
  });
  best.set(cellKey(start), 0);

  for (let expanded = 0; expanded < budget; expanded++) {
    const node = frontier.pop();
    if (!node) break;

    // Stale: a cheaper way to this cell was queued after it and has already
    // been expanded. Skipping is what a decrease-key would have done, without
    // a heap that has to find an entry it already gave away.
    if (node.g > (best.get(cellKey(node.at)) ?? Infinity)) continue;

    if (arrived(node.at, goal)) return unwind(node);

    // Only the starting cell holds the searcher's own body, so only it has a
    // stack slot to leave out.
    const stackIndex = node.cameFrom === null ? from.stackIndex : -1;
    const legs = neighbours(map, node.at, stackIndex, tileDef, tilesById, opts);
    for (const step of legs) {
      const key = cellKey(step.to);
      const g = node.g + 1;
      if (g >= (best.get(key) ?? Infinity)) continue;
      // `f` is the shortest this route could still turn out to be, so a node
      // over the cap cannot lead anywhere under it.
      const f = g + remaining(step.to, goal);
      if (f > longest) continue;
      best.set(key, g);
      frontier.push({ at: step.to, g, f, cameFrom: node, step });
    }
  }

  return null;
}
