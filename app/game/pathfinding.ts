import {
  canWalk,
  DIR_DELTA,
  findLandingAbs,
  groundWalkSpeedPercent,
  listStandingSurfaces,
  standingAbs,
  surfacesInClimbBand,
  wadesAt,
} from "./movement";
import { cellKey } from "./pressurePlates";
import { getStack, removeTileAt } from "../lib/mapData";
import { clampWalkSpeedPercent } from "../lib/walkSpeed";
import { resolveAddStatus, resolveTeleportDef } from "../lib/interactions";
import { sparesStander } from "./conjured";
import type { StatusDef } from "../lib/status";
import { fitsAtElevation } from "../lib/validation";
import type { Coord, Direction, MapFile, TileDef } from "../lib/types";
import { DIRECTIONS } from "../lib/types";

export const PATH_MAX_NODES = 128;

export const PATH_DETOUR_SLACK = 16;

export type PathStep = { direction: Direction; to: Coord };

export type PathStart = {
  at: Coord;
  self: Coord & { stackIndex: number };
  who?: string;
};

export type PathRefusal = "unreachable" | "detour" | "budget";

export type PathOutcome = { ok: true; route: PathStep[] } | { ok: false; why: PathRefusal };

export type PathOptions = {
  drops?: "never" | "toGoal" | "anywhere";
  maxNodes?: number;
  arrive?: "beside" | "on";
  avoidWade?: boolean;
};

type Drops = NonNullable<PathOptions["drops"]>;

type Arrival = NonNullable<PathOptions["arrive"]>;

const DEFAULT_ARRIVAL: Arrival = "beside";

const DEFAULT_DROPS: Drops = "never";

const NOBODY_IN_THIS_STACK = -1;

function stepsApart(a: Coord, b: Coord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function sameCell(a: Coord, b: Coord): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

const NOTHING_ASKED_FOR = () => false;

function arrived(at: Coord, goal: Coord, arrive: Arrival): boolean {
  if (at.z !== goal.z) return false;
  const steps = stepsApart(at, goal);
  return arrive === "on" ? steps === 0 : steps <= 1;
}

function remaining(at: Coord, goal: Coord, arrive: Arrival): number {
  const steps = stepsApart(at, goal);
  return arrive === "on" ? steps : Math.max(0, steps - 1);
}

export function dropLanding(
  map: MapFile,
  x: number,
  y: number,
  fromAbs: number,
  tileDef: TileDef,
  tilesById: Record<string, TileDef>,
): Coord | null {
  const landingAbs = findLandingAbs(map, x, y, fromAbs + 1, tilesById);
  if (landingAbs == null) return null;
  const surface = listStandingSurfaces(map, x, y, tilesById).find((s) => s.abs === landingAbs);
  if (!surface) return null;
  if (!fitsAtElevation(map, x, y, surface.abs, tileDef, tilesById).ok) return null;
  return { x, y, z: surface.z };
}

function dropRule(
  drops: Drops,
  goal: Coord,
  arrive: Arrival,
): ((landing: Coord) => boolean) | null {
  if (drops === "never") return null;
  if (drops === "anywhere") return () => true;
  return (landing) => arrived(landing, goal, arrive);
}

function firesOnStepAt(
  map: MapFile,
  at: Coord,
  tilesById: Record<string, TileDef>,
  statusDefs: Record<string, StatusDef>,
  who: string | undefined,
): { statusId: string | null; teleports: boolean } {
  const stack = getStack(map, at.x, at.y, at.z);
  let statusId: string | null = null;
  let found = false;
  let teleports = false;

  for (let i = stack.length - 1; i >= 0; i--) {
    const placed = stack[i]!;
    const def = tilesById[placed.tileId];
    if (!def) continue;
    if (!found) {
      const addStatus = resolveAddStatus(def);
      if (addStatus?.trigger === "step") {
        if (!sparesStander(placed, statusDefs[addStatus.statusId], who)) {
          statusId = addStatus.statusId;
          found = true;
        }
      }
    }
    if (!teleports) teleports = resolveTeleportDef(def)?.trigger === "step";
  }

  return { statusId, teleports };
}

export function unsafeToStepOn(
  map: MapFile,
  at: Coord,
  tilesById: Record<string, TileDef>,
  statusDefs: Record<string, StatusDef>,
  who?: string,
): boolean {
  const fires = firesOnStepAt(map, at, tilesById, statusDefs, who);
  if (fires.teleports) return true;
  return fires.statusId !== null && statusDefs[fires.statusId]?.tone === "bad";
}

export function wadesIn(map: MapFile, cell: Coord, tilesById: Record<string, TileDef>): boolean {
  return wadesAt(map, { ...cell, stackIndex: NOBODY_IN_THIS_STACK }, tilesById);
}

function keepsDry(
  map: MapFile,
  from: Coord,
  avoidWade: boolean | undefined,
  tilesById: Record<string, TileDef>,
): boolean {
  return avoidWade === true && !wadesIn(map, from, tilesById);
}

function avoidRule(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  statusDefs: Record<string, StatusDef>,
  who: string | undefined,
  avoidWade: boolean,
  asked: (cell: Coord) => boolean,
): (cell: Coord) => boolean {
  return (cell) =>
    !asked(cell) &&
    (unsafeToStepOn(map, cell, tilesById, statusDefs, who) ||
      (avoidWade && wadesIn(map, cell, tilesById)));
}

export function legCost(map: MapFile, from: Coord, tilesById: Record<string, TileDef>): number {
  const percent = groundWalkSpeedPercent(
    map,
    { ...from, stackIndex: NOBODY_IN_THIS_STACK },
    tilesById,
  );
  return Math.max(1, 1 / (1 + clampWalkSpeedPercent(percent) / 100));
}

function neighbours(
  map: MapFile,
  at: Coord,
  tileDef: TileDef,
  tilesById: Record<string, TileDef>,
  mayDropTo: ((landing: Coord) => boolean) | null,
  avoid: (cell: Coord) => boolean,
): PathStep[] {
  const fromAbs = standingAbs(map, at.x, at.y, at.z, NOBODY_IN_THIS_STACK, tilesById);
  const out: PathStep[] = [];

  for (const direction of DIRECTIONS) {
    const { dx, dy } = DIR_DELTA[direction];
    const x = at.x + dx;
    const y = at.y + dy;

    const grounded =
      surfacesInClimbBand(map, { x: at.x, y: at.y, abs: fromAbs }, x, y, tilesById).length > 0;
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

    if (mayFallTo) {
      const landing = dropLanding(map, x, y, fromAbs, tileDef, tilesById);
      if (!landing || !mayFallTo(landing)) continue;
      if (avoid(landing)) continue;
      out.push({ direction, to: landing });
      continue;
    }

    if (avoid(check.to)) continue;
    out.push({ direction, to: check.to });
  }

  return out;
}

type Node = {
  at: Coord;
  g: number;
  f: number;
  cameFrom: Node | null;
  step: PathStep | null;
};

class Frontier {
  private heap: Node[] = [];

  get empty(): boolean {
    return this.heap.length === 0;
  }

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
      if (left < heap.length && this.before(heap[left]!, heap[best]!)) best = left;
      if (right < heap.length && this.before(heap[right]!, heap[best]!)) best = right;
      if (best === i) break;
      [this.heap[i], this.heap[best]] = [this.heap[best]!, this.heap[i]!];
      i = best;
    }
    return top;
  }
}

