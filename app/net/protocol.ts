import * as v from "valibot";
import { CAST_SQUARES, type CastProgress, type CastSlot } from "../game/casting";
import { MAX_SPELL_NAME_LENGTH } from "../lib/battler";
import type { Equipment } from "../game/equipment";
import type { SlotRef } from "../game/itemMoves";
import { SWING_OUTCOMES, type SwingOutcome } from "../game/GameSession";
import { STRIKE_KINDS, type StrikeKind } from "../game/strike";
import type { ConsumeSource } from "../game/itemUse";
import type { Conversation, TalkAction } from "../game/dialogRuntime";
import { masteryXpBlockSchema, type MasteryXp } from "../lib/mastery";
import type { Extraction, ExtractionProgress } from "../game/extract";
import type { Progress } from "../game/progress";
import type { Coord, PlacedTile } from "../lib/types";
import { TRANSITION_SIDES, type TileTransitionNote } from "../lib/tileTransition";
import { MAX_CHAT_RAW_LENGTH } from "./chat";
import { MAX_COMMAND_LENGTH } from "../game/commands";

const coordSchema = v.object({
  x: v.number(),
  y: v.number(),
  z: v.number(),
});

const flightPointSchema = v.object({
  x: v.number(),
  y: v.number(),
  elevAbs: v.number(),
});

const objectRefSchema = v.object({
  x: v.number(),
  y: v.number(),
  z: v.number(),
  stackIndex: v.number(),
});

const directionSchema = v.picklist(["n", "e", "s", "w"] as const);

const MAX_ACTOR_ID_LENGTH = 128;

const hpPatchSchema = v.object({
  actorId: v.string(),
  hp: v.number(),
  maxHp: v.number(),
  rating: v.number(),
});

const namePatchSchema = v.object({
  actorId: v.string(),
  name: v.string(),
});

const statusPatchSchema = v.object({
  defId: v.string(),
  remainingMs: v.number(),
  durationMs: v.number(),
});

const extractionSchema = v.object({
  key: v.string(),
  remainingMs: v.number(),
  durationMs: v.number(),
});

const nextBlowSchema = v.object({
  remainingMs: v.number(),
  durationMs: v.number(),
});

const carriedLightsPatchSchema = v.object({
  actorId: v.string(),
  tileIds: v.array(v.string()),
});

const castSlotSchema = v.variant("from", [
  v.object({ from: v.literal("square"), square: v.picklist(CAST_SQUARES) }),
  v.object({
    from: v.literal("natural"),
    name: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_SPELL_NAME_LENGTH)),
  }),
]);

const statusIdsPatchSchema = v.object({
  actorId: v.string(),
  defIds: v.array(v.string()),
});

const pvpPatchSchema = v.object({
  actorId: v.string(),
  on: v.boolean(),
});

const extractionPatchSchema = v.object({
  actorId: v.string(),
  progress: v.nullable(v.object({ remainingMs: v.number(), durationMs: v.number() })),
});

const castingPatchSchema = v.object({
  actorId: v.string(),
  progress: v.nullable(
    v.object({
      remainingMs: v.number(),
      durationMs: v.number(),
      slot: castSlotSchema,
      targetId: v.optional(v.string()),
    }),
  ),
});

const afflictedPatchSchema = v.object({
  x: v.number(),
  y: v.number(),
  z: v.number(),
  tileId: v.string(),
  defIds: v.array(v.string()),
});

const itemInstanceSchema = v.object({
  id: v.string(),
  tileId: v.string(),
  direction: v.optional(directionSchema),
  channel: v.optional(v.string()),
  inscription: v.optional(v.string()),
  description: v.optional(v.string()),
  engraved: v.optional(v.string()),
  cooldownMs: v.optional(v.number()),
  count: v.optional(v.number()),
  contents: v.optional(
    v.array(
      v.object({
        id: v.string(),
        tileId: v.string(),
        direction: v.optional(directionSchema),
        channel: v.optional(v.string()),
        inscription: v.optional(v.string()),
        description: v.optional(v.string()),
        engraved: v.optional(v.string()),
        count: v.optional(v.number()),
      }),
    ),
  ),
});

const equipmentSchema = v.object({
  weapon: v.nullable(itemInstanceSchema),
  offhand: v.optional(v.nullable(itemInstanceSchema), null),
  armor: v.optional(v.nullable(itemInstanceSchema), null),
  head: v.optional(v.nullable(itemInstanceSchema), null),
  charm: v.optional(v.nullable(itemInstanceSchema), null),
  footwear: v.optional(v.nullable(itemInstanceSchema), null),
  bag: v.nullable(itemInstanceSchema),
});

