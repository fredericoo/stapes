import {
  absoluteStandingElevation,
  appendTile,
  getStack,
} from "../lib/mapData";
import type { Coord, Direction, MapFile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, MIN_LEVEL } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import {
  FALL_MS_PER_HEIGHT,
  MAX_CLIMB_HEIGHT,
  PLAYER_TILE_ID,
  TICK_MS,
  WALK_DURATION_MS,
} from "./constants";
import { cellForFeetAbs, findLandingAbs, isSupported } from "./gravity";
import {
  moveEntity,
  placeEntityOnSurface,
  removeEntity,
  setEntityDirection,
} from "./mapMutations";
import { canWalk, sceneryStack, standingAbs } from "./movement";
import { playerDirection, requireSinglePlayer } from "./player";

export type WalkState = {
  from: Coord;
  to: Coord;
  direction: Direction;
  elapsedMs: number;
};

export type FallState = {
  feetAbs: number;
  landingAbs: number;
  elapsedMs: number;
};

export type GameInput = {
  /** Held movement directions; latest pressed wins when several are held. */
  directions: Direction[];
};

export type GameSnapshot = {
  map: MapFile;
  player: Coord & { stackIndex: number; direction: Direction };
  walk: WalkState | null;
  fall: FallState | null;
  walkProgress: number;
  fallProgress: number;
};

/**
 * Authoritative play session. Mutates an in-memory map; no DOM / renderer.
 */
export class GameSession {
  private map: MapFile;
  private readonly tilesById: Record<string, TileDef>;
  private input: GameInput = { directions: [] };
  private walk: WalkState | null = null;
  private fall: FallState | null = null;
  private accumulatorMs = 0;

  constructor(map: MapFile, tiles: TileDef[]) {
    this.map = structuredClone(map);
    this.tilesById = tilesByIdFromList(tiles);
    requireSinglePlayer(this.map);
  }

  setInput(input: GameInput) {
    this.input = input;
  }

  /** Advance by real-time `dtMs`, running fixed ticks. */
  update(dtMs: number) {
    this.accumulatorMs += dtMs;
    const maxCatchUp = TICK_MS * 10;
    if (this.accumulatorMs > maxCatchUp) this.accumulatorMs = maxCatchUp;

    while (this.accumulatorMs >= TICK_MS) {
      this.accumulatorMs -= TICK_MS;
      this.tick(TICK_MS);
    }
  }

  /** Single fixed tick. */
  tick(tickMs: number = TICK_MS) {
    if (this.fall) {
      this.tickFall(tickMs);
      return;
    }

    if (this.walk) {
      this.walk.elapsedMs += tickMs;
      if (this.walk.elapsedMs >= WALK_DURATION_MS) {
        this.commitWalk();
      } else {
        return;
      }
    }

    this.maybeStartFall();
    if (this.fall) return;

    this.maybeStartWalk();
  }

  getSnapshot(): GameSnapshot {
    const loc = requireSinglePlayer(this.map);
    // Include leftover accumulator so 60fps+ renders interpolate between 30Hz ticks.
    const visualExtra = this.accumulatorMs;
    return {
      map: this.map,
      player: {
        x: loc.x,
        y: loc.y,
        z: loc.z,
        stackIndex: loc.stackIndex,
        direction: playerDirection(loc),
      },
      walk: this.walk,
      fall: this.fall,
      walkProgress: this.walk
        ? Math.min(1, (this.walk.elapsedMs + visualExtra) / WALK_DURATION_MS)
        : 0,
      fallProgress: this.fall
        ? Math.min(1, (this.fall.elapsedMs + visualExtra) / FALL_MS_PER_HEIGHT)
        : 0,
    };
  }

  getMap(): MapFile {
    return this.map;
  }

  private playerDef(): TileDef {
    const def = this.tilesById[PLAYER_TILE_ID];
    if (!def) throw new Error(`Missing tile def "${PLAYER_TILE_ID}"`);
    return def;
  }

  private commitWalk() {
    const w = this.walk;
    if (!w) return;
    const loc = requireSinglePlayer(this.map);
    this.map = moveEntity(
      this.map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      w.to,
      w.direction,
      this.tilesById,
    );
    this.walk = null;
  }

