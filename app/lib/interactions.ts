import * as v from "valibot";
import { DEFAULT_BATTLER, type BattlerDef } from "./battler";
import type { BrainDef } from "./brain";
import type { DialogDef } from "./dialog";
import { ELEMENTS } from "./element";
import type { ItemDef } from "./item";
import { kitForSave } from "./kit";
import { itemForSave, stoneForSave, MAX_CONTAINER_SIZE, resolveItem, weaponForSave } from "./item";
import { MASTERIES } from "./mastery";
import { MAX_PROJECTILE_SPEED, MIN_PROJECTILE_SPEED, type ProjectileBlock } from "./projectile";
import type { Coord, PlacedTile, SpriteState, TileDef } from "./types";
import { HEIGHT_PER_LEVEL, MAX_LEVEL, MIN_LEVEL, resolveActor } from "./types";

export type ClimbAbility = "none" | "half" | "full";

export const CLIMB_ABILITIES: ClimbAbility[] = ["none", "half", "full"];

export const CLIMB_HEIGHT_UNITS: Record<ClimbAbility, number> = {
  none: 0,
  half: HEIGHT_PER_LEVEL / 2,
  full: HEIGHT_PER_LEVEL,
};

export type PushInteraction = {
  climb: ClimbAbility;
  moveOnTileIds: string[];
};

export type SwitchInteraction = {
  targetTileId: string;
  actionName?: string;
};

export type DecayInteraction = {
  tileId: string;
  fromMs: number;
  toMs: number;
};

export type RespawnInteraction = {
  fromMs: number;
  toMs: number;
};

export type Affliction = {
  statusId: string;
  tileId: string;
};

export type EndureInteraction = {
  durability: number;
  suffers: Affliction[];
};

export type PlateComparison = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";

export const PLATE_COMPARISONS: PlateComparison[] = ["eq", "neq", "gt", "gte", "lt", "lte"];

const COMPARATORS: Record<PlateComparison, (load: number, height: number) => boolean> = {
  eq: (load, height) => load === height,
  neq: (load, height) => load !== height,
  gt: (load, height) => load > height,
  gte: (load, height) => load >= height,
  lt: (load, height) => load < height,
  lte: (load, height) => load <= height,
};

export type PressurePlateInteraction = {
  tileId: string;
  type: PlateComparison;
  height: number;
};

export type SignalValue = "on" | "off";

export const SIGNAL_VALUES: SignalValue[] = ["on", "off"];

export type EmitInteraction = {
  value: SignalValue;
};

export type SignalMode = "any" | "all";

export const SIGNAL_MODES: SignalMode[] = ["any", "all"];

export type ReceiveInteraction = {
  tileId: string;
  when: SignalValue;
  mode: SignalMode;
};

export type ActivationTrigger = "step" | "interact" | "interactOver";

export const ACTIVATION_TRIGGERS: ActivationTrigger[] = ["step", "interact", "interactOver"];

export type TeleportDestination =
  | {
      kind: "relative";
      delta: Coord;
    }
  | {
      kind: "absolute";
    };

export type TeleportDestinationKind = TeleportDestination["kind"];

export type TeleportInteraction = {
  actionName?: string;
  trigger: ActivationTrigger;
  destination: TeleportDestination;
};

export type PlacedTeleport = {
  actionName?: string;
  trigger: ActivationTrigger;
  to: Coord;
};

export type AddStatusInteraction = {
  actionName?: string;
  trigger: ActivationTrigger;
  statusId: string;
  ground?: boolean;
};

export type RemoveStatusInteraction = {
  actionName?: string;
  trigger: ActivationTrigger;
  statusId: string;
};

export type SetSpawnInteraction = {
  actionName?: string;
  trigger: ActivationTrigger;
};

export type RewardInteraction = {
  actionName?: string;
};

export type PlacedReward = {
  actionName?: string;
  tag: string;
  itemTileIds: string[];
};

export type CraftInput = {
  tileId: string;
  count: number;
};

export type CraftChanceItem = {
  tileId: string;
  chance: number;
};

export type CraftWeightedItem = {
  tileId: string;
  weight: number;
};

export type CraftOutput =
  | { kind: "all"; items: CraftChanceItem[] }
  | { kind: "one"; items: CraftWeightedItem[] };

export type CraftOutputKind = CraftOutput["kind"];

export type CraftRecipe = {
  name: string;
  inputs: CraftInput[];
  output: CraftOutput;
};

export type CraftInteraction = {
  actionName?: string;
  recipes: CraftRecipe[];
};

export const MAX_CRAFT_OUTPUTS = MAX_CONTAINER_SIZE;