const tolerantEquipmentSchema = v.fallback(equipmentSchema, {
  weapon: null,
  offhand: null,
  armor: null,
  head: null,
  charm: null,
  footwear: null,
  bag: null,
});

const tolerantMasteryXpSchema = v.fallback(masteryXpBlockSchema, {});

export type CellPatch = {
  x: number;
  y: number;
  z: number;
  stack: PlacedTile[];
  afflicted?: CellAffliction[];
};

export type CellAffliction = {
  tileId: string;
  defIds: string[];
};

export type NamePatch = {
  actorId: string;
  name: string;
};

export type HpPatch = {
  actorId: string;
  hp: number;
  maxHp: number;
  rating: number;
};

export type StatusPatch = {
  defId: string;
  remainingMs: number;
  durationMs: number;
};

export type CarriedLightsPatch = {
  actorId: string;
  tileIds: string[];
};

export type StatusIdsPatch = {
  actorId: string;
  defIds: string[];
};

export type PvpPatch = {
  actorId: string;
  on: boolean;
};

export type ExtractionPatch = {
  actorId: string;
  progress: ExtractionProgress | null;
};

export type CastingPatch = {
  actorId: string;
  progress: CastProgress | null;
};

export type AfflictedPatch = {
  x: number;
  y: number;
  z: number;
  tileId: string;
  defIds: string[];
};

export type MotionEvent =
  | {
      kind: "walkStarted";
      actorId: string;
      from: { x: number; y: number; z: number };
      to: { x: number; y: number; z: number };
      direction: "n" | "e" | "s" | "w";
    }
  | {
      kind: "fallStarted";
      actorId: string;
      feetAbs: number;
      landingAbs: number;
    }
  | {
      kind: "slideStarted";
      actorId: string;
      object: { x: number; y: number; z: number; stackIndex: number };
      from: { x: number; y: number; z: number };
      count: number;
    }
  | {
      kind: "strikeStarted";
      actorId: string;
      strike: StrikeKind;
      dx: number;
      dy: number;
      dElev: number;
    }
  | { kind: "teleported"; actorId: string }
  | { kind: "swung"; actorId: string }
  | { kind: "joined"; actorId: string }
  | { kind: "left"; actorId: string }
  | {
      kind: "spawned";
      actorId: string;
      at: { x: number; y: number; z: number; stackIndex: number };
    }
  | { kind: "despawned"; actorId: string }
  | {
      kind: "projectileFired";
      id: string;
      tileId: string;
      from: { x: number; y: number; elevAbs: number };
      to: { x: number; y: number; elevAbs: number };
      targetId?: string;
      hit: boolean;
    }
  | ({ kind: "tileTransition" } & TileTransitionNote)
  | {
      kind: "damage";
      id: string;
      targetId: string;
      outcome: SwingOutcome;
      amount: number;
      x: number;
      y: number;
      z: number;
      stackIndex: number;
    };

export type ServerMessage =
  | {
      type: "players";
      playerCount: number;
    }
  | {
      type: "clock";
      minutesOfDay: number;
    }
  | {
      type: "hidden";
      on: boolean;
    }
  | {
      type: "hello";
      selfId: string;
      map: unknown;
      actorIds: string[];
      playerCount?: number;
      minutesOfDay: number;
      hps: HpPatch[];
      names: NamePatch[];
      carriedLights: CarriedLightsPatch[];
      statusIds: StatusIdsPatch[];
      pvp: PvpPatch[];
      extractions: ExtractionPatch[];
      castings: CastingPatch[];
      afflicted: AfflictedPatch[];
      equipment: Equipment;
      tags: string[];
      spawnAt: Coord | null;
      extracting: Extraction | null;
      nextBlow: Progress | null;
      masteryXp: MasteryXp;
      statuses: StatusPatch[];
    }
  | {
      type: "equipment";
      equipment: Equipment;
      spellCooldowns: Record<string, number>;
    }
  | { type: "tags"; tags: string[] }
  | { type: "spawnPoint"; at: Coord }
  | { type: "conversation"; conversation: Conversation | null }
  | { type: "extracting"; extracting: Extraction | null }
  | { type: "nextBlow"; nextBlow: Progress | null }
  | { type: "notice"; text: string }
  | { type: "statuses"; statuses: StatusPatch[] }
  | { type: "masteries"; masteryXp: MasteryXp }
  | {
      type: "patch";
      cells: CellPatch[];
      events: MotionEvent[];
      hps: HpPatch[];
      names: NamePatch[];
      carriedLights: CarriedLightsPatch[];
      statusIds: StatusIdsPatch[];
      pvp: PvpPatch[];
      extractions: ExtractionPatch[];
      castings: CastingPatch[];
    }
  | {
      type: "chat";
      actorId: string;
      tileId: string;
      name: string | null;
      text: string;
      x: number;
      y: number;
      z: number;
      stackIndex: number;
    }
  | {
      type: "noise";
      id: string;
      text: string;
      x: number;
      y: number;
      z: number;
      stackIndex: number;
    }
  | { type: "stepRejected"; seq: number }
  | { type: "died"; equipment: Equipment }
  | { type: "keepalive" }
  | { type: "serverRestarting" }
  | { type: "outdated"; serverVersion: number };