function unwind(node: Node): PathStep[] {
  const steps: PathStep[] = [];
  for (let at: Node | null = node; at?.step; at = at.cameFrom) {
    steps.push(at.step);
  }
  return steps.reverse();
}

function exhausted(pruned: boolean): PathOutcome {
  return { ok: false, why: pruned ? "detour" : "unreachable" };
}

export const REFUGE_MAX_NODES = 64;

export type RefugeOptions = {
  drops?: Drops;
  maxNodes?: number;
  seenFrom?: (cell: Coord) => boolean;
  avoidWade?: boolean;
};

type Refuge = {
  node: Node;
  away: number;
  hidden: boolean;
};

export function findRefuge(
  map: MapFile,
  start: PathStart,
  threat: Coord,
  tileDef: TileDef,
  tilesById: Record<string, TileDef>,
  statusDefs: Record<string, StatusDef>,
  opts: RefugeOptions = {},
): PathOutcome {
  const board = removeTileAt(map, start.self.x, start.self.y, start.self.z, start.self.stackIndex);
  const from = { x: start.at.x, y: start.at.y, z: start.at.z };
  const mayDropTo = (opts.drops ?? DEFAULT_DROPS) === "never" ? null : () => true;
  const avoid = avoidRule(
    board,
    tilesById,
    statusDefs,
    start.who,
    keepsDry(board, from, opts.avoidWade, tilesById),
    NOTHING_ASKED_FOR,
  );

  const frontier = new Frontier();
  const best = new Map<string, number>();
  const root: Node = { at: from, g: 0, f: 0, cameFrom: null, step: null };
  frontier.push(root);
  best.set(cellKey(from), 0);

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
    if (away >= refuge.away) {
      const hidden = opts.seenFrom ? !opts.seenFrom(node.at) : false;
      if (away > refuge.away || (hidden && !refuge.hidden)) {
        refuge = { node, away, hidden };
      }
    }

    const cost = legCost(board, node.at, tilesById);
    for (const step of neighbours(board, node.at, tileDef, tilesById, mayDropTo, avoid)) {
      const key = cellKey(step.to);
      const g = node.g + cost;
      if (g >= (best.get(key) ?? Infinity)) continue;
      best.set(key, g);
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
  const board = removeTileAt(map, start.self.x, start.self.y, start.self.z, start.self.stackIndex);
  const from = { x: start.at.x, y: start.at.y, z: start.at.z };
  const arrive = opts.arrive ?? DEFAULT_ARRIVAL;
  if (arrived(from, goal, arrive)) return { ok: true, route: [] };
  const mayDropTo = dropRule(opts.drops ?? DEFAULT_DROPS, goal, arrive);
  const avoid = avoidRule(
    board,
    tilesById,
    statusDefs,
    start.who,
    keepsDry(board, from, opts.avoidWade, tilesById),
    (cell) => arrive === "on" && sameCell(cell, goal),
  );

  const budget = opts.maxNodes ?? PATH_MAX_NODES;
  const longest = remaining(from, goal, arrive) + PATH_DETOUR_SLACK;
  const frontier = new Frontier();
  const best = new Map<string, number>();
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

    if (node.g > (best.get(cellKey(node.at)) ?? Infinity)) continue;

    if (arrived(node.at, goal, arrive)) return { ok: true, route: unwind(node) };

    const legs = neighbours(board, node.at, tileDef, tilesById, mayDropTo, avoid);
    const cost = legs.length > 0 ? legCost(board, node.at, tilesById) : 0;
    for (const step of legs) {
      const key = cellKey(step.to);
      const g = node.g + cost;
      if (g >= (best.get(key) ?? Infinity)) continue;
      const f = g + remaining(step.to, goal, arrive);
      if (f > longest) {
        pruned = true;
        continue;
      }
      best.set(key, g);
      frontier.push({ at: step.to, g, f, cameFrom: node, step });
    }
  }

  return frontier.empty ? exhausted(pruned) : { ok: false, why: "budget" };
}