export const MAX_CRAFT_INPUTS = 4;

export const MAX_CRAFT_INPUT_COUNT = 99;

export const MAX_CRAFT_CHANCE = 100;

export const MAX_CRAFT_WEIGHT = 1000;

export const MAX_CRAFT_RECIPES = 16;

export const MAX_REWARD_ITEMS = MAX_CONTAINER_SIZE;

export type ExtractSlot = {
  tileId: string;
  chance: number;
};

export const MIN_EXTRACT_CHANCE = 0;
export const MAX_EXTRACT_CHANCE = 100;

export const MAX_EXTRACT_SLOTS = 4;

export type ExtractInteraction = {
  actionName?: string;
  durability: number;
  tileId: string;
  durationMs: number;
  slots: ExtractSlot[];
};

export type TileInteractions = {
  brain?: BrainDef;
  dialog?: DialogDef;
  battler?: BattlerDef;
  item?: ItemDef;
  projectile?: ProjectileBlock;
  push?: PushInteraction;
  switch?: SwitchInteraction;
  reward?: RewardInteraction;
  craft?: CraftInteraction;
  extract?: ExtractInteraction;
  teleport?: TeleportInteraction;
  addStatus?: AddStatusInteraction;
  removeStatus?: RemoveStatusInteraction;
  setSpawn?: SetSpawnInteraction;
  endure?: EndureInteraction;
  decay?: DecayInteraction;
  respawn?: RespawnInteraction;
  pressurePlate?: PressurePlateInteraction;
  emit?: EmitInteraction;
  receive?: ReceiveInteraction;
};

export const DEFAULT_SWITCH: SwitchInteraction = {
  targetTileId: "",
  actionName: "",
};

export const DEFAULT_REWARD: RewardInteraction = {
  actionName: "",
};

export const DEFAULT_CRAFT_RECIPE: CraftRecipe = {
  name: "",
  inputs: [{ tileId: "", count: 1 }],
  output: { kind: "all", items: [{ tileId: "", chance: MAX_CRAFT_CHANCE }] },
};

export const DEFAULT_CRAFT: CraftInteraction = {
  actionName: "",
  recipes: [DEFAULT_CRAFT_RECIPE],
};

const DEFAULT_EXTRACT_DURATION_MS = 3_000;

export const DEFAULT_EXTRACT: ExtractInteraction = {
  actionName: "",
  durability: 3,
  tileId: "",
  durationMs: DEFAULT_EXTRACT_DURATION_MS,
  slots: [{ tileId: "", chance: MAX_EXTRACT_CHANCE }],
};

export const DEFAULT_TELEPORT: TeleportInteraction = {
  actionName: "",
  trigger: "interactOver",
  destination: { kind: "relative", delta: { x: 0, y: 0, z: 1 } },
};

export const DEFAULT_ADD_STATUS: AddStatusInteraction = {
  actionName: "",
  trigger: "step",
  statusId: "",
};

export const DEFAULT_REMOVE_STATUS: RemoveStatusInteraction = {
  actionName: "",
  trigger: "step",
  statusId: "",
};

const DEFAULT_DURABILITY = 20;

export const DEFAULT_AFFLICTION: Affliction = {
  statusId: "",
  tileId: "",
};

export const DEFAULT_ENDURE: EndureInteraction = {
  durability: DEFAULT_DURABILITY,
  suffers: [],
};

export const MAX_AFFLICTIONS = 4;

const DEFAULT_DECAY_FROM_MS = 20_000;
const DEFAULT_DECAY_TO_MS = 40_000;

export const DEFAULT_SET_SPAWN: SetSpawnInteraction = {
  trigger: "interact",
  actionName: "",
};

export const DEFAULT_DECAY: DecayInteraction = {
  tileId: "",
  fromMs: DEFAULT_DECAY_FROM_MS,
  toMs: DEFAULT_DECAY_TO_MS,
};

const DEFAULT_RESPAWN_FROM_MS = 30_000;
const DEFAULT_RESPAWN_TO_MS = 60_000;

export const DEFAULT_RESPAWN: RespawnInteraction = {
  fromMs: DEFAULT_RESPAWN_FROM_MS,
  toMs: DEFAULT_RESPAWN_TO_MS,
};

export const DEFAULT_PUSH: PushInteraction = {
  climb: "half",
  moveOnTileIds: [],
};

export const DEFAULT_PRESSURE_PLATE: PressurePlateInteraction = {
  tileId: "",
  type: "gte",
  height: 1,
};

export const DEFAULT_EMIT: EmitInteraction = {
  value: "on",
};

