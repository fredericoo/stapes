import {
  TALK_REACH_CELLS,
  canTalkFrom,
  canTeleportFrom,
  teleportFits,
} from "../../app/game/affordances";
import { canWalk, listStandingSurfaces } from "../../app/game/movement";
import { findPlayers } from "../../app/game/player";
import { resolveSwitch, resolveTeleport } from "../../app/lib/interactions";
import { getStack, listCoords, removeTileAt, replaceStack } from "../../app/lib/mapData";
import { fitsHeightAtElevation } from "../../app/lib/validation";
import { HEIGHT_PER_LEVEL, MAX_LEVEL, MIN_LEVEL, resolveIntangible } from "../../app/lib/types";
import type { Direction, MapFile, TileDef } from "../../app/lib/types";

const DIRECTIONS: Direction[] = ["n", "e", "s", "w"];

export type WalkReport = {
  standableByLevel: Record<string, number>;
  reachedByLevel: Record<string, number>;
  stairsThatClimbNowhere: string[];
  shopkeepersOutOfReach: string[];
};

/**
 * Walks the map from the spawn the way a player gets around it: ordinary steps
 * with the game's own `canWalk`, every door open, and every ladder and portal
 * in a cell reached. What it cannot reach is either shut away on purpose in
 * Tibia (a quest room behind a locked door, the far side of a one-way hole) or
 * a place the translation broke.
 */
export function walkFromSpawn(map: MapFile, tilesById: Record<string, TileDef>): WalkReport {
  const player = tilesById["player"]!;
  let live = map;

  const spawns = findPlayers(live);
  for (const spawn of spawns)
    live = removeTileAt(live, spawn.x, spawn.y, spawn.z, spawn.stackIndex);

  const shopkeepers: { tileId: string; x: number; y: number; z: number; stackIndex: number }[] = [];
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { x, y, stack } of listCoords(live, z)) {
      let changed = false;
      const next = stack.flatMap((placed, stackIndex) => {
        const def = tilesById[placed.tileId];
        if (def?.interactions?.dialog) {
          shopkeepers.push({ tileId: placed.tileId, x, y, z, stackIndex });
        }
        if (def?.kind === "battler" || def?.interactions?.dialog) {
          changed = true;
          return [];
        }
        const target = def && tilesById[resolveSwitch(def)?.targetTileId ?? ""];
        if (!target || !resolveIntangible(target)) return [placed];
        changed = true;
        return [{ ...placed, tileId: target.id }];
      });
      if (changed) live = replaceStack(live, x, y, z, next);
    }
  }

  const feetOn = (x: number, y: number, z: number) =>
    listStandingSurfaces(live, x, y, tilesById).find((s) => s.z === z)?.abs;
  const settle = (x: number, y: number, feetAbs: number) => {
    const surfaces = listStandingSurfaces(live, x, y, tilesById);
    return (
      surfaces.find((s) => s.abs === feetAbs) ??
      surfaces.filter((s) => s.abs < feetAbs).sort((a, b) => b.abs - a.abs)[0] ??
      null
    );
  };

  const seen = new Set<string>();
  const queue: { x: number; y: number; z: number }[] = [];
  const arrive = (x: number, y: number, z: number) => {
    const landed = settle(x, y, feetOn(x, y, z) ?? z * HEIGHT_PER_LEVEL);
    if (!landed) return;
    const key = `${x},${y},${landed.z}`;
    if (seen.has(key)) return;
    seen.add(key);
    queue.push({ x, y, z: landed.z });
  };
  for (const spawn of spawns) arrive(spawn.x, spawn.y, spawn.z);

  for (let head = 0; head < queue.length; head++) {
    const from = queue[head]!;
    const stack = getStack(live, from.x, from.y, from.z);
    for (const direction of DIRECTIONS) {
      const step = canWalk(
        live,
        { ...from, stackIndex: stack.length },
        direction,
        player,
        tilesById,
      );
      if (step.ok) arrive(step.to.x, step.to.y, step.to.z);
    }
    stack.forEach((placed, stackIndex) => {
      const teleport = resolveTeleport(placed, tilesById[placed.tileId], from);
      if (!teleport) return;
      const usable =
        teleport.trigger === "step"
          ? teleportFits(live, tilesById, player, teleport.to)
          : canTeleportFrom(live, tilesById, from, { ...from, stackIndex }, player);
      if (usable) arrive(teleport.to.x, teleport.to.y, teleport.to.z);
    });
  }

  /**
   * A shopkeeper stands behind a counter in Tibia and is talked to across it,
   * so what has to be reachable is a cell within talking distance, not theirs.
   */
  const canBeTalkedTo = (keeper: (typeof shopkeepers)[number]) => {
    const reach = Math.floor(TALK_REACH_CELLS);
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const x = keeper.x + dx;
        const y = keeper.y + dy;
        if (!seen.has(`${x},${y},${keeper.z}`)) continue;
        const self = { x, y, z: keeper.z, stackIndex: getStack(map, x, y, keeper.z).length };
        if (canTalkFrom(map, tilesById, self, keeper)) return true;
      }
    }
    return false;
  };

  const report: WalkReport = {
    standableByLevel: {},
    reachedByLevel: {},
    stairsThatClimbNowhere: [],
    shopkeepersOutOfReach: shopkeepers
      .filter((keeper) => !canBeTalkedTo(keeper))
      .map(({ tileId, x, y, z }) => `${tileId} at ${x},${y} L${z}`),
  };
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { x, y, stack } of listCoords(live, z)) {
      const standable = listStandingSurfaces(live, x, y, tilesById).some(
        (s) =>
          s.z === z &&
          fitsHeightAtElevation(live, x, y, s.abs, player.height, tilesById, {
            throughPlayers: true,
          }).ok,
      );
      if (standable) {
        report.standableByLevel[z] = (report.standableByLevel[z] ?? 0) + 1;
        if (seen.has(`${x},${y},${z}`))
          report.reachedByLevel[z] = (report.reachedByLevel[z] ?? 0) + 1;
      }
      if (!stack.some((p) => p.tileId === "ramp" || p.tileId === "stone-stairs")) continue;
      const onStairs = z * HEIGHT_PER_LEVEL + 2;
      const climbs = DIRECTIONS.some((direction) => {
        const step = canWalk(
          live,
          { x, y, z, stackIndex: stack.length },
          direction,
          player,
          tilesById,
        );
        return step.ok && (feetOn(step.to.x, step.to.y, step.to.z) ?? -Infinity) > onStairs;
      });
      if (!climbs) report.stairsThatClimbNowhere.push(`${x},${y} L${z}`);
    }
  }
  return report;
}
