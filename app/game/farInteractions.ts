import { isInteractive } from "../lib/interactions";
import { getStack } from "../lib/mapData";
import type { StatusDef } from "../lib/status";
import type { Coord, MapFile, TileDef } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import { INTERACT_LEVEL_SLACK, TALK_REACH_CELLS, type ObjectRef } from "./affordances";
import type { ActorSnapshot } from "./GameSession";
import {
  rankedInteractionsAt,
  refOptionsFrom,
  type InteractionOption,
  type RefContext,
} from "./interactionOptions";
import { reachableCells, type ReachedCell } from "./pathfinding";
import { cellKey } from "./pressurePlates";

export const FAR_MAX_STEPS = 6;

/**
 * Comfortably above the cells `FAR_MAX_STEPS` can reach in open ground, so it
 * only cuts a flood short in a maze of stairs and levels.
 */
const FAR_FLOOD_MAX_NODES = 256;

export const FAR_SUBJECT_LIMIT = 8;

const OBJECT_REACH_CELLS = 1;

const TALK_WINDOW_CELLS = Math.ceil(TALK_REACH_CELLS);

export type FarScan = {
  map: MapFile;
  tilesById: Record<string, TileDef>;
  statusDefs: Record<string, StatusDef>;
  self: ActorSnapshot;
  from: Coord;
  def: TileDef;
  actors: readonly ActorSnapshot[];
  context: RefContext;
  near: readonly InteractionOption[];
  shown: (ref: ObjectRef) => boolean;
};

type Subject = { cost: number; options: InteractionOption[] };

/**
 * What things a short walk away would offer once you got there, nearest walk
 * first. Each thing is asked with the player stood in every reached cell
 * around it, so the rules are the near list's own rather than a second copy.
 * A body offers only Talk, as from the pointer: its other verbs already reach.
 */
export function listFarOptions(scan: FarScan): InteractionOption[] {
  const reached = reachableCells(
    scan.map,
    { at: scan.from, self: scan.self, who: scan.self.id },
    scan.def,
    scan.tilesById,
    scan.statusDefs,
    { maxCost: FAR_MAX_STEPS, maxNodes: FAR_FLOOD_MAX_NODES },
  );
  const nearIds = new Set(scan.near.map((option) => option.id));
  const bodies = new Set(scan.actors.map(refKey));
  const subjects: Subject[] = [];

  for (const ref of candidates(scan, reached)) {
    if (!scan.shown(ref)) continue;
    const body = bodies.has(refKey(ref));
    const found = optionsAround(scan, reached, ref, body ? TALK_WINDOW_CELLS : OBJECT_REACH_CELLS);
    const options = rankedInteractionsAt(found.options, ref).filter(
      (option) => !nearIds.has(option.id) && (!body || option.action === "talk"),
    );
    if (options.length > 0) subjects.push({ cost: found.cost, options });
  }

  return subjects
    .sort((a, b) => a.cost - b.cost)
    .slice(0, FAR_SUBJECT_LIMIT)
    .flatMap((subject) => subject.options.map((option) => ({ ...option, far: true })));
}

function candidates(scan: FarScan, reached: Map<string, ReachedCell>): ObjectRef[] {
  const out = new Map<string, ObjectRef>();
  for (const actor of scan.actors) {
    if (actor.id === scan.self.id) continue;
    const ref = { x: actor.x, y: actor.y, z: actor.z, stackIndex: actor.stackIndex };
    out.set(refKey(ref), ref);
  }
  for (const { at } of reached.values()) {
    for (const cell of cellsAround(at, OBJECT_REACH_CELLS)) {
      for (const ref of interactiveRefsIn(scan, cell)) out.set(refKey(ref), ref);
    }
  }
  return [...out.values()];
}

function interactiveRefsIn(scan: FarScan, cell: Coord): ObjectRef[] {
  return getStack(scan.map, cell.x, cell.y, cell.z).flatMap((placed, stackIndex) => {
    const def = scan.tilesById[placed.tileId];
    return def && isInteractive(def) ? [{ ...cell, stackIndex }] : [];
  });
}

function optionsAround(
  scan: FarScan,
  reached: Map<string, ReachedCell>,
  ref: ObjectRef,
  span: number,
): Subject {
  const byId = new Map<string, InteractionOption>();
  let cost = Infinity;
  for (const cell of cellsAround(ref, span)) {
    const stand = reached.get(cellKey(cell));
    if (!stand) continue;
    const offered = optionsStandingAt(scan, stand.at, ref);
    if (offered.length > 0) cost = Math.min(cost, stand.cost);
    for (const option of offered) if (!byId.has(option.id)) byId.set(option.id, option);
  }
  return { cost, options: [...byId.values()] };
}

function optionsStandingAt(scan: FarScan, cell: Coord, ref: ObjectRef): InteractionOption[] {
  const { self } = scan;
  const standsStill = cell.x === self.x && cell.y === self.y && cell.z === self.z;
  const stackIndex = standsStill
    ? self.stackIndex
    : getStack(scan.map, cell.x, cell.y, cell.z).length;
  return refOptionsFrom(
    scan.map,
    scan.tilesById,
    { ...self, x: cell.x, y: cell.y, z: cell.z, stackIndex },
    scan.actors,
    ref,
    scan.context,
  );
}

function cellsAround(at: Coord, span: number): Coord[] {
  const out: Coord[] = [];
  const zMin = Math.max(MIN_LEVEL, at.z - INTERACT_LEVEL_SLACK);
  const zMax = Math.min(MAX_LEVEL, at.z + INTERACT_LEVEL_SLACK);
  for (let dx = -span; dx <= span; dx++) {
    for (let dy = -span; dy <= span; dy++) {
      for (let z = zMin; z <= zMax; z++) out.push({ x: at.x + dx, y: at.y + dy, z });
    }
  }
  return out;
}

function refKey(ref: ObjectRef): string {
  return `${ref.x},${ref.y},${ref.z},${ref.stackIndex}`;
}
