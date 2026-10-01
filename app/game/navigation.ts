import { canTeleportFrom, teleportFits, type ObjectRef } from "./affordances";
import {
  canWalk,
  DIR_DELTA,
  listStandingSurfaces,
  standingAbs,
  surfacesInClimbBand,
} from "./movement";
import { dropLanding, legCost, unsafeToStepOn } from "./pathfinding";
import { cellKey } from "./pressurePlates";
import { getStack, replaceStack } from "../lib/mapData";
import { resolveSwitch, resolveTeleport } from "../lib/interactions";
import type { StatusDef } from "../lib/status";
import { DIRECTIONS, HEIGHT_PER_LEVEL, resolveIntangible } from "../lib/types";
import type { Coord, Direction, MapFile, PlacedTile, TileDef } from "../lib/types";

export const NAVIGATION_MAX_NODES = 40_000;

/**
 * A drop cannot be walked back up, so a route pays extra for one and takes it
 * only when the way round is longer than this many steps.
 */
export const DROP_COST = 4;

export const USE_COST = 2;

export type NavLeg =
  | {
      readonly kind: "walk";
      readonly direction: Direction;
      readonly to: Coord;
      readonly drop: boolean;
      readonly opens: ObjectRef | null;
    }
  | { readonly kind: "use"; readonly ref: ObjectRef; readonly to: Coord };

export type NavWorld = {
  readonly board: MapFile;
  readonly traveller: TileDef;
  readonly tilesById: Record<string, TileDef>;
  readonly statusDefs: Record<string, StatusDef>;
  readonly who?: string;
  /** Extra cost for arriving at a cell, for places a caller would rather avoid. */
  readonly penalty?: (cell: Coord) => number;
};

export type NavGoal = {
  reached(cell: Coord): boolean;
  /**
   * A lower bound on the cost from `cell` to the goal, or 0 when there is no
   * place to measure from. Ladders and portals move a body for less than the
   * distance they cover, so only plan distance is safe to count.
   */
  estimate(cell: Coord): number;
};

const NOBODY_IN_THIS_STACK = -1;

export function cellGoal(at: Coord, arrive: "on" | "beside" = "on"): NavGoal {
  return {
    reached: (cell) =>
      cell.z === at.z &&
      Math.abs(cell.x - at.x) + Math.abs(cell.y - at.y) <= (arrive === "on" ? 0 : 1),
    estimate: (cell) =>
      Math.max(0, Math.abs(cell.x - at.x) + Math.abs(cell.y - at.y) - (arrive === "on" ? 0 : 1)),
  };
}

export function levelGoal(z: number): NavGoal {
  return { reached: (cell) => cell.z >= z, estimate: () => 0 };
}

/**
 * Where a body put at `at` comes to rest: the surface at the top of that
 * level's band if there is one, else the highest one below it.
 */
export function settleAt(world: NavWorld, at: Coord): Coord | null {
  const surfaces = listStandingSurfaces(world.board, at.x, at.y, world.tilesById);
  const ceiling = (at.z + 1) * HEIGHT_PER_LEVEL;
  let best: { abs: number; z: number } | null = null;
  for (const surface of surfaces) {
    if (surface.abs >= ceiling) continue;
    if (!best || surface.abs > best.abs) best = surface;
  }
  return best ? { x: at.x, y: at.y, z: best.z } : null;
}

function stepTeleportFrom(world: NavWorld, at: Coord): Coord | null {
  const stack = getStack(world.board, at.x, at.y, at.z);
  for (const placed of stack) {
    const teleport = resolveTeleport(placed, world.tilesById[placed.tileId], at);
    if (teleport?.trigger !== "step") continue;
    if (!teleportFits(world.board, world.tilesById, world.traveller, teleport.to)) return null;
    return teleport.to;
  }
  return null;
}

function hurtsOnArrival(world: NavWorld, at: Coord): boolean {
  if (stepTeleportFrom(world, at)) return false;
  return unsafeToStepOn(world.board, at, world.tilesById, world.statusDefs, world.who);
}

