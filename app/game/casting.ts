import type { NaturalSpell } from "../lib/battler";
import type { ArcaneStoneItem } from "../lib/item";
import { reachOf, resolveStone } from "../lib/item";
import {
  type Masteries,
  meetsRequirements,
  requirementCoverage,
  REQUIREMENTS_MET,
} from "../lib/mastery";
import { getStack, isBodyPlacement } from "../lib/mapData";
import type { AnchoredSprite, Coord, Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import { canPlace } from "../lib/validation";
import { canReach } from "./combat";
import type { ReachPoint } from "./distance";
import type { Equipment } from "./equipment";
import { canWalk } from "./movement";
import type { Progress } from "./progress";

export const CAST_SQUARES = ["weapon", "offhand", "charm"] as const;

export type CastSquare = (typeof CAST_SQUARES)[number];

const _everyCastSquareIsWorn: readonly (keyof Equipment)[] = CAST_SQUARES;

export type CastSlot = { from: "square"; square: CastSquare } | { from: "natural"; name: string };

export const squareSlot = (square: CastSquare): CastSlot => ({
  from: "square",
  square,
});

export const naturalSlot = (name: string): CastSlot => ({
  from: "natural",
  name,
});

export function sameSlot(a: CastSlot, b: CastSlot): boolean {
  if (a.from === "square") {
    return b.from === "square" && a.square === b.square;
  }
  return b.from === "natural" && a.name === b.name;
}

export type CastRefusal =
  | "empty"
  | "incapacitated"
  | "underway"
  | "casting"
  | "cooling"
  | "mastery"
  | "noTarget"
  | "outOfRange"
  | "blocked"
  | "peaceful";

export type Castability = { ok: true } | { ok: false; reason: CastRefusal };

const MS_PER_SECOND = 1000;

export const COOLDOWN_STEP_MS = 1000;

const CASTABLE: Castability = { ok: true };

const refused = (reason: CastRefusal): Castability => ({ ok: false, reason });

export type CastPoint = ReachPoint & {
  z: number;
  stackIndex: number;
};

export type CasterPoint = CastPoint & {
  facing: Direction;
  tileId: string;
};

export type CastProgress = Progress & {
  slot: CastSlot;
  targetId?: string;
};

export type CastContext = {
  map: MapFile;
  tilesById: Record<string, TileDef>;
  equipment: Equipment;
  masteries: Masteries;
  caster: CasterPoint;
  casting: CastProgress | null;
  spells: readonly NaturalSpell[];
  spellCooldownsMs: Readonly<Record<string, number>>;
  target: CastPoint | null;
  mayHarmTarget?: boolean;
  incapacitated?: boolean;
};

export function castability(context: CastContext, slot: CastSlot): Castability {
  const stone = spellIn(context, slot);
  if (!stone) return refused("empty");

  if (context.incapacitated) return refused("incapacitated");

  if (context.casting) {
    return refused(sameSlot(context.casting.slot, slot) ? "underway" : "casting");
  }

  if (cooldownOf(context, slot) > 0) return refused("cooling");

  if (!meetsRequirements(context.masteries, stone.requirements)) {
    return refused("mastery");
  }

  return reachability(context, stone);
}

export function spellIn(context: CastContext, slot: CastSlot): ArcaneStoneItem | null {
  if (slot.from === "square") return stoneInSquare(context, slot.square);
  return context.spells.find((spell) => spell.name === slot.name) ?? null;
}

function cooldownOf(context: CastContext, slot: CastSlot): number {
  if (slot.from === "natural") return context.spellCooldownsMs[slot.name] ?? 0;
  return context.equipment[slot.square]?.cooldownMs ?? 0;
}

function harmsOnLanding(stone: ArcaneStoneItem): boolean {
  const effect = stone.effect;
  return effect.kind === "bolt" && effect.on === "target" && (effect.damage ?? 0) > 0;
}

function reachability(context: CastContext, stone: ArcaneStoneItem): Castability {
  if (!needsTarget(stone)) return CASTABLE;

  const target = context.target;
  if (!target && stone.effect.kind !== "conjure") return refused("noTarget");

  if (target && !canReach(context.map, context.tilesById, context.caster, target, reachOf(stone))) {
    return refused("outOfRange");
  }

  if (target && harmsOnLanding(stone) && context.mayHarmTarget === false) {
    return refused("peaceful");
  }

  if (stone.effect.kind === "conjure" && !conjureLanding(context, stone.effect.tileId)) {
    return refused("blocked");
  }
  return CASTABLE;
}

export type ConjureLanding = {
  at: Coord;
  under?: number;
};

export function conjureLanding(context: CastContext, tileId: string): ConjureLanding | null {
  const def = context.tilesById[tileId];
  if (!def) return null;

  const target = context.target;
  const landing: ConjureLanding | null = target
    ? { at: { x: target.x, y: target.y, z: target.z }, under: target.stackIndex }
    : cellInFront(context);
  if (!landing) return null;

  const { at } = landing;
  return canPlace(context.map, at.x, at.y, at.z, def, context.tilesById).ok ? landing : null;
}

function cellInFront(context: CastContext): ConjureLanding | null {
  const { caster, map, tilesById } = context;
  const body = tilesById[caster.tileId];
  if (!body) return null;
  const step = canWalk(map, caster, caster.facing, body, tilesById);
  if (!step.ok) return null;
  const { to } = step;
  const under = lowestBodyIn(getStack(map, to.x, to.y, to.z), tilesById);
  return under === undefined ? { at: to } : { at: to, under };
}

function lowestBodyIn(
  stack: readonly PlacedTile[],
  tilesById: Record<string, TileDef>,
): number | undefined {
  for (let i = 0; i < stack.length; i++) {
    const placed = stack[i];
    if (placed && isBodyPlacement(placed, tilesById)) return i;
  }
  return undefined;
}

export function needsTarget(stone: Pick<ArcaneStoneItem, "effect">): boolean {
  if (stone.effect.kind === "conjure") return true;
  return stone.effect.on === "target";
}

export function castDurationMs(stone: ArcaneStoneItem, masteries: Masteries): number {
  const authored = stone.castTimeMs ?? 0;
  if (authored <= 0) return 0;
  const coverage = requirementCoverage(masteries, stone.requirements);
  const share = Math.min(REQUIREMENTS_MET, REQUIREMENTS_MET - (coverage - REQUIREMENTS_MET));
  return Math.max(0, Math.round(authored * share));
}

function stoneInSquare(context: CastContext, square: CastSquare): ArcaneStoneItem | null {
  const held = context.equipment[square];
  if (!held) return null;
  const def = context.tilesById[held.tileId];
  return def ? resolveStone(def) : null;
}

export type SpellButton = {
  slot: CastSlot;
  key: string;
  tileId: string | null;
  icon: AnchoredSprite | null;
  name: string;
  cooldownMs: number;
  cooldownTotalMs: number;
  castTimeMs: number;
  castability: Castability;
};

export function castableSpells(context: CastContext): SpellButton[] {
  const buttons: SpellButton[] = [];
  for (const square of CAST_SQUARES) {
    const instance = context.equipment[square];
    if (!instance) continue;
    const def = context.tilesById[instance.tileId];
    const stone = def ? resolveStone(def) : null;
    if (!stone) continue;
    if (!meetsRequirements(context.masteries, stone.requirements)) continue;

    const slot = squareSlot(square);
    buttons.push({
      slot,
      key: instance.id,
      tileId: instance.tileId,
      icon: null,
      name: instance.inscription?.trim() || def?.name || instance.tileId,
      cooldownMs: instance.cooldownMs ?? 0,
      cooldownTotalMs: stone.cooldownMs,
      castTimeMs: castDurationMs(stone, context.masteries),
      castability: castability(context, slot),
    });
  }

  for (const spell of context.spells) {
    if (!meetsRequirements(context.masteries, spell.requirements)) continue;
    const slot = naturalSlot(spell.name);
    buttons.push({
      slot,
      key: spell.name,
      tileId: null,
      icon: spell.icon ?? null,
      name: spell.name,
      cooldownMs: context.spellCooldownsMs[spell.name] ?? 0,
      cooldownTotalMs: spell.cooldownMs,
      castTimeMs: castDurationMs(spell, context.masteries),
      castability: castability(context, slot),
    });
  }
  return buttons;
}

export function spellReading(buttons: readonly SpellButton[]): string {
  if (buttons.length === 0) return "";
  return buttons
    .map((button) => {
      const refusal = button.castability.ok ? "" : button.castability.reason;
      const seconds = Math.ceil(button.cooldownMs / MS_PER_SECOND);
      return `${button.key}:${seconds}:${button.castTimeMs}:${refusal}`;
    })
    .join("|");
}

export const CAST_REFUSAL_NOTES: Record<CastRefusal, string> = {
  empty: "nothing there",
  incapacitated: "you cannot act right now",
  underway: "casting, press again to stop",
  casting: "already casting",
  cooling: "still cooling",
  mastery: "not learnt yet",
  noTarget: "nothing targeted",
  outOfRange: "out of range",
  blocked: "nowhere for it to land",
  peaceful: "they are not in the fighting",
};

export type SpellPress = "cast" | "stop";

export function spellPress(castability: Castability): SpellPress | null {
  if (castability.ok) return "cast";
  if (castability.reason === "noTarget") return "cast";
  if (castability.reason === "underway") return "stop";
  return null;
}

export function coolingNotice(name: string): string {
  return `The ${name} is still cooling. It cannot be moved until it is ready.`;
}
