import * as v from "valibot";
import type { TileDef } from "./types";
import { HEIGHT_PER_LEVEL } from "./types";

/**
 * How far up a pushed object can step. Descent is deliberately absent —
 * going down is physics: any step down is legal, and whether the object then
 * falls is already answered by {@link TileDef.affectedByGravity}.
 */
export type ClimbAbility = "none" | "half" | "full";

export const CLIMB_ABILITIES: ClimbAbility[] = ["none", "half", "full"];

/** Max upward step in absolute height units, per ability. */
export const CLIMB_HEIGHT_UNITS: Record<ClimbAbility, number> = {
  none: 0,
  half: HEIGHT_PER_LEVEL / 2,
  full: HEIGHT_PER_LEVEL,
};

/**
 * The player shoves this object one cell directly away from themselves. There
 * is no distance to author: a push is always exactly one cell, which is what
 * makes it legible without a pointer — you stand somewhere and the direction
 * follows from where you are.
 */
export type PushInteraction = {
  /** Max upward step. Descent is unconstrained — gravity resolves it. */
  climb: ClimbAbility;
  /** When non-empty, the object may only come to rest on these tile ids. */
  moveOnTileIds: string[];
};

/**
 * Replace this placement with another tile when the player activates it.
 * Author the reverse on the target for a toggle (e.g. door open ↔ closed).
 */
export type SwitchInteraction = {
  targetTileId: string;
};

/** Ways the player can interact with a placed object. Grows over time. */
export type TileInteractions = {
  push?: PushInteraction;
  switch?: SwitchInteraction;
};

export const DEFAULT_SWITCH: SwitchInteraction = {
  targetTileId: "",
};

export const DEFAULT_PUSH: PushInteraction = {
  climb: "half",
  moveOnTileIds: [],
};

const pushSchema = v.object({
  climb: v.picklist(CLIMB_ABILITIES),
  moveOnTileIds: v.array(v.string()),
});

/**
 * Parsed push config per tile def. `data/tiles.json` is hand-editable, so the
 * shape is validated rather than trusted; a malformed block reads as "not
 * pushable" instead of throwing mid-frame.
 *
 * Memoised on def identity — {@link isInteractive} runs over every candidate
 * tile on each pointer move.
 */
const pushCache = new WeakMap<TileDef, PushInteraction | null>();

export function resolvePush(def: TileDef): PushInteraction | null {
  const cached = pushCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.push;
  const parsed = raw == null ? null : v.safeParse(pushSchema, raw);
  const push = parsed?.success ? parsed.output : null;
  pushCache.set(def, push);
  return push;
}

const switchSchema = v.object({
  targetTileId: v.pipe(v.string(), v.minLength(1)),
});

const switchCache = new WeakMap<TileDef, SwitchInteraction | null>();

/**
 * Parsed switch config per tile def. Same trust model as {@link resolvePush}:
 * malformed or empty target → not switchable.
 */
export function resolveSwitch(def: TileDef): SwitchInteraction | null {
  const cached = switchCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.switch;
  const parsed = raw == null ? null : v.safeParse(switchSchema, raw);
  const sw = parsed?.success ? parsed.output : null;
  switchCache.set(def, sw);
  return sw;
}

/**
 * Kinds of interaction a tile offers, in the order the single interact button
 * tries them. Switch comes first: it is an explicit authored swap, whereas a
 * push is the fallback "just shove it" behaviour.
 */
export type InteractionKind = "switch" | "push";

/** Every interaction enabled on this tile, in a stable order. */
export function interactionKinds(def: TileDef): InteractionKind[] {
  const kinds: InteractionKind[] = [];
  if (resolveSwitch(def)) kinds.push("switch");
  if (resolvePush(def)) kinds.push("push");
  return kinds;
}

/** Whether the player can do anything at all with this tile. */
export function isInteractive(def: TileDef): boolean {
  return interactionKinds(def).length > 0;
}

/** Persist interactions; omit the field entirely when nothing is enabled. */
export function interactionsForSave(
  interactions: TileInteractions | undefined,
): TileInteractions | undefined {
  const push = interactions?.push;
  const sw = interactions?.switch;
  const savedPush = push
    ? {
        climb: push.climb,
        moveOnTileIds: [...push.moveOnTileIds].sort(),
      }
    : undefined;
  const savedSwitch =
    sw?.targetTileId.trim() ? { targetTileId: sw.targetTileId.trim() } : undefined;
  if (!savedPush && !savedSwitch) return undefined;
  return {
    ...(savedPush ? { push: savedPush } : {}),
    ...(savedSwitch ? { switch: savedSwitch } : {}),
  };
}
