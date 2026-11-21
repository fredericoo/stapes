import {
  resolveDepotDef,
  resolveEmit,
  resolveReceive,
  resolveRewardDef,
  resolveTeleportDef,
} from "../lib/interactions";
import { resolveContainer, resolveItem } from "../lib/item";
import type { TileDef } from "../lib/types";

export function isWired(def: TileDef): boolean {
  return resolveEmit(def) != null || resolveReceive(def) != null;
}

export function isGiver(def: TileDef): boolean {
  return resolveRewardDef(def) != null;
}

export function isDepot(def: TileDef): boolean {
  return resolveDepotDef(def) != null;
}

export function needsDestination(def: TileDef): boolean {
  return resolveTeleportDef(def)?.destination.kind === "absolute";
}

export function isGiveable(def: TileDef): boolean {
  return resolveItem(def) != null && resolveContainer(def) == null;
}

export function holdsCount(def: TileDef): number | null {
  return resolveContainer(def)?.size ?? null;
}

export function isStowable(def: TileDef): boolean {
  return resolveItem(def) != null && resolveContainer(def) == null;
}