export type ClientMessage =
  | {
      type: "step";
      seq: number;
      direction: "n" | "e" | "s" | "w";
      preferDescend: boolean;
    }
  | { type: "face"; direction: "n" | "e" | "s" | "w" }
  | { type: "interact"; ref: { x: number; y: number; z: number; stackIndex: number } }
  | { type: "pickUp"; ref: { x: number; y: number; z: number; stackIndex: number } }
  | { type: "equip"; ref: { x: number; y: number; z: number; stackIndex: number } }
  | { type: "moveItem"; from: SlotRef; to: SlotRef }
  | { type: "drop"; from: SlotRef; to: { x: number; y: number; z: number } }
  | { type: "consume"; from: ConsumeSource }
  | { type: "talk"; action: TalkAction }
  | {
      type: "craft";
      ref: { x: number; y: number; z: number; stackIndex: number };
      recipe: number;
    }
  | { type: "say"; text: string }
  | { type: "command"; text: string }
  | { type: "target"; actorId: string | null }
  | { type: "attackMode"; enabled: boolean }
  | { type: "pvp"; enabled: boolean }
  | { type: "hidden"; enabled: boolean }
  | { type: "cast"; slot: CastSlot }
  | { type: "cancelCast" }
  | { type: "rebirth" };

const inboundRefSchema = v.object({
  x: v.pipe(v.number(), v.integer()),
  y: v.pipe(v.number(), v.integer()),
  z: v.pipe(v.number(), v.integer()),
  stackIndex: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

const inboundSlotRefSchema = v.variant("kind", [
  v.object({ kind: v.literal("weapon") }),
  v.object({ kind: v.literal("offhand") }),
  v.object({ kind: v.literal("armor") }),
  v.object({ kind: v.literal("head") }),
  v.object({ kind: v.literal("charm") }),
  v.object({ kind: v.literal("footwear") }),
  v.object({ kind: v.literal("bag") }),
  v.object({
    kind: v.literal("contents"),
    index: v.pipe(v.number(), v.integer(), v.minValue(0)),
    of: v.optional(v.picklist(["weapon", "offhand"])),
  }),
  v.object({
    kind: v.literal("ground"),
    ref: inboundRefSchema,
    index: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
]);

const clientMessageSchema = v.variant("type", [
  v.object({
    type: v.literal("step"),
    seq: v.pipe(v.number(), v.integer(), v.minValue(0)),
    direction: directionSchema,
    preferDescend: v.boolean(),
  }),
  v.object({
    type: v.literal("face"),
    direction: directionSchema,
  }),
  v.object({
    type: v.literal("interact"),
    ref: inboundRefSchema,
  }),
  v.object({
    type: v.literal("pickUp"),
    ref: inboundRefSchema,
  }),
  v.object({
    type: v.literal("equip"),
    ref: inboundRefSchema,
  }),
  v.object({
    type: v.literal("moveItem"),
    from: inboundSlotRefSchema,
    to: inboundSlotRefSchema,
  }),
  v.object({
    type: v.literal("drop"),
    from: inboundSlotRefSchema,
    to: v.object({
      x: v.pipe(v.number(), v.integer()),
      y: v.pipe(v.number(), v.integer()),
      z: v.pipe(v.number(), v.integer()),
    }),
  }),
  v.object({
    type: v.literal("consume"),
    from: v.variant("kind", [
      v.object({ kind: v.literal("slot"), slot: inboundSlotRefSchema }),
      v.object({ kind: v.literal("floor"), ref: inboundRefSchema }),
    ]),
  }),
  v.object({
    type: v.literal("talk"),
    action: v.variant("kind", [
      v.object({ kind: v.literal("open"), ref: inboundRefSchema }),
      v.object({
        kind: v.literal("choose"),
        index: v.pipe(v.number(), v.integer(), v.minValue(0)),
      }),
      v.object({
        kind: v.literal("trade"),
        amount: v.pipe(v.number(), v.integer(), v.minValue(1)),
      }),
      v.object({ kind: v.literal("cancel") }),
      v.object({ kind: v.literal("close") }),
    ]),
  }),
  v.object({
    type: v.literal("craft"),
    ref: inboundRefSchema,
    recipe: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
  v.object({
    type: v.literal("say"),
    text: v.pipe(v.string(), v.maxLength(MAX_CHAT_RAW_LENGTH)),
  }),
  v.object({
    type: v.literal("command"),
    text: v.pipe(v.string(), v.maxLength(MAX_COMMAND_LENGTH)),
  }),
  v.object({
    type: v.literal("target"),
    actorId: v.nullable(v.pipe(v.string(), v.maxLength(MAX_ACTOR_ID_LENGTH))),
  }),
  v.object({
    type: v.literal("attackMode"),
    enabled: v.boolean(),
  }),
  v.object({
    type: v.literal("pvp"),
    enabled: v.boolean(),
  }),
  v.object({
    type: v.literal("hidden"),
    enabled: v.boolean(),
  }),
  v.object({
    type: v.literal("cast"),
    slot: castSlotSchema,
  }),
  v.object({
    type: v.literal("cancelCast"),
  }),
  v.object({
    type: v.literal("rebirth"),
  }),
]);

export function parseClientMessage(raw: string): ClientMessage | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = v.safeParse(clientMessageSchema, json);
  return parsed.success ? (parsed.output as ClientMessage) : null;
}

const serverMessageSchema = v.variant("type", [
  v.object({
    type: v.literal("hello"),
    selfId: v.string(),
    map: v.unknown(),
    actorIds: v.array(v.string()),
    playerCount: v.optional(v.number()),
    minutesOfDay: v.number(),
    hps: v.array(hpPatchSchema),
    names: v.optional(v.array(namePatchSchema), () => []),
    carriedLights: v.array(carriedLightsPatchSchema),
    statusIds: v.optional(v.array(statusIdsPatchSchema), () => []),
    pvp: v.optional(v.array(pvpPatchSchema), () => []),
    extractions: v.optional(v.array(extractionPatchSchema), () => []),
    castings: v.optional(v.array(castingPatchSchema), () => []),
    afflicted: v.optional(v.array(afflictedPatchSchema), () => []),
    equipment: tolerantEquipmentSchema,
    tags: v.array(v.string()),
    spawnAt: v.optional(v.nullable(coordSchema), () => null),
    extracting: v.optional(v.nullable(extractionSchema), () => null),
    nextBlow: v.optional(v.nullable(nextBlowSchema), () => null),
    masteryXp: tolerantMasteryXpSchema,
    statuses: v.array(statusPatchSchema),
  }),
  v.object({
    type: v.literal("equipment"),
    spellCooldowns: v.optional(v.record(v.string(), v.number()), () => ({})),
    equipment: tolerantEquipmentSchema,
  }),
  v.object({
    type: v.literal("tags"),
    tags: v.array(v.string()),
  }),
  v.object({
    type: v.literal("spawnPoint"),
    at: coordSchema,
  }),
  v.object({
    type: v.literal("conversation"),
    conversation: v.nullable(
      v.object({
        npcId: v.string(),
        tileId: v.string(),
        pc: v.array(v.pipe(v.number(), v.integer(), v.minValue(0))),
        transcript: v.array(
          v.object({ who: v.picklist(["npc", "you", "note"]), text: v.string() }),
        ),
      }),
    ),
  }),
  v.object({
    type: v.literal("extracting"),
    extracting: v.nullable(extractionSchema),
  }),
  v.object({
    type: v.literal("nextBlow"),
    nextBlow: v.nullable(nextBlowSchema),
  }),
  v.object({
    type: v.literal("notice"),
    text: v.string(),
  }),
  v.object({
    type: v.literal("clock"),
    minutesOfDay: v.number(),
  }),
  v.object({
    type: v.literal("hidden"),
    on: v.boolean(),
  }),
  v.object({
    type: v.literal("players"),
    playerCount: v.number(),
  }),
  v.object({
    type: v.literal("statuses"),
    statuses: v.array(statusPatchSchema),
  }),
  v.object({
    type: v.literal("masteries"),
    masteryXp: tolerantMasteryXpSchema,
  }),
  v.object({
    type: v.literal("patch"),
    cells: v.array(
      v.object({
        x: v.number(),
        y: v.number(),
        z: v.number(),
        stack: v.array(v.looseObject({ tileId: v.string() })),
        afflicted: v.optional(
          v.array(v.object({ tileId: v.string(), defIds: v.array(v.string()) })),
        ),
      }),
    ),
    events: v.array(
      v.variant("kind", [
        v.object({
          kind: v.literal("walkStarted"),
          actorId: v.string(),
          from: coordSchema,
          to: coordSchema,
          direction: directionSchema,
        }),
        v.object({
          kind: v.literal("fallStarted"),
          actorId: v.string(),
          feetAbs: v.number(),
          landingAbs: v.number(),
        }),
        v.object({
          kind: v.literal("slideStarted"),
          actorId: v.string(),
          object: objectRefSchema,
          from: coordSchema,
          count: v.number(),
        }),
        v.object({
          kind: v.literal("teleported"),
          actorId: v.string(),
        }),
        v.object({
          kind: v.literal("swung"),
          actorId: v.string(),
        }),
        v.object({
          kind: v.literal("strikeStarted"),
          actorId: v.string(),
          strike: v.picklist(STRIKE_KINDS),
          dx: v.number(),
          dy: v.number(),
          dElev: v.number(),
        }),
        v.object({
          kind: v.literal("projectileFired"),
          id: v.string(),
          tileId: v.string(),
          from: flightPointSchema,
          to: flightPointSchema,
          targetId: v.optional(v.string()),
          hit: v.boolean(),
        }),
        v.object({
          kind: v.literal("tileTransition"),
          id: v.string(),
          side: v.picklist(TRANSITION_SIDES),
          tileId: v.string(),
          struckBy: v.optional(v.string()),
          x: v.pipe(v.number(), v.integer()),
          y: v.pipe(v.number(), v.integer()),
          z: v.pipe(v.number(), v.integer()),
          stackIndex: v.pipe(v.number(), v.integer(), v.minValue(0)),
        }),
        v.object({
          kind: v.literal("joined"),
          actorId: v.string(),
        }),
        v.object({
          kind: v.literal("left"),
          actorId: v.string(),
        }),
        v.object({
          kind: v.literal("spawned"),
          actorId: v.string(),
          at: objectRefSchema,
        }),
        v.object({
          kind: v.literal("despawned"),
          actorId: v.string(),
        }),
        v.object({
          kind: v.literal("damage"),
          id: v.string(),
          targetId: v.string(),
          outcome: v.picklist(SWING_OUTCOMES),
          amount: v.number(),
          x: v.number(),
          y: v.number(),
          z: v.number(),
          stackIndex: v.number(),
        }),
      ]),
    ),
    hps: v.array(hpPatchSchema),
    names: v.optional(v.array(namePatchSchema), () => []),
    carriedLights: v.array(carriedLightsPatchSchema),
    statusIds: v.optional(v.array(statusIdsPatchSchema), () => []),
    pvp: v.optional(v.array(pvpPatchSchema), () => []),
    extractions: v.optional(v.array(extractionPatchSchema), () => []),
    castings: v.optional(v.array(castingPatchSchema), () => []),
  }),
  v.object({
    type: v.literal("chat"),
    actorId: v.string(),
    tileId: v.string(),
    name: v.optional(v.nullable(v.string()), () => null),
    text: v.string(),
    x: v.number(),
    y: v.number(),
    z: v.number(),
    stackIndex: v.number(),
  }),
  v.object({
    type: v.literal("noise"),
    id: v.string(),
    text: v.string(),
    x: v.number(),
    y: v.number(),
    z: v.number(),
    stackIndex: v.number(),
  }),
  v.object({
    type: v.literal("stepRejected"),
    seq: v.number(),
  }),
  v.object({
    type: v.literal("died"),
    equipment: tolerantEquipmentSchema,
  }),
  v.object({
    type: v.literal("keepalive"),
  }),
  v.object({
    type: v.literal("keepalive"),
  }),
  v.object({
    type: v.literal("serverRestarting"),
  }),
  v.object({
    type: v.literal("outdated"),
    serverVersion: v.number(),
  }),
]);

export function parseServerMessage(raw: string): ServerMessage | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = v.safeParse(serverMessageSchema, json);
  return parsed.success ? (parsed.output as ServerMessage) : null;
}

export const GAME_SOCKET_PATH = "/online/ws";

export const PROTOCOL_VERSION = 22;

export const MAX_STEPS_AHEAD = 8;

export const KEEPALIVE_INTERVAL_MS = 30_000;

export const PROTOCOL_VERSION_PARAM = "v";

export const CHARACTER_PARAM = "character";

export const CLOSE_OUTDATED_CLIENT = 4001;

export const CLOSE_REPLACED = 4002;

export const CLOSE_SIGNED_OUT = 4003;

export const CLOSE_MAINTENANCE = 4004;

export const CLOSE_WORLD_FULL = 4005;