export function opensToIntangible(
  placed: PlacedTile,
  tilesById: Record<string, TileDef>,
): string | null {
  const def = tilesById[placed.tileId];
  const target = def && resolveSwitch(def)?.targetTileId;
  const opened = target ? tilesById[target] : undefined;
  return opened && resolveIntangible(opened) ? opened.id : null;
}

/**
 * A closed door is a wall until somebody presses it, and whoever is standing
 * beside it can. The board is opened for the one question and nowhere else.
 */
function walkThroughDoor(
  world: NavWorld,
  at: Coord,
  direction: Direction,
): { to: Coord; opens: ObjectRef; board: MapFile } | null {
  const { dx, dy } = DIR_DELTA[direction];
  const x = at.x + dx;
  const y = at.y + dy;
  for (const z of [at.z, at.z + 1]) {
    const stack = getStack(world.board, x, y, z);
    for (let stackIndex = 0; stackIndex < stack.length; stackIndex++) {
      const openId = opensToIntangible(stack[stackIndex]!, world.tilesById);
      if (!openId) continue;
      const next = stack.map((p, i) => (i === stackIndex ? { ...p, tileId: openId } : p));
      const board = replaceStack(world.board, x, y, z, next);
      const check = canWalk(
        board,
        { ...at, stackIndex: NOBODY_IN_THIS_STACK },
        direction,
        world.traveller,
        world.tilesById,
      );
      if (check.ok) return { to: check.to, opens: { x, y, z, stackIndex }, board };
    }
  }
  return null;
}

function walkLegs(world: NavWorld, at: Coord): NavLeg[] {
  const { board, tilesById, traveller } = world;
  const fromAbs = standingAbs(board, at.x, at.y, at.z, NOBODY_IN_THIS_STACK, tilesById);
  const out: NavLeg[] = [];

  for (const direction of DIRECTIONS) {
    const { dx, dy } = DIR_DELTA[direction];
    const x = at.x + dx;
    const y = at.y + dy;
    const check = canWalk(
      board,
      { ...at, stackIndex: NOBODY_IN_THIS_STACK },
      direction,
      traveller,
      tilesById,
    );
    let opens: ObjectRef | null = null;
    let to: Coord;
    let through = board;
    if (check.ok) {
      to = check.to;
    } else {
      const door = walkThroughDoor(world, at, direction);
      if (!door) continue;
      to = door.to;
      opens = door.opens;
      through = door.board;
    }

    const grounded =
      surfacesInClimbBand(through, { x: at.x, y: at.y, abs: fromAbs }, x, y, tilesById).length > 0;
    if (!grounded) {
      const landing = dropLanding(through, x, y, fromAbs, traveller, tilesById);
      if (!landing) continue;
      to = landing;
    }
    if (hurtsOnArrival(world, to)) continue;
    const ported = stepTeleportFrom(world, to);
    const landed = ported ? settleAt(world, ported) : to;
    if (!landed) continue;
    out.push({ kind: "walk", direction, to: landed, drop: !grounded, opens });
  }
  return out;
}

/**
 * A ladder is pressed while standing over it, a portal with a trigger of
 * `interact` from beside it; `canTeleportFrom` tells them apart, so every stack
 * within one step and one level is offered to it.
 */
function useLegs(world: NavWorld, at: Coord): NavLeg[] {
  const out: NavLeg[] = [];
  const cells: Array<{ x: number; y: number }> = [{ x: at.x, y: at.y }];
  for (const direction of DIRECTIONS) {
    const { dx, dy } = DIR_DELTA[direction];
    cells.push({ x: at.x + dx, y: at.y + dy });
  }
  for (const { x, y } of cells) {
    for (const z of [at.z - 1, at.z, at.z + 1]) {
      const stack = getStack(world.board, x, y, z);
      for (let stackIndex = 0; stackIndex < stack.length; stackIndex++) {
        const placed = stack[stackIndex]!;
        const ref = { x, y, z, stackIndex };
        const teleport = resolveTeleport(placed, world.tilesById[placed.tileId], ref);
        if (!teleport || teleport.trigger === "step") continue;
        if (!canTeleportFrom(world.board, world.tilesById, at, ref, world.traveller)) continue;
        const to = settleAt(world, teleport.to);
        if (to) out.push({ kind: "use", ref, to });
      }
    }
  }
  return out;
}

