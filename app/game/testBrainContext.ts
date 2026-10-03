import { vi } from "vitest";
import type { Coord, Direction } from "../lib/types";
import type { BrainContext, WalkGoal, WalkOrderState } from "./brainRuntime";
import { Rng } from "./rng";

function openRoute(self: Coord, at: Coord): Direction | "arrived" | null {
  const dx = at.x - self.x;
  const dy = at.y - self.y;
  if (at.z === self.z && Math.abs(dx) + Math.abs(dy) <= 1) return "arrived";
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "e" : "w";
  return dy > 0 ? "s" : "n";
}

function standingOrder(ctx: BrainContext, goal: WalkGoal): WalkOrderState {
  if (ctx.busy) return "walking";
  const at = goal.of === "cell" ? goal.at : ctx.positionOf(goal.id);
  if (!at) return "blocked";
  const direction = openRoute(ctx.self, at);
  if (direction === null) return "blocked";
  if (direction === "arrived") return "arrived";
  return ctx.step(direction) ? "walking" : "blocked";
}

function runningOrder(ctx: BrainContext, threat: Coord): WalkOrderState {
  if (ctx.busy) return "walking";
  const away = openRoute(threat, ctx.self);
  if (away === null || away === "arrived") return "blocked";
  return ctx.step(away) ? "walking" : "blocked";
}

/**
 * A body on open ground at noon with nobody near: every sense answers
 * nothing, and a walk or a flight takes one step along the straight line
 * between the two cells, through `step`, so a test can watch which way it
 * went.
 */
export function brainContext(overrides: Partial<BrainContext> = {}) {
  const built = {
    busy: false,
    rng: new Rng(1),
    self: { x: 0, y: 0, z: 0 },
    home: null,
    nearestOnTile: () => null,
    nearestThing: () => null,
    thingStillThere: () => false,
    positionOf: () => null,
    wouldDrop: () => false,
    wouldStepIntoHazard: () => false,
    walkTo: (goal: WalkGoal): WalkOrderState => standingOrder(built, goal),
    fleeFrom: (threat: Coord): WalkOrderState => runningOrder(built, threat),
    step: vi.fn(() => true),
    say: vi.fn(),
    noise: vi.fn(),
    canSee: () => true,
    sight: { up: 0, down: 0 },
    heard: () => [],
    heardNoise: () => [],
    talking: () => false,
    inHarm: () => false,
    hurtBy: () => [],
    attack: vi.fn(() => false),
    cast: vi.fn((): "cast" | "casting" | "no" => "no"),
    extract: vi.fn(() => false),
    switchThing: vi.fn(() => false),
    consume: vi.fn(() => false),
    consumeOn: vi.fn(() => false),
    carrying: () => false,
    hasStatus: () => false,
    standOff: () => null,
    health: () => 1,
    minutesOfDay: 12 * 60,
    nameOf: (id: string) => id,
    ...overrides,
  } satisfies BrainContext;
  return built;
}