export const DEFAULT_RECEIVE: ReceiveInteraction = {
  tileId: "",
  when: "on",
  mode: "any",
};

export function plateTriggers(plate: PressurePlateInteraction, load: number): boolean {
  return COMPARATORS[plate.type](load, plate.height);
}

const pushSchema = v.object({
  climb: v.picklist(CLIMB_ABILITIES),
  moveOnTileIds: v.array(v.string()),
});

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
  actionName: v.optional(v.string()),
});

const switchCache = new WeakMap<TileDef, SwitchInteraction | null>();

export function resolveSwitch(def: TileDef): SwitchInteraction | null {
  const cached = switchCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.switch;
  const parsed = raw == null ? null : v.safeParse(switchSchema, raw);
  const sw = parsed?.success ? parsed.output : null;
  switchCache.set(def, sw);
  return sw;
}

const rewardSchema = v.object({
  actionName: v.optional(v.string()),
});

const rewardCache = new WeakMap<TileDef, RewardInteraction | null>();

export function resolveRewardDef(def: TileDef): RewardInteraction | null {
  const cached = rewardCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.reward;
  const parsed = raw == null ? null : v.safeParse(rewardSchema, raw);
  const reward = parsed?.success ? parsed.output : null;
  rewardCache.set(def, reward);
  return reward;
}

const placedRewardCache = new WeakMap<PlacedTile, PlacedReward | null>();

export function resolveReward(placed: PlacedTile, def: TileDef | undefined): PlacedReward | null {
  const cached = placedRewardCache.get(placed);
  if (cached !== undefined) return cached;

  const reward = def ? readPlacedReward(placed, def) : null;
  placedRewardCache.set(placed, reward);
  return reward;
}

const placedRewardSchema = v.object({
  rewardTag: v.pipe(v.string(), v.trim(), v.minLength(1)),
  rewardTileIds: v.pipe(v.array(v.string()), v.minLength(1), v.maxLength(MAX_REWARD_ITEMS)),
});

function readPlacedReward(placed: PlacedTile, def: TileDef): PlacedReward | null {
  const gesture = resolveRewardDef(def);
  if (!gesture) return null;
  const parsed = v.safeParse(placedRewardSchema, placed);
  if (!parsed.success) return null;
  return {
    ...gesture,
    tag: parsed.output.rewardTag,
    itemTileIds: parsed.output.rewardTileIds,
  };
}

const craftTileIdSchema = v.pipe(v.string(), v.trim(), v.minLength(1));

const craftInputSchema = v.object({
  tileId: craftTileIdSchema,
  count: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_CRAFT_INPUT_COUNT)),
});

const craftOutputSchema = v.variant("kind", [
  v.object({
    kind: v.literal("all"),
    items: v.pipe(
      v.array(
        v.object({
          tileId: craftTileIdSchema,
          chance: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_CRAFT_CHANCE)),
        }),
      ),
      v.minLength(1),
      v.maxLength(MAX_CRAFT_OUTPUTS),
    ),
  }),
  v.object({
    kind: v.literal("one"),
    items: v.pipe(
      v.array(
        v.object({
          tileId: craftTileIdSchema,
          weight: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_CRAFT_WEIGHT)),
        }),
      ),
      v.minLength(1),
      v.maxLength(MAX_CRAFT_OUTPUTS),
    ),
  }),
]);

const craftRecipeSchema = v.object({
  name: v.fallback(v.pipe(v.string(), v.trim()), ""),
  inputs: v.pipe(v.array(craftInputSchema), v.minLength(1), v.maxLength(MAX_CRAFT_INPUTS)),
  output: craftOutputSchema,
});

const craftSchema = v.object({
  actionName: v.optional(v.string()),
  recipes: v.pipe(
    v.array(v.fallback(v.nullable(craftRecipeSchema), null)),
    v.transform((recipes) =>
      recipes.filter((recipe): recipe is CraftRecipe => recipe != null).slice(0, MAX_CRAFT_RECIPES),
    ),
  ),
});

const craftCache = new WeakMap<TileDef, CraftInteraction | null>();

export function resolveCraft(def: TileDef): CraftInteraction | null {
  const cached = craftCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.craft;
  const parsed = raw == null ? null : v.safeParse(craftSchema, raw);
  const craft = parsed?.success && parsed.output.recipes.length > 0 ? parsed.output : null;
  craftCache.set(def, craft);
  return craft;
}

const extractSlotSchema = v.object({
  tileId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  chance: v.pipe(
    v.number(),
    v.finite(),
    v.minValue(MIN_EXTRACT_CHANCE),
    v.maxValue(MAX_EXTRACT_CHANCE),
  ),
});