  private maybeStartWalk() {
    const dirs = this.input.directions;
    if (dirs.length === 0) return;

    const loc = requireSinglePlayer(this.map);
    const def = this.playerDef();

    for (let i = dirs.length - 1; i >= 0; i--) {
      const direction = dirs[i]!;
      const check = canWalk(
        this.map,
        {
          x: loc.x,
          y: loc.y,
          z: loc.z,
          stackIndex: loc.stackIndex,
        },
        direction,
        def,
        this.tilesById,
      );

      this.map = setEntityDirection(
        this.map,
        loc.x,
        loc.y,
        loc.z,
        loc.stackIndex,
        direction,
      );

      if (!check.ok) continue;

      this.walk = {
        from: { x: loc.x, y: loc.y, z: loc.z },
        to: check.to,
        direction,
        elapsedMs: 0,
      };
      return;
    }
  }

  private maybeStartFall() {
    const def = this.playerDef();
    if (!def.affectedByGravity) return;

    const loc = requireSinglePlayer(this.map);
    if (
      isSupported(
        this.map,
        loc.x,
        loc.y,
        loc.z,
        loc.stackIndex,
        this.tilesById,
      )
    ) {
      return;
    }

    const feetAbs = standingAbs(
      this.map,
      loc.x,
      loc.y,
      loc.z,
      loc.stackIndex,
      this.tilesById,
    );
    const landing = findLandingAbs(
      this.map,
      loc.x,
      loc.y,
      feetAbs,
      this.tilesById,
      { z: loc.z, stackIndex: loc.stackIndex },
    );
    if (landing == null || landing >= feetAbs) return;

    // Drops within climb height are step-downs (same as same-level height
    // change) — snap onto the surface instead of playing a fall.
    if (feetAbs - landing <= MAX_CLIMB_HEIGHT) {
      this.land(landing);
      return;
    }

    this.fall = {
      feetAbs,
      landingAbs: landing,
      elapsedMs: 0,
    };
  }

  private tickFall(tickMs: number) {
    if (!this.fall) return;
    this.fall.elapsedMs += tickMs;

    while (this.fall && this.fall.elapsedMs >= FALL_MS_PER_HEIGHT) {
      this.fall.elapsedMs -= FALL_MS_PER_HEIGHT;
      this.stepFallOneHeight();
    }
  }

  private stepFallOneHeight() {
    if (!this.fall) return;

    const nextFeet = this.fall.feetAbs - 1;
    if (nextFeet <= this.fall.landingAbs) {
      this.land(this.fall.landingAbs);
      return;
    }

    this.fall.feetAbs = nextFeet;
    this.relocatePlayerToFeet(nextFeet);
  }

  private land(landingAbs: number) {
    this.fall = null;
    const loc = requireSinglePlayer(this.map);
    const { z: targetZ } = cellForFeetAbs(landingAbs);
    const placed = { ...loc.placed };

    let next = removeEntity(this.map, loc.x, loc.y, loc.z, loc.stackIndex);

    // Prefer attaching onto scenery whose top matches the landing.
    for (const zTry of [targetZ, targetZ - 1, loc.z]) {
      if (zTry < MIN_LEVEL) continue;
      const stack = getStack(next, loc.x, loc.y, zTry);
      if (stack.length === 0) continue;
      const top = absoluteStandingElevation(zTry, stack, this.tilesById);
      if (top === landingAbs) {
        this.map = placeEntityOnSurface(
          next,
          loc.x,
          loc.y,
          zTry,
          placed,
          this.tilesById,
        );
        return;
      }
    }

    // Floor formed by a full level below targetZ.
    const floorAbs = targetZ * HEIGHT_PER_LEVEL;
    if (landingAbs === floorAbs) {
      this.map = appendTile(next, loc.x, loc.y, targetZ, placed);
      return;
    }

    this.map = appendTile(next, loc.x, loc.y, targetZ, placed);
  }

  private relocatePlayerToFeet(feetAbs: number) {
    const loc = requireSinglePlayer(this.map);
    const { z: newZ } = cellForFeetAbs(feetAbs);
    if (newZ === loc.z) return;

    const placed = { ...loc.placed };
    let next = removeEntity(this.map, loc.x, loc.y, loc.z, loc.stackIndex);

    const destStack = getStack(next, loc.x, loc.y, newZ);
    const destTop = absoluteStandingElevation(newZ, destStack, this.tilesById);
    if (destStack.length > 0 && destTop === feetAbs) {
      next = placeEntityOnSurface(
        next,
        loc.x,
        loc.y,
        newZ,
        placed,
        this.tilesById,
      );
    } else {
      next = appendTile(next, loc.x, loc.y, newZ, placed);
    }
    this.map = next;
  }
}
