import * as v from "valibot";
import { type Formula, parseFormula } from "./formula";
import { type CellRect, defaultBase, type SpriteRef } from "./types";

/**
 * What a status effect *is*: a lifetime, something it does while it lasts, and
 * a name for the person carrying it.
 *
 * ## Why these live in a file of their own
 *
 * A status is not a thing in the world. It is never placed, never stacked, never
 * walked into and never picked up, so giving it a `TileDef` would mean every
 * consumer of `tilesById` carrying entries that can never appear on a board.
 * `data/statuses.json` is a fourth authored blob beside the map, the tiles and
 * the tilesets, read through the same `./storage.server`.
 *
 * ## Parsed, never trusted
 *
 * The same discipline `./battler` and `./interactions` are under: an entry that
 * does not validate is **dropped from the catalogue**, and everything that
 * references it behaves as though it were never authored. A world whose author
 * fat-fingered a formula should lose one effect, not fail to start.
 *
 * The formulas are compiled here, once, rather than at the point of use — a
 * status's effect is evaluated once a second per bearer and its modifiers once
 * per body per frame, and re-parsing at that rate would be the most expensive
 * thing in either loop.
 */

/** Which way a status leans. See {@link StatusDef.tone}. */
export type StatusTone = "good" | "bad";

export const STATUS_TONES: StatusTone[] = ["good", "bad"];

/**
 * The numbers a status may move, as formulas evaluated where the stats are read.
 *
 * A subset of `FightingStats` on purpose: `range` and `sight` are facts about a
 * body rather than a condition it is in, and a status that changed how far you
 * could see would be a different feature wearing this one's clothes.
 */
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
  /** What it is called where it is shown. "Fed". */
  name: string;
  /**
   * One line saying what it does, in words rather than arithmetic.
   *
   * Required, unlike a consumable's `label` or `sound`, because there is exactly
   * one thing that ever explains a status and this is it: the tooltip on a panel
   * row and on a strip icon, and the second half of every icon's accessible
   * name. A blank one is an icon nobody can identify.
   */
  description: string;
  /**
   * Whether this is something being done *to* you or *for* you.
   *
   * **Not derived from the sign of the effects**, because a status can perfectly
   * well heal you while wrecking your accuracy and only the author knows which of
   * those is the point.
   *
   * It earns its keep beyond colour: it is the first term of the comparator both
   * the strip and the stats panel sort by, so when the strip runs out of room the
   * thing dropped into its `+N` is never the poison.
   */
  tone: StatusTone;
  /**
   * The picture, as a rectangle on a tileset.
   *
   * Its own sprite rather than a borrowed tile id, which is what lets a status
   * be drawn from anywhere on any sheet instead of only where a tile happens to
   * exist. It is a bare {@link SpriteRef} and not a `Frame`, because a frame is
   * what carries a duration and a status icon has nothing to animate — see
   * `../components/TilePreview`'s `SpritePreview`.
   *
   * Optional: a status with no icon is a status somebody has not drawn yet, and
   * a blank cell in the lane is a better answer than refusing to load one.
   */
  icon?: SpriteRef;
  /** How long one application lasts, both ends included. One draw. */
  fromMs: number;
  toMs: number;
  /**
   * Whether re-applying adds to what is left, or merely refreshes it.
   * See `../game/statuses`.
   */
  stacks: boolean;
  /** Ceiling on accumulated duration. Only read when {@link stacks}. */
  maxMs: number;
  /**
   * How often {@link effects} fire. Zero means never — a status that only
   * modifies stats has no cadence to have.
   */
  everyMs: number;
  /** What one period does to the bearer. */
  effects: { hp?: Formula };
  /** What holding this does to the numbers a fight is fought with. */
  modifiers: StatusModifiers;
};

/**
 * Longest a description may be.
 *
 * It bounds a **tooltip** rather than a row of the panel, which loosens what it
 * is protecting without removing it: a popup is free to be two lines and must
 * not be a paragraph, and this same text is the second half of every icon's
 * accessible name.
 */
export const MAX_STATUS_DESCRIPTION_LENGTH = 80;

/**
 * Longest a status may run, however much is stacked onto it.
 *
 * A sanity bound rather than a balance one, on the terms
 * `MAX_CONSUMABLE_HP_SHIFT` is: an hour is longer than anything worth authoring,
 * and a typo'd extra digit reads as malformed rather than as an effect somebody
 * carries for a week.
 */
export const MAX_STATUS_DURATION_MS = 60 * 60 * 1000;

/** What a fresh status gets in the editor. Complete, and usable on the tick it is made. */
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
};

/**
 * A rectangle on a tileset, in 8px cells.
 *
 * The same shape a tile frame's sprite has, restated here rather than imported
 * from a tile schema because the two are validated at different boundaries and
 * a status must not start depending on what a tile happens to allow.
 *
 * A tileset id naming nothing draws the magenta placeholder rather than failing
 * to load — a missing sheet should be *visible*, on the terms the renderer
 * already treats one.
 */