const extractSchema = v.object({
  actionName: v.optional(v.string()),
  durability: v.pipe(v.number(), v.integer(), v.minValue(1)),
  tileId: v.string(),
  durationMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
  slots: v.pipe(
    v.array(v.fallback(v.nullable(extractSlotSchema), null)),
    v.transform((slots) =>
      slots.filter((slot): slot is ExtractSlot => slot != null).slice(0, MAX_EXTRACT_SLOTS),
    ),
  ),
});

const extractCache = new WeakMap<TileDef, ExtractInteraction | null>();

export function resolveExtract(def: TileDef): ExtractInteraction | null {
  const cached = extractCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.extract;
  const parsed = raw == null ? null : v.safeParse(extractSchema, raw);
  const extract = parsed?.success && parsed.output.slots.length > 0 ? parsed.output : null;
  extractCache.set(def, extract);
  return extract;
}

export const DEFAULT_EXTRACT_VERB = "Gather";

export function extractsLeft(placed: PlacedTile, extract: ExtractInteraction): number {
  const left = placed.extractsLeft;
  if (typeof left !== "number" || !Number.isFinite(left)) {
    return extract.durability;
  }
  return Math.max(0, Math.min(extract.durability, Math.floor(left)));
}

export function extractsReserved(placed: PlacedTile): number {
  const held = placed.extractsReserved;
  if (typeof held !== "number" || !Number.isFinite(held)) return 0;
  return Math.max(0, Math.floor(held));
}

export const DEFAULT_CRAFT_VERB = "Craft";

export function craftVerb(craft: CraftInteraction): string {
  return craft.actionName?.trim() || DEFAULT_CRAFT_VERB;
}

export function craftRecipeName(craft: CraftInteraction, recipe: CraftRecipe): string {
  return recipe.name.trim() || craftVerb(craft);
}

const coordSchema = v.object({
  x: v.pipe(v.number(), v.integer()),
  y: v.pipe(v.number(), v.integer()),
  z: v.pipe(v.number(), v.integer()),
});

const teleportSchema = v.object({
  actionName: v.optional(v.string()),
  trigger: v.picklist(ACTIVATION_TRIGGERS),
  destination: v.variant("kind", [
    v.object({ kind: v.literal("relative"), delta: coordSchema }),
    v.object({ kind: v.literal("absolute") }),
  ]),
});

const teleportCache = new WeakMap<TileDef, TeleportInteraction | null>();

export function resolveTeleportDef(def: TileDef): TeleportInteraction | null {
  const cached = teleportCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.teleport;
  const parsed = raw == null ? null : v.safeParse(teleportSchema, raw);
  const teleport = parsed?.success ? parsed.output : null;
  teleportCache.set(def, teleport);
  return teleport;
}

const placedTeleportSchema = v.object({
  teleportTo: coordSchema,
});

export function resolveTeleport(
  placed: PlacedTile,
  def: TileDef | undefined,
  at: Coord,
): PlacedTeleport | null {
  const gesture = def ? resolveTeleportDef(def) : null;
  if (!gesture) return null;

  const to = destinationOf(gesture.destination, placed, at);
  if (!to) return null;
  if (to.z < MIN_LEVEL || to.z > MAX_LEVEL) return null;
  if (to.x === at.x && to.y === at.y && to.z === at.z) return null;

  return {
    ...(gesture.actionName ? { actionName: gesture.actionName } : {}),
    trigger: gesture.trigger,
    to,
  };
}

function destinationOf(
  destination: TeleportDestination,
  placed: PlacedTile,
  at: Coord,
): Coord | null {
  if (destination.kind === "relative") {
    const { delta } = destination;
    return { x: at.x + delta.x, y: at.y + delta.y, z: at.z + delta.z };
  }
  return authoredDestination(placed);
}

const authoredTeleportCache = new WeakMap<PlacedTile, Coord | null>();

function authoredDestination(placed: PlacedTile): Coord | null {
  const cached = authoredTeleportCache.get(placed);
  if (cached !== undefined) return cached;

  const parsed = v.safeParse(placedTeleportSchema, placed);
  const authored = parsed.success ? parsed.output.teleportTo : null;
  authoredTeleportCache.set(placed, authored);
  return authored;
}

const addStatusSchema = v.object({
  actionName: v.optional(v.string()),
  trigger: v.picklist(ACTIVATION_TRIGGERS),
  statusId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  ground: v.optional(v.boolean()),
});

const addStatusCache = new WeakMap<TileDef, AddStatusInteraction | null>();

