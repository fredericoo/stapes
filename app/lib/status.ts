import * as v from "valibot";
import { constantFormula, type Formula, parseFormula } from "./formula";
import { NO_VFX, resolveStatusVfx, type StatusVfx, statusVfxSchema } from "./statusVfx";
import { type CellRect, defaultBase, type AnchoredSprite } from "./types";
import { MAX_WALK_SPEED_PERCENT, MIN_WALK_SPEED_PERCENT } from "./walkSpeed";

export type StatusTone = "good" | "bad";

export const STATUS_TONES: StatusTone[] = ["good", "bad"];

export type StatusModifiers = {
  damage?: Formula;
  def?: Formula;
  accuracy?: Formula;
  flee?: Formula;
  spd?: Formula;
  maxHp?: Formula;
};

export const MODIFIER_KEYS = [
  "damage",
  "def",
  "accuracy",
  "flee",
  "spd",
  "maxHp",
] as const satisfies ReadonlyArray<keyof StatusModifiers>;

export type StatusDef = {
  id: string;
  name: string;
  description: string;
  tone: StatusTone;
  icon?: AnchoredSprite;
  fromMs: number;
  toMs: number;
  stacks: boolean;
  maxMs: number;
  everyMs: Formula;
  effects: { hp?: Formula };
  modifiers: StatusModifiers;
  walkSpeedPercent: number;
  incapacitates: boolean;
  endsOnDamage: boolean;
  vfx: StatusVfx;
};

export const MAX_STATUS_DESCRIPTION_LENGTH = 80;

export const MAX_STATUS_DURATION_MS = 60 * 60 * 1000;

export const DEFAULT_STATUS_SOURCE = {
  id: "",
  name: "",
  description: "",
  tone: "good" as StatusTone,
  icon: { tilesetId: "", rect: { x: 0, y: 0, w: 1, h: 1 }, base: { x: 0, y: 0 } },
  fromMs: 10_000,
  toMs: 30_000,
  stacks: false,
  maxMs: MAX_STATUS_DURATION_MS,
  everyMs: 1_000,
  effects: {},
  modifiers: {},
  walkSpeedPercent: 0,
  incapacitates: false,
  endsOnDamage: false,
  vfx: { tint: null, particles: null, light: null, taperMs: 0 },
};

const iconSchema = v.object({
  tilesetId: v.string(),
  rect: v.object({
    x: v.pipe(v.number(), v.integer(), v.minValue(0)),
    y: v.pipe(v.number(), v.integer(), v.minValue(0)),
    w: v.pipe(v.number(), v.integer(), v.minValue(1)),
    h: v.pipe(v.number(), v.integer(), v.minValue(1)),
  }),
  base: v.optional(
    v.object({
      x: v.pipe(v.number(), v.integer(), v.minValue(0)),
      y: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
  ),
});

const durationMs = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(MAX_STATUS_DURATION_MS),
);

const statusSourceSchema = v.pipe(
  v.object({
    id: v.pipe(v.string(), v.trim(), v.minLength(1)),
    name: v.pipe(v.string(), v.trim(), v.minLength(1)),
    description: v.pipe(
      v.string(),
      v.trim(),
      v.minLength(1),
      v.maxLength(MAX_STATUS_DESCRIPTION_LENGTH),
    ),
    tone: v.picklist(STATUS_TONES),
    icon: v.optional(iconSchema),
    fromMs: durationMs,
    toMs: durationMs,
    stacks: v.optional(v.boolean(), false),
    maxMs: v.optional(durationMs, MAX_STATUS_DURATION_MS),
    everyMs: v.optional(v.union([durationMs, v.string()]), 0),
    effects: v.optional(v.object({ hp: v.optional(v.string()) }), () => ({})),
    modifiers: v.optional(
      v.object(
        Object.fromEntries(MODIFIER_KEYS.map((key) => [key, v.optional(v.string())])) as Record<
          (typeof MODIFIER_KEYS)[number],
          v.OptionalSchema<v.StringSchema<undefined>, undefined>
        >,
      ),
      () => ({}),
    ),
    walkSpeedPercent: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(MIN_WALK_SPEED_PERCENT),
        v.maxValue(MAX_WALK_SPEED_PERCENT),
      ),
      0,
    ),
    incapacitates: v.optional(v.boolean(), false),
    endsOnDamage: v.optional(v.boolean(), false),
    vfx: v.optional(statusVfxSchema, () => ({
      tint: null,
      particles: null,
      light: null,
      taperMs: 0,
    })),
  }),
  v.check((raw) => raw.toMs >= raw.fromMs, "duration range is inverted"),
);