export function navigationLegs(world: NavWorld, at: Coord): NavLeg[] {
  return [...walkLegs(world, at), ...useLegs(world, at)];
}

function costOf(world: NavWorld, from: Coord, leg: NavLeg): number {
  if (leg.kind === "use") return USE_COST + (world.penalty?.(leg.to) ?? 0);
  const walk = legCost(world.board, from, world.tilesById);
  const extra = world.penalty?.(leg.to) ?? 0;
  return walk + (leg.drop ? DROP_COST : 0) + (leg.opens ? USE_COST : 0) + extra;
}

type Node = {
  at: Coord;
  g: number;
  f: number;
  cameFrom: Node | null;
  leg: NavLeg | null;
};

class Frontier {
  private heap: Node[] = [];

  push(node: Node) {
    const heap = this.heap;
    heap.push(node);
    for (let i = heap.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;
      if (heap[parent]!.f <= heap[i]!.f) break;
      [heap[i], heap[parent]] = [heap[parent]!, heap[i]!];
      i = parent;
    }
  }

  pop(): Node | null {
    const heap = this.heap;
    const top = heap[0];
    if (top === undefined) return null;
    const last = heap.pop()!;
    if (heap.length === 0) return top;
    heap[0] = last;
    for (let i = 0; ;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let best = i;
      if (left < heap.length && heap[left]!.f < heap[best]!.f) best = left;
      if (right < heap.length && heap[right]!.f < heap[best]!.f) best = right;
      if (best === i) break;
      [heap[i], heap[best]] = [heap[best]!, heap[i]!];
      i = best;
    }
    return top;
  }
}

export type NavOutcome =
  | { ok: true; legs: NavLeg[] }
  | { ok: false; why: "unreachable" | "budget"; explored: number };

export function planRoute(
  world: NavWorld,
  from: Coord,
  goal: NavGoal,
  maxNodes = NAVIGATION_MAX_NODES,
): NavOutcome {
  const frontier = new Frontier();
  const best = new Map<string, number>();
  frontier.push({ at: from, g: 0, f: goal.estimate(from), cameFrom: null, leg: null });
  best.set(cellKey(from), 0);

  for (let expanded = 0; expanded < maxNodes; expanded++) {
    const node = frontier.pop();
    if (!node) return { ok: false, why: "unreachable", explored: expanded };
    if (node.g > (best.get(cellKey(node.at)) ?? Infinity)) continue;
    if (goal.reached(node.at)) return { ok: true, legs: unwind(node) };

    for (const leg of navigationLegs(world, node.at)) {
      const key = cellKey(leg.to);
      const g = node.g + costOf(world, node.at, leg);
      if (g >= (best.get(key) ?? Infinity)) continue;
      best.set(key, g);
      frontier.push({ at: leg.to, g, f: g + goal.estimate(leg.to), cameFrom: node, leg });
    }
  }
  return { ok: false, why: "budget", explored: maxNodes };
}

function unwind(node: Node): NavLeg[] {
  const legs: NavLeg[] = [];
  for (let at: Node | null = node; at?.leg; at = at.cameFrom) legs.push(at.leg);
  return legs.reverse();
}

/**
 * Every standing cell reachable from `starts`, keyed by `cellKey`. The walk
 * `carve:caves --verify` checks the underground with.
 */
export function reachableCells(world: NavWorld, starts: readonly Coord[]): Map<string, Coord> {
  const seen = new Map<string, Coord>();
  const queue: Coord[] = [];
  for (const start of starts) {
    const key = cellKey(start);
    if (seen.has(key)) continue;
    seen.set(key, start);
    queue.push(start);
  }
  for (let head = 0; head < queue.length; head++) {
    for (const leg of navigationLegs(world, queue[head]!)) {
      const key = cellKey(leg.to);
      if (seen.has(key)) continue;
      seen.set(key, leg.to);
      queue.push(leg.to);
    }
  }
  return seen;
}