export function resolveAddStatus(def: TileDef): AddStatusInteraction | null {
  const cached = addStatusCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.addStatus;
  const parsed = raw == null ? null : v.safeParse(addStatusSchema, raw);
  const addStatus = parsed?.success ? parsed.output : null;
  addStatusCache.set(def, addStatus);
  return addStatus;
}

const removeStatusSchema = v.object({
  actionName: v.optional(v.string()),
  trigger: v.picklist(ACTIVATION_TRIGGERS),
  statusId: v.pipe(v.string(), v.trim(), v.minLength(1)),
});

const removeStatusCache = new WeakMap<TileDef, RemoveStatusInteraction | null>();

export function resolveRemoveStatus(def: TileDef): RemoveStatusInteraction | null {
  const cached = removeStatusCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.removeStatus;
  const parsed = raw == null ? null : v.safeParse(removeStatusSchema, raw);
  const removeStatus = parsed?.success ? parsed.output : null;
  removeStatusCache.set(def, removeStatus);
  return removeStatus;
}

const setSpawnSchema = v.object({
  actionName: v.optional(v.string()),
  trigger: v.picklist(ACTIVATION_TRIGGERS),
});

const setSpawnCache = new WeakMap<TileDef, SetSpawnInteraction | null>();

export function resolveSetSpawn(def: TileDef): SetSpawnInteraction | null {
  const cached = setSpawnCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.setSpawn;
  const parsed = raw == null ? null : v.safeParse(setSpawnSchema, raw);
  const setSpawn = parsed?.success ? parsed.output : null;
  setSpawnCache.set(def, setSpawn);
  return setSpawn;
}

const afflictionSchema = v.object({
  statusId: v.pipe(v.string(), v.minLength(1)),
  tileId: v.string(),
});

const endureSchema = v.object({
  durability: v.pipe(v.number(), v.integer(), v.minValue(1)),
  suffers: v.pipe(v.array(afflictionSchema), v.minLength(1), v.maxLength(MAX_AFFLICTIONS)),
});

const endureCache = new WeakMap<TileDef, EndureInteraction | null>();

export function resolveEndure(def: TileDef): EndureInteraction | null {
  const cached = endureCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.endure;
  const parsed = raw == null ? null : v.safeParse(endureSchema, raw);
  const endure = parsed?.success ? parsed.output : null;
  endureCache.set(def, endure);
  return endure;
}

export function afflictionFor(endure: EndureInteraction, statusId: string): Affliction | null {
  return endure.suffers.find((one) => one.statusId === statusId) ?? null;
}

const decaySchema = v.pipe(
  v.object({
    tileId: v.string(),
    fromMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
    toMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
  }),
  v.check((d) => d.toMs >= d.fromMs, "decay toMs must be at least fromMs"),
);

const decayCache = new WeakMap<TileDef, DecayInteraction | null>();

export function resolveDecay(def: TileDef): DecayInteraction | null {
  const cached = decayCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.decay;
  const parsed = raw == null ? null : v.safeParse(decaySchema, raw);
  const decay = parsed?.success ? parsed.output : null;
  decayCache.set(def, decay);
  return decay;
}

const respawnSchema = v.pipe(
  v.object({
    fromMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
    toMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
  }),
  v.check((r) => r.toMs >= r.fromMs, "respawn toMs must be at least fromMs"),
);

const respawnCache = new WeakMap<TileDef, RespawnInteraction | null>();

export function resolveRespawn(def: TileDef): RespawnInteraction | null {
  const cached = respawnCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.respawn;
  const parsed = raw == null ? null : v.safeParse(respawnSchema, raw);
  const respawn = parsed?.success ? parsed.output : null;
  respawnCache.set(def, respawn);
  return respawn;
}

