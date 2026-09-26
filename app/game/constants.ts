import { HEIGHT_PER_LEVEL } from "../lib/types";

export const TICK_HZ = 30;

export const TICK_MS = 1000 / TICK_HZ;

export const WALK_DURATION_MS = 200;

export const FALL_MS_PER_LEVEL = 400;

export const FALL_MS_PER_HEIGHT = FALL_MS_PER_LEVEL / HEIGHT_PER_LEVEL;

export const PUSH_STEP_MS = WALK_DURATION_MS;

export const PLAYER_TILE_ID = "player";

export const BRAIN_TICK_MS = WALK_DURATION_MS;

export const BRAIN_ATTENTION_FLOOR_CELLS = 24;

export const BRAIN_DOZE_BUDGET = 24;

export const BRAIN_ROUND_TICKS = Math.max(1, Math.floor(BRAIN_TICK_MS / TICK_MS));

export const BRAIN_TURNS_PER_TICK_MIN = 16;

export const MAX_CLIMB_HEIGHT = HEIGHT_PER_LEVEL / 2;

export const DAMAGE_NUMBER_LIFETIME_MS = 900;

export const NOISE_LIFETIME_MS = 2_000;

/** Must stay below `MIN_ATTACK_TICKS` in `combat.ts`. */
export const STRIKE_DURATION_MS = 150;
