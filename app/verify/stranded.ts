import { findPlayers } from "../game/player";
import { navigationLegs } from "../game/navigation";
import { listCoords, presentLevels, replaceStack } from "../lib/mapData";
import type { StatusDef } from "../lib/status";
import type { Coord, MapFile, TileDef } from "../lib/types";
import { PLAYER_TILE_ID } from "../game/constants";

export type StrandedWay = "walk" | "drop" | "use";

export type StrandedEntrance = { from: Coord; to: Coord; by: StrandedWay };

export type StrandedRegion = { cells: Coord[]; entrances: StrandedEntrance[] };

export type StrandedReport = {
  ok: boolean;
  start: Coord | null;
  reachable: number;
  stranded: number;
  regions: StrandedRegion[];
};

const keyOf = (c: Coord) => `${c.x},${c.y},${c.z}`;

/**
 * Bodies come off the board first. A creature standing in a doorway is in the
 * way for a moment, not for good, and counting it would call the room behind
 * it out of reach.
 */
export function withoutBodies(map: MapFile, tilesById: Record<string, TileDef>): MapFile {
  let board = map;
  for (const z of presentLevels(map)) {
    for (const { x, y, stack } of listCoords(map, z)) {
      const kept = stack.filter((placed) => tilesById[placed.tileId]?.kind !== "battler");
      if (kept.length !== stack.length) board = replaceStack(board, x, y, z, kept);
    }
  }
  return board;
}

/**
 * Every cell a player can get to from `start` and not get back from. Getting
 * there counts every leg a body can take, the drop off a ledge included;
 * getting back is the same legs, so a ledge with no way up again strands
 * whoever steps off it. Regions are the stranded cells that reach each other,
 * each with the legs that lead into it from ground a player can leave.
 */
export function findStranded(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  statusDefs: Record<string, StatusDef>,
  start: Coord | null = findPlayers(map)[0] ?? null,
): StrandedReport {
  const traveller = tilesById[PLAYER_TILE_ID];
  if (!start || !traveller) {
    return { ok: false, start: null, reachable: 0, stranded: 0, regions: [] };
  }
  const origin = { x: start.x, y: start.y, z: start.z };
  const world = { board: withoutBodies(map, tilesById), traveller, tilesById, statusDefs };

  const cells: Coord[] = [origin];
  const index = new Map<string, number>([[keyOf(origin), 0]]);
  const legs: Array<Array<{ to: number; by: StrandedWay }>> = [];
  const arrivals: number[][] = [[]];
  for (let at = 0; at < cells.length; at++) {
    const out: Array<{ to: number; by: StrandedWay }> = [];
    for (const leg of navigationLegs(world, cells[at]!)) {
      const key = keyOf(leg.to);
      let to = index.get(key);
      if (to === undefined) {
        to = cells.length;
        index.set(key, to);
        cells.push(leg.to);
        arrivals.push([]);
      }
      out.push({ to, by: leg.kind === "use" ? "use" : leg.drop ? "drop" : "walk" });
      arrivals[to]!.push(at);
    }
    legs.push(out);
  }

  const returns = new Uint8Array(cells.length);
  returns[0] = 1;
  const queue = [0];
  for (let head = 0; head < queue.length; head++) {
    for (const from of arrivals[queue[head]!]!) {
      if (returns[from]) continue;
      returns[from] = 1;
      queue.push(from);
    }
  }

  const regionOf = new Int32Array(cells.length).fill(-1);
  const regions: StrandedRegion[] = [];
  for (let first = 0; first < cells.length; first++) {
    if (returns[first] || regionOf[first] !== -1) continue;
    const id = regions.length;
    const members = [first];
    regionOf[first] = id;
    for (let head = 0; head < members.length; head++) {
      const at = members[head]!;
      const beside = [...legs[at]!.map((leg) => leg.to), ...arrivals[at]!];
      for (const next of beside) {
        if (returns[next] || regionOf[next] !== -1) continue;
        regionOf[next] = id;
        members.push(next);
      }
    }
    regions.push({ cells: members.map((i) => cells[i]!), entrances: [] });
  }
  for (let from = 0; from < cells.length; from++) {
    if (!returns[from]) continue;
    for (const leg of legs[from]!) {
      if (returns[leg.to]) continue;
      regions[regionOf[leg.to]!]!.entrances.push({
        from: cells[from]!,
        to: cells[leg.to]!,
        by: leg.by,
      });
    }
  }
  regions.sort((a, b) => b.cells.length - a.cells.length);

  const stranded = regions.reduce((n, region) => n + region.cells.length, 0);
  return { ok: stranded === 0, start: origin, reachable: cells.length, stranded, regions };
}