export type StatusSource = v.InferOutput<typeof statusSourceSchema>;

function compileStatus(raw: StatusSource): StatusDef | null {
  const effects: StatusDef["effects"] = {};
  if (raw.effects.hp !== undefined) {
    const hp = parseFormula(raw.effects.hp);
    if (!hp) return null;
    effects.hp = hp;
  }

  const everyMs =
    typeof raw.everyMs === "number" ? constantFormula(raw.everyMs) : parseFormula(raw.everyMs);
  if (!everyMs) return null;

  const modifiers: StatusModifiers = {};
  for (const key of MODIFIER_KEYS) {
    const source = raw.modifiers[key];
    if (source === undefined) continue;
    const formula = parseFormula(source);
    if (!formula) return null;
    modifiers[key] = formula;
  }

  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    tone: raw.tone,
    icon: completeSprite(raw.icon) ?? undefined,
    fromMs: raw.fromMs,
    toMs: raw.toMs,
    stacks: raw.stacks,
    maxMs: raw.maxMs,
    everyMs,
    effects,
    modifiers,
    walkSpeedPercent: raw.walkSpeedPercent,
    incapacitates: raw.incapacitates,
    endsOnDamage: raw.endsOnDamage,
    vfx: resolveStatusVfx(raw.vfx),
  };
}

export function resolveStatus(raw: unknown): StatusDef | null {
  const parsed = v.safeParse(statusSourceSchema, raw);
  return parsed.success ? compileStatus(parsed.output) : null;
}

export const COMBAT_STATUS_ID = "combat";

export const COMBAT_DURATION_MS = 60_000;

export const COMBAT_STATUS: StatusDef = {
  id: COMBAT_STATUS_ID,
  name: "In combat",
  description: "You fought recently. Leaving now leaves your body here until it ends.",
  tone: "bad",
  icon: {
    tilesetId: "equipment",
    rect: { x: 0, y: 18, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  fromMs: COMBAT_DURATION_MS,
  toMs: COMBAT_DURATION_MS,
  stacks: false,
  maxMs: COMBAT_DURATION_MS,
  everyMs: constantFormula(0),
  effects: {},
  modifiers: {},
  walkSpeedPercent: 0,
  incapacitates: false,
  endsOnDamage: false,
  vfx: NO_VFX,
};

export function statusesById(raw: unknown[]): Record<string, StatusDef> {
  const out: Record<string, StatusDef> = {};
  for (const entry of raw) {
    const status = resolveStatus(entry);
    if (!status || out[status.id]) continue;
    out[status.id] = status;
  }
  out[COMBAT_STATUS_ID] = COMBAT_STATUS;
  return out;
}

export type ActiveStatus = {
  defId: string;
  name: string;
  description: string;
  tone: StatusTone;
  icon: AnchoredSprite | null;
  remainingMs: number;
  fullDurationMs: number;
};

export function fullDurationMs(def: StatusDef): number {
  return def.stacks ? def.maxMs : def.toMs;
}

export function completeSprite(
  sprite: { tilesetId: string; rect: CellRect; base?: { x: number; y: number } } | undefined,
): AnchoredSprite | null {
  if (!sprite) return null;
  return { ...sprite, base: sprite.base ?? defaultBase(sprite.rect) };
}

export function activeStatuses(
  instances: readonly { defId: string; remainingMs: number }[],
  catalogue: Record<string, StatusDef>,
): ActiveStatus[] {
  const out: ActiveStatus[] = [];
  for (const instance of instances) {
    const def = catalogue[instance.defId];
    if (!def) continue;
    out.push({
      defId: def.id,
      name: def.name,
      description: def.description,
      tone: def.tone,
      icon: def.icon ?? null,
      remainingMs: instance.remainingMs,
      fullDurationMs: fullDurationMs(def),
    });
  }
  return out;
}