const spriteRefSchema = v.object({
  tilesetId: v.string(),
  rect: v.object({
    x: v.pipe(v.number(), v.integer(), v.minValue(0)),
    y: v.pipe(v.number(), v.integer(), v.minValue(0)),
    w: v.pipe(v.number(), v.integer(), v.minValue(1)),
    h: v.pipe(v.number(), v.integer(), v.minValue(1)),
  }),
  // Defaulted rather than required, so a sprite written by hand needs only the
  // rectangle — `defaultBase` is the same answer the tile editor fills in.
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

/**
 * The shape on disk, before the formulas are anything but strings.
 *
 * Formulas stay strings through validation and are compiled in
 * {@link compileStatus}, so a syntax error and a malformed number fail at the
 * same place and in the same way rather than one throwing past the other.
 */
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
    icon: v.optional(spriteRefSchema),
    fromMs: durationMs,
    toMs: durationMs,
    stacks: v.optional(v.boolean(), false),
    maxMs: v.optional(durationMs, MAX_STATUS_DURATION_MS),
    everyMs: v.optional(durationMs, 0),
    effects: v.optional(v.object({ hp: v.optional(v.string()) }), () => ({})),
    modifiers: v.optional(
      v.object(
        Object.fromEntries(
          MODIFIER_KEYS.map((key) => [key, v.optional(v.string())]),
        ) as Record<(typeof MODIFIER_KEYS)[number], v.OptionalSchema<v.StringSchema<undefined>, undefined>>,
      ),
      () => ({}),
    ),
  }),
  // An inverted range is malformed and reads as "not a status", exactly as an
  // inverted decay lifetime does — the editor keeps the pair ordered, so nothing
  // authored through it can land here.
  v.check((raw) => raw.toMs >= raw.fromMs, "duration range is inverted"),
);

export type StatusSource = v.InferOutput<typeof statusSourceSchema>;

/**
 * Turn a validated entry into a def, compiling every formula on it.
 *
 * Null when any formula fails to parse, and **the whole status goes**, not just
 * the field: a status whose heal did not compile is one that says "Fed" in the
 * panel and does nothing, which is worse than one that is simply not there.
 */
function compileStatus(raw: StatusSource): StatusDef | null {
  const effects: StatusDef["effects"] = {};
  if (raw.effects.hp !== undefined) {
    const hp = parseFormula(raw.effects.hp);
    if (!hp) return null;
    effects.hp = hp;
  }

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
    everyMs: raw.everyMs,
    effects,
    modifiers,
  };
}

/** One entry, validated and compiled, or null when it is not a status. */
export function resolveStatus(raw: unknown): StatusDef | null {
  const parsed = v.safeParse(statusSourceSchema, raw);
  return parsed.success ? compileStatus(parsed.output) : null;
}

/**
 * The catalogue, keyed by id.
 *
 * Malformed entries are dropped rather than throwing, on the terms above. A
 * duplicate id keeps the **first**, which is the same rule `tilesByIdFromList`
 * runs on and is the one that makes an accidental paste inert rather than
 * silently authoritative.
 */
export function statusesById(raw: unknown[]): Record<string, StatusDef> {
  const out: Record<string, StatusDef> = {};
  for (const entry of raw) {
    const status = resolveStatus(entry);
    if (!status || out[status.id]) continue;
    out[status.id] = status;
  }
  return out;
}

/**
 * One status as the chrome needs to draw it: the instance joined to its def.
 *
 * The join lives here rather than in either component because both of them need
 * it and neither should hold half of one — the same reason `resolveReward` is the
 * only place a placement and its def meet.
 */
export type ActiveStatus = {
  defId: string;
  name: string;
  description: string;
  tone: StatusTone;
  icon: SpriteRef | null;
  remainingMs: number;
  /**
   * What a full bar means for this status — see {@link fullDurationMs}.
   *
   * Resolved here rather than in the component because it is a property of the
   * *def*, and the chrome should not have to know that a stacking status is
   * measured against a different ceiling from one that is not.
   */
  fullDurationMs: number;
};

/**
 * The duration a status's bar reads as full.
 *
 * Two answers, because a status means two different things by "as long as this
 * gets":
 *
 * - **Stacking** — the ceiling it can be piled up to. A bar that filled at one
 *   helping would have nowhere left to show the second, which is the whole point
 *   of a status that stacks.
 * - **Not stacking** — the longest the roll could have come out. A short draw
 *   therefore *starts* short, which is the honest reading: two people who ate
 *   the same thing did not get the same thing, and the bar is where that shows.
 *
 * Never the instance's own rolled duration. That would make every status start
 * full and drain identically, which is easier to read and says nothing.
 *
 * **The trade this makes, decided deliberately:** a status whose ceiling is far
 * above a single helping spends most of its life pinned to the bar's minimum.
 * Fed is exactly that — 10–30 seconds a berry against an hour of stacking — so
 * one berry is under a percent and reads as the one-pixel floor
 * `../components/StatusStrip` keeps for anything still running. That is honest
 * rather than broken: against an hour, a berry *is* a rounding error, and the
 * bar is saying so. An author who wants a readable bar brings `maxMs` within
 * reach of what one use grants.
 */
export function fullDurationMs(def: StatusDef): number {
  return def.stacks ? def.maxMs : def.toMs;
}

/**
 * A stored sprite with its base filled in.
 *
 * `base` is optional on disk — `defaultBase` is the same answer the tile editor
 * writes — so anything reading an authored sprite has to complete it. One helper
 * rather than the same `??` at each of the four places that draw one.
 */
export function completeSprite(
  sprite: { tilesetId: string; rect: CellRect; base?: { x: number; y: number } } | undefined,
): SpriteRef | null {
  if (!sprite) return null;
  return { ...sprite, base: sprite.base ?? defaultBase(sprite.rect) };
}

/** What is running on a body, ready to draw. Unknown ids are dropped. */
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
