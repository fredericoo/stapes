import * as v from "valibot";
import { resolveTransition, type Transition, type TransitionSide } from "./tileTransition";
import type { TileDef } from "./types";

export type ProjectileSide = TransitionSide | "hit";

export const MIN_PROJECTILE_SPEED = 1;
export const MAX_PROJECTILE_SPEED = 1000;

export const DEFAULT_PROJECTILE_SPEED = 20;

export type ProjectileBlock = {
  cellsPerSecond: number;
  hit?: Transition;
};

const projectileSchema = v.object({
  cellsPerSecond: v.pipe(
    v.number(),
    v.minValue(MIN_PROJECTILE_SPEED),
    v.maxValue(MAX_PROJECTILE_SPEED),
  ),
  hit: v.optional(v.unknown()),
});

export function resolveProjectile(def: TileDef | undefined): ProjectileBlock | null {
  if (!def || def.kind !== "projectile") return null;
  const parsed = v.safeParse(projectileSchema, def.interactions?.projectile);
  if (!parsed.success) return null;
  const hit = resolveTransition(parsed.output.hit);
  return {
    cellsPerSecond: parsed.output.cellsPerSecond,
    ...(hit ? { hit } : {}),
  };
}

export function projectileEffect(
  def: TileDef | undefined,
  side: ProjectileSide,
): Transition | undefined {
  if (!resolveProjectile(def)) return undefined;
  if (side === "hit") return resolveProjectile(def)?.hit ?? undefined;
  return def?.transitions?.[side];
}

export function projectileTiles(tiles: readonly TileDef[]): TileDef[] {
  return tiles.filter((tile) => tile.kind === "projectile");
}