const pressurePlateSchema = v.object({
  tileId: v.pipe(v.string(), v.minLength(1)),
  type: v.picklist(PLATE_COMPARISONS),
  height: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

const pressurePlateCache = new WeakMap<TileDef, PressurePlateInteraction | null>();

export function resolvePressurePlate(def: TileDef): PressurePlateInteraction | null {
  const cached = pressurePlateCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.pressurePlate;
  const parsed = raw == null ? null : v.safeParse(pressurePlateSchema, raw);
  const plate = parsed?.success ? parsed.output : null;
  pressurePlateCache.set(def, plate);
  return plate;
}

const emitSchema = v.object({
  value: v.picklist(SIGNAL_VALUES),
});

const emitCache = new WeakMap<TileDef, EmitInteraction | null>();

export function resolveEmit(def: TileDef): EmitInteraction | null {
  const cached = emitCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.emit;
  const parsed = raw == null ? null : v.safeParse(emitSchema, raw);
  const emit = parsed?.success ? parsed.output : null;
  emitCache.set(def, emit);
  return emit;
}

const receiveSchema = v.object({
  tileId: v.pipe(v.string(), v.minLength(1)),
  when: v.picklist(SIGNAL_VALUES),
  mode: v.picklist(SIGNAL_MODES),
});

const receiveCache = new WeakMap<TileDef, ReceiveInteraction | null>();

export function resolveReceive(def: TileDef): ReceiveInteraction | null {
  const cached = receiveCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.receive;
  const parsed = raw == null ? null : v.safeParse(receiveSchema, raw);
  const receive = parsed?.success ? parsed.output : null;
  receiveCache.set(def, receive);
  return receive;
}

export function receiveTriggers(receive: ReceiveInteraction, powered: boolean): boolean {
  return powered === (receive.when === "on");
}

export type InteractionKind =
  | "reward"
  | "teleport"
  | "switch"
  | "addStatus"
  | "removeStatus"
  | "setSpawn"
  | "craft"
  | "extract"
  | "pickUp"
  | "push";

export function interactionKinds(def: TileDef): InteractionKind[] {
  const kinds: InteractionKind[] = [];
  if (resolveRewardDef(def)) kinds.push("reward");
  if (pressable(resolveTeleportDef(def))) kinds.push("teleport");
  if (resolveSwitch(def)) kinds.push("switch");
  if (pressable(resolveAddStatus(def))) kinds.push("addStatus");
  if (pressable(resolveRemoveStatus(def))) kinds.push("removeStatus");
  if (pressable(resolveSetSpawn(def))) kinds.push("setSpawn");
  if (resolveCraft(def)) kinds.push("craft");
  if (resolveExtract(def)) kinds.push("extract");
  if (resolveItem(def)) kinds.push("pickUp");
  if (resolvePush(def)) kinds.push("push");
  return kinds;
}

function pressable(gesture: { trigger: ActivationTrigger } | null): boolean {
  return gesture != null && gesture.trigger !== "step";
}

export function isMobileTile(def: TileDef): boolean {
  return def.affectedByGravity === true || resolveActor(def) || resolvePush(def) !== null;
}

export function availableStates(def: TileDef): SpriteState[] {
  const out: SpriteState[] = ["idle"];
  if (isMobileTile(def)) out.push("moving");
  return out;
}

export function hasSpriteStates(def: TileDef): boolean {
  const states = def.states;
  if (!states) return false;
  return Object.values(states).some((s) => s != null);
}

export function isInteractive(def: TileDef): boolean {
  return interactionKinds(def).length > 0;
}

export function hasAnyInteraction(interactions: TileInteractions | undefined): boolean {
  return Boolean(
    interactions?.brain ||
    interactions?.dialog ||
    interactions?.battler ||
    interactions?.item ||
    interactions?.projectile ||
    interactions?.push ||
    interactions?.switch ||
    interactions?.reward ||
    interactions?.craft ||
    interactions?.extract ||
    interactions?.teleport ||
    interactions?.addStatus ||
    interactions?.removeStatus ||
    interactions?.endure ||
    interactions?.decay ||
    interactions?.respawn ||
    interactions?.pressurePlate ||
    interactions?.emit ||
    interactions?.receive,
  );
}

export function interactionsForSave(
  interactions: TileInteractions | undefined,
): TileInteractions | undefined {
  const push = interactions?.push;
  const sw = interactions?.switch;
  const plate = interactions?.pressurePlate;
  const savedPush = push
    ? {
        climb: push.climb,
        moveOnTileIds: [...push.moveOnTileIds].sort(),
      }
    : undefined;
  const switchActionName = sw?.actionName?.trim();
  const savedSwitch = sw?.targetTileId.trim()
    ? {
        targetTileId: sw.targetTileId.trim(),
        ...(switchActionName ? { actionName: switchActionName } : {}),
      }
    : undefined;
  const savedPlate = plate?.tileId.trim()
    ? { tileId: plate.tileId.trim(), type: plate.type, height: plate.height }
    : undefined;
  const reward = interactions?.reward;
  const rewardActionName = reward?.actionName?.trim();
  const savedReward = reward
    ? { ...(rewardActionName ? { actionName: rewardActionName } : {}) }
    : undefined;
  const savedCraft = interactions?.craft ? craftForSave(interactions.craft) : undefined;
  const extract = interactions?.extract;
  const savedSlots = (extract?.slots ?? []).flatMap((slot) => {
    const tileId = slot.tileId.trim();
    if (!tileId) return [];
    return [{ tileId, chance: slot.chance }];
  });
  const extractActionName = extract?.actionName?.trim();
  const savedExtract =
    extract && savedSlots.length > 0
      ? {
          ...(extractActionName ? { actionName: extractActionName } : {}),
          durability: Math.max(1, Math.round(extract.durability)),
          tileId: extract.tileId.trim(),
          durationMs: Math.max(0, Math.round(extract.durationMs)),
          slots: savedSlots.slice(0, MAX_EXTRACT_SLOTS),
        }
      : undefined;
  const teleport = interactions?.teleport;
  const teleportActionName = teleport?.actionName?.trim();
  const savedTeleport = teleport
    ? {
        ...(teleportActionName ? { actionName: teleportActionName } : {}),
        trigger: teleport.trigger,
        destination:
          teleport.destination.kind === "relative"
            ? {
                kind: "relative" as const,
                delta: {
                  x: Math.round(teleport.destination.delta.x),
                  y: Math.round(teleport.destination.delta.y),
                  z: Math.round(teleport.destination.delta.z),
                },
              }
            : { kind: "absolute" as const },
      }
    : undefined;
  const addStatus = interactions?.addStatus;
  const addStatusActionName = addStatus?.actionName?.trim();
  const savedAddStatus = addStatus?.statusId.trim()
    ? {
        ...(addStatusActionName ? { actionName: addStatusActionName } : {}),
        trigger: addStatus.trigger,
        statusId: addStatus.statusId.trim(),
        ...(addStatus.ground ? { ground: true } : {}),
      }
    : undefined;
  const removeStatus = interactions?.removeStatus;
  const removeStatusActionName = removeStatus?.actionName?.trim();
  const savedRemoveStatus = removeStatus?.statusId.trim()
    ? {
        ...(removeStatusActionName ? { actionName: removeStatusActionName } : {}),
        trigger: removeStatus.trigger,
        statusId: removeStatus.statusId.trim(),
      }
    : undefined;
  const setSpawn = interactions?.setSpawn;
  const setSpawnActionName = setSpawn?.actionName?.trim();
  const savedSetSpawn = setSpawn
    ? {
        ...(setSpawnActionName ? { actionName: setSpawnActionName } : {}),
        trigger: setSpawn.trigger,
      }
    : undefined;
  const endure = interactions?.endure;
  const endureDurability = endure ? Math.round(endure.durability) : 0;
  const savedSuffers = (endure?.suffers ?? [])
    .filter((one) => one.statusId.trim())
    .slice(0, MAX_AFFLICTIONS)
    .map((one) => ({ statusId: one.statusId.trim(), tileId: one.tileId.trim() }));
  const savedEndure =
    endureDurability > 0 && savedSuffers.length > 0
      ? { durability: endureDurability, suffers: savedSuffers }
      : undefined;
  const decay = interactions?.decay;
  const decayFromMs = decay ? Math.round(decay.fromMs) : 0;
  const decayToMs = decay ? Math.round(decay.toMs) : 0;
  const savedDecay =
    decayFromMs > 0 && decayToMs >= decayFromMs
      ? {
          tileId: decay!.tileId.trim(),
          fromMs: decayFromMs,
          toMs: decayToMs,
        }
      : undefined;
  const respawn = interactions?.respawn;
  const respawnFromMs = respawn ? Math.round(respawn.fromMs) : 0;
  const respawnToMs = respawn ? Math.round(respawn.toMs) : 0;
  const savedRespawn =
    respawnFromMs > 0 && respawnToMs >= respawnFromMs
      ? { fromMs: respawnFromMs, toMs: respawnToMs }
      : undefined;
  const emit = interactions?.emit;
  const receive = interactions?.receive;
  const savedEmit = emit ? { value: emit.value } : undefined;
  const savedReceive = receive?.tileId.trim()
    ? {
        tileId: receive.tileId.trim(),
        when: receive.when,
        mode: receive.mode,
      }
    : undefined;
  const savedBrain = interactions?.brain;
  const savedDialog = interactions?.dialog;
  const battler = interactions?.battler;
  const savedKit = kitForSave(battler?.kit);
  const savedImmunities = (battler?.immuneTo ?? []).map((id) => id.trim()).filter(Boolean);
  const savedSpells = (battler?.spells ?? []).flatMap((spell) => {
    const name = spell.name?.trim();
    return name
      ? [
          {
            ...stoneForSave(spell),
            name,
            ...(spell.icon ? { icon: { ...spell.icon } } : {}),
          },
        ]
      : [];
  });
  const savedBattler = battler
    ? {
        baseHp: battler.baseHp ?? DEFAULT_BATTLER.baseHp,
        masteries: Object.fromEntries(
          MASTERIES.filter((mastery) => (battler.masteries?.[mastery] ?? 0) > 0).map((mastery) => [
            mastery,
            battler.masteries[mastery],
          ]),
        ),
        naturalWeapon: weaponForSave(battler.naturalWeapon ?? DEFAULT_BATTLER.naturalWeapon),
        sight: {
          up: battler.sight?.up ?? DEFAULT_BATTLER.sight.up,
          down: battler.sight?.down ?? DEFAULT_BATTLER.sight.down,
        },
        ...(savedKit ? { kit: savedKit } : {}),
        ...(battler.elements?.length
          ? {
              elements: ELEMENTS.filter((element) => battler.elements?.includes(element)),
            }
          : {}),
        ...(savedImmunities.length ? { immuneTo: savedImmunities } : {}),
        ...(battler.remains?.trim() ? { remains: battler.remains.trim() } : {}),
        ...(savedSpells.length ? { spells: savedSpells } : {}),
      }
    : undefined;
  const savedItem = itemForSave(interactions?.item);
  const projectile = interactions?.projectile;
  const savedProjectile = projectile
    ? {
        cellsPerSecond: Math.min(
          MAX_PROJECTILE_SPEED,
          Math.max(MIN_PROJECTILE_SPEED, projectile.cellsPerSecond),
        ),
        ...(projectile.hit ? { hit: projectile.hit } : {}),
      }
    : undefined;
  if (
    !savedBrain &&
    !savedDialog &&
    !savedBattler &&
    !savedItem &&
    !savedProjectile &&
    !savedPush &&
    !savedSwitch &&
    !savedReward &&
    !savedCraft &&
    !savedExtract &&
    !savedTeleport &&
    !savedAddStatus &&
    !savedRemoveStatus &&
    !savedSetSpawn &&
    !savedEndure &&
    !savedDecay &&
    !savedRespawn &&
    !savedPlate &&
    !savedEmit &&
    !savedReceive
  ) {
    return undefined;
  }
  return {
    ...(savedBrain ? { brain: savedBrain } : {}),
    ...(savedDialog ? { dialog: savedDialog } : {}),
    ...(savedBattler ? { battler: savedBattler } : {}),
    ...(savedItem ? { item: savedItem } : {}),
    ...(savedProjectile ? { projectile: savedProjectile } : {}),
    ...(savedPush ? { push: savedPush } : {}),
    ...(savedSwitch ? { switch: savedSwitch } : {}),
    ...(savedReward ? { reward: savedReward } : {}),
    ...(savedCraft ? { craft: savedCraft } : {}),
    ...(savedExtract ? { extract: savedExtract } : {}),
    ...(savedTeleport ? { teleport: savedTeleport } : {}),
    ...(savedAddStatus ? { addStatus: savedAddStatus } : {}),
    ...(savedRemoveStatus ? { removeStatus: savedRemoveStatus } : {}),
    ...(savedSetSpawn ? { setSpawn: savedSetSpawn } : {}),
    ...(savedEndure ? { endure: savedEndure } : {}),
    ...(savedDecay ? { decay: savedDecay } : {}),
    ...(savedRespawn ? { respawn: savedRespawn } : {}),
    ...(savedPlate ? { pressurePlate: savedPlate } : {}),
    ...(savedEmit ? { emit: savedEmit } : {}),
    ...(savedReceive ? { receive: savedReceive } : {}),
  };
}

function craftForSave(craft: CraftInteraction): CraftInteraction | undefined {
  const recipes = craft.recipes.flatMap((recipe) => {
    const saved = craftRecipeForSave(recipe);
    return saved ? [saved] : [];
  });
  if (recipes.length === 0) return undefined;
  const actionName = craft.actionName?.trim();
  return { ...(actionName ? { actionName } : {}), recipes };
}

function craftRecipeForSave(recipe: CraftRecipe): CraftRecipe | null {
  const inputs = recipe.inputs
    .map((input) => ({ tileId: input.tileId.trim(), count: input.count }))
    .filter((input) => input.tileId);
  const output = craftOutputForSave(recipe.output);
  if (inputs.length === 0 || !output) return null;
  return { name: recipe.name.trim(), inputs, output };
}

function craftOutputForSave(output: CraftOutput): CraftOutput | null {
  if (output.kind === "all") {
    const items = output.items
      .map((item) => ({ tileId: item.tileId.trim(), chance: item.chance }))
      .filter((item) => item.tileId);
    return items.length > 0 ? { kind: "all", items } : null;
  }
  const items = output.items
    .map((item) => ({ tileId: item.tileId.trim(), weight: item.weight }))
    .filter((item) => item.tileId);
  return items.length > 0 ? { kind: "one", items } : null;
}
