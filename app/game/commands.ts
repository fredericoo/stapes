import type { MinutesOfDay } from "../lib/clock";
import { MAX_CONSUMABLE_HP_SHIFT } from "../lib/item";
import { EQUIP_SLOTS, type EquipSlot } from "../lib/kit";
import { MASTERIES, MAX_MASTERY, MIN_EARNED_MASTERY, type Mastery } from "../lib/mastery";
import type { Coord } from "../lib/types";

export const COMMAND_PREFIX = "/";

export const SELF_TARGET = "self";

export const MAX_COMMAND_LENGTH = 256;

export function isCommand(text: string): boolean {
  return text.startsWith(COMMAND_PREFIX);
}

export const MASTERY_COMMAND = "mastery";
export const TILE_COMMAND = "tile";
export const STATUS_COMMAND = "status";
export const HEALTH_COMMAND = "health";
export const GOTO_COMMAND = "goto";
export const MOVE_COMMAND = "move";
export const TIME_COMMAND = "time";
export const SPAWN_COMMAND = "spawn";
export const DESPAWN_COMMAND = "despawn";
export const GIVE_COMMAND = "give";
export const BRAIN_COMMAND = "brain";
export const FIRE_COMMAND = "fire";

export const STATUS_CLEAR_ARGUMENT = "clear";
export const STATUS_OFF_ARGUMENT = "off";
export const BRAIN_OFF_ARGUMENT = "off";
export const BRAIN_ON_ARGUMENT = "on";

export type CommandName =
  | typeof MASTERY_COMMAND
  | typeof TILE_COMMAND
  | typeof STATUS_COMMAND
  | typeof HEALTH_COMMAND
  | typeof GOTO_COMMAND
  | typeof MOVE_COMMAND
  | typeof TIME_COMMAND
  | typeof SPAWN_COMMAND
  | typeof DESPAWN_COMMAND
  | typeof GIVE_COMMAND
  | typeof BRAIN_COMMAND
  | typeof FIRE_COMMAND;

export const COMMAND_USAGE: Record<CommandName, string> = {
  [MASTERY_COMMAND]: `${COMMAND_PREFIX}${MASTERY_COMMAND} <mastery> <${MIN_EARNED_MASTERY}-${MAX_MASTERY}> [player id]`,
  [TILE_COMMAND]: `${COMMAND_PREFIX}${TILE_COMMAND} <tile> [xN] [x] [y] [z]`,
  [STATUS_COMMAND]: `${COMMAND_PREFIX}${STATUS_COMMAND} <status id [${STATUS_OFF_ARGUMENT}] | ${STATUS_CLEAR_ARGUMENT}> [player id]`,
  [HEALTH_COMMAND]: `${COMMAND_PREFIX}${HEALTH_COMMAND} <n | +n | -n> [player id]`,
  [GOTO_COMMAND]: `${COMMAND_PREFIX}${GOTO_COMMAND} <x> <y> [z] [body]`,
  [MOVE_COMMAND]: `${COMMAND_PREFIX}${MOVE_COMMAND} <east> <south> [up]`,
  [TIME_COMMAND]: `${COMMAND_PREFIX}${TIME_COMMAND} <hh:mm>`,
  [SPAWN_COMMAND]: `${COMMAND_PREFIX}${SPAWN_COMMAND} <tile> <x> <y> [z]`,
  [DESPAWN_COMMAND]: `${COMMAND_PREFIX}${DESPAWN_COMMAND} <body>`,
  [GIVE_COMMAND]: `${COMMAND_PREFIX}${GIVE_COMMAND} <item> [square] [body]`,
  [BRAIN_COMMAND]: `${COMMAND_PREFIX}${BRAIN_COMMAND} <body> <${BRAIN_OFF_ARGUMENT} | ${BRAIN_ON_ARGUMENT} | state>`,
  [FIRE_COMMAND]: `${COMMAND_PREFIX}${FIRE_COMMAND} <projectile> <body | x,y[,z]> <body | x,y[,z]>`,
};

export type Coordinate = { kind: "absolute"; value: number } | { kind: "relative"; offset: number };

export type CellRequest = {
  x: Coordinate;
  y: Coordinate;
  z: Coordinate;
};

export const MAX_COMMAND_HP = MAX_CONSUMABLE_HP_SHIFT;

export type MapCell = { x: number; y: number; z: number | null };

export type Command =
  | {
      name: typeof GOTO_COMMAND;
      at: MapCell;
      target: string | null;
    }
  | {
      name: typeof MOVE_COMMAND;
      by: Coord;
    }
  | {
      name: typeof MASTERY_COMMAND;
      mastery: Mastery;
      level: number;
      target: string | null;
    }
  | {
      name: typeof TILE_COMMAND;
      tileId: string;
      count: number;
      at: CellRequest;
    }
  | {
      name: typeof STATUS_COMMAND;
      statusId: string | null;
      off: boolean;
      target: string | null;
    }
  | {
      name: typeof HEALTH_COMMAND;
      health: HealthChange;
      target: string | null;
    }
  | {
      name: typeof TIME_COMMAND;
      minutes: MinutesOfDay;
    }
  | {
      name: typeof SPAWN_COMMAND;
      tileId: string;
      at: MapCell;
    }
  | {
      name: typeof DESPAWN_COMMAND;
      target: string | null;
    }
  | {
      name: typeof GIVE_COMMAND;
      tileId: string;
      square: EquipSlot | null;
      target: string | null;
    }
  | {
      name: typeof BRAIN_COMMAND;
      target: string | null;
      change: BrainChange;
    }
  | {
      name: typeof FIRE_COMMAND;
      tileId: string;
      from: FlightEnd;
      to: FlightEnd;
    };

export type MasteryCommand = Extract<Command, { name: typeof MASTERY_COMMAND }>;
export type TileCommand = Extract<Command, { name: typeof TILE_COMMAND }>;
export type StatusCommand = Extract<Command, { name: typeof STATUS_COMMAND }>;
export type HealthCommand = Extract<Command, { name: typeof HEALTH_COMMAND }>;
export type TimeCommand = Extract<Command, { name: typeof TIME_COMMAND }>;
export type SpawnCommand = Extract<Command, { name: typeof SPAWN_COMMAND }>;
export type DespawnCommand = Extract<Command, { name: typeof DESPAWN_COMMAND }>;
export type GiveCommand = Extract<Command, { name: typeof GIVE_COMMAND }>;
export type BrainCommand = Extract<Command, { name: typeof BRAIN_COMMAND }>;

export type BrainChange = { kind: "off" } | { kind: "on" } | { kind: "state"; state: string };

export type FireCommand = Extract<Command, { name: typeof FIRE_COMMAND }>;

export type FlightEnd = { kind: "body"; target: string | null } | { kind: "cell"; at: MapCell };

/** `contents` is inside the bag; `bag` is the square the bag itself is worn in. */
export type GiveSlot = EquipSlot | "contents";

export type HealthChange = { kind: "set"; hp: number } | { kind: "shift"; by: number };

export type CommandRefusal =
  | { kind: "notAdmin" }
  | { kind: "unknownCommand"; typed: string }
  | { kind: "badArguments"; command: CommandName }
  | { kind: "unknownMastery"; typed: string }
  | { kind: "badLevel"; typed: string }
  | { kind: "badCoordinate"; typed: string }
  | { kind: "badCount"; typed: string }
  | { kind: "noSuchTarget"; typed: string }
  | { kind: "unteachableTarget"; name: string }
  | { kind: "unknownTile"; typed: string }
  | { kind: "spawnMarkerTile"; typed: string }
  | { kind: "nowhereToPlace" }
  | { kind: "noRoom"; at: Coord }
  | { kind: "unknownStatus"; typed: string; known: readonly string[] }
  | { kind: "badHealth"; typed: string }
  | { kind: "badTime"; typed: string }
  | { kind: "unharmableTarget"; name: string }
  | { kind: "immuneTarget"; name: string; status: string }
  | { kind: "notABody"; typed: string }
  | { kind: "playerBody"; name: string }
  | { kind: "notAnItem"; typed: string }
  | { kind: "unknownSquare"; typed: string }
  | { kind: "noEquipment"; name: string }
  | { kind: "wrongSquare"; item: string; slot: GiveSlot }
  | { kind: "squareTaken"; name: string; square: EquipSlot; holding: string }
  | { kind: "noBag"; name: string }
  | { kind: "bagFull"; name: string }
  | { kind: "statusAbsent"; name: string; status: string }
  | { kind: "brainless"; name: string }
  | { kind: "unknownState"; typed: string; name: string; known: readonly string[] }
  | { kind: "notAProjectile"; typed: string; known: readonly string[] };

export type CommandParse = { ok: true; command: Command } | { ok: false; refusal: CommandRefusal };

export type CommandData =
  | { command: typeof TILE_COMMAND; tileId: string; at: Coord; count: number }
  | {
      command: typeof STATUS_COMMAND;
      target: string;
      statusId: string | null;
      outcome: "acquired" | "refreshed" | "cleared" | "removed";
    }
  | { command: typeof HEALTH_COMMAND; target: string; hp: number; maxHp: number }
  | { command: typeof MASTERY_COMMAND; target: string; mastery: Mastery; level: number }
  | { command: typeof GOTO_COMMAND | typeof MOVE_COMMAND; target: string; at: Coord }
  | { command: typeof TIME_COMMAND; minutes: MinutesOfDay }
  | { command: typeof SPAWN_COMMAND; tileId: string; at: Coord }
  | { command: typeof DESPAWN_COMMAND; target: string; at: Coord }
  | {
      command: typeof GIVE_COMMAND;
      target: string;
      tileId: string;
      itemId: string;
      slot: GiveSlot;
    }
  | { command: typeof BRAIN_COMMAND; target: string; on: boolean; state: string }
  | {
      command: typeof FIRE_COMMAND;
      tileId: string;
      from: Coord;
      to: Coord;
      target: string | null;
      flightMs: number;
    };

export type CommandOutcome =
  | { ok: true; data: CommandData; ids?: readonly string[] }
  | { ok: false; refusal: CommandRefusal };

/**
 * `notice` is the sentence the author was told in the chat, and `ids` are the
 * bodies the command brought into the world, so a caller can act on them.
 */
export type CommandReply =
  | { ok: true; notice: string | null; ids: string[]; data: CommandData }
  | { ok: false; notice: string; refusal: CommandRefusal };

export function parseCommand(raw: string): CommandParse {
  const body = raw.slice(0, MAX_COMMAND_LENGTH).trim();
  if (!isCommand(body)) {
    return { ok: false, refusal: { kind: "unknownCommand", typed: body } };
  }

  const [verb = "", ...args] = body.slice(COMMAND_PREFIX.length).split(/\s+/);
  switch (verb.toLowerCase()) {
    case MASTERY_COMMAND:
      return parseMasteryArguments(args);
    case TILE_COMMAND:
      return parseTileArguments(args);
    case STATUS_COMMAND:
      return parseStatusArguments(args);
    case HEALTH_COMMAND:
      return parseHealthArguments(args);
    case GOTO_COMMAND:
      return parseGotoArguments(args);
    case MOVE_COMMAND:
      return parseMoveArguments(args);
    case TIME_COMMAND:
      return parseTimeArguments(args);
    case SPAWN_COMMAND:
      return parseSpawnArguments(args);
    case DESPAWN_COMMAND:
      return parseDespawnArguments(args);
    case GIVE_COMMAND:
      return parseGiveArguments(args);
    case BRAIN_COMMAND:
      return parseBrainArguments(args);
    case FIRE_COMMAND:
      return parseFireArguments(args);
    default:
      return {
        ok: false,
        refusal: { kind: "unknownCommand", typed: `${COMMAND_PREFIX}${verb}` },
      };
  }
}

const MIN_MASTERY_ARGUMENTS = 2;
const MAX_MASTERY_ARGUMENTS = 3;

function parseMasteryArguments(args: string[]): CommandParse {
  if (args.length < MIN_MASTERY_ARGUMENTS || args.length > MAX_MASTERY_ARGUMENTS) {
    return {
      ok: false,
      refusal: { kind: "badArguments", command: MASTERY_COMMAND },
    };
  }

  const [masteryToken = "", levelToken = "", targetToken] = args;

  const mastery = MASTERIES.find((candidate) => candidate === masteryToken.toLowerCase());
  if (!mastery) {
    return {
      ok: false,
      refusal: { kind: "unknownMastery", typed: masteryToken },
    };
  }

  const level = Number(levelToken);
  if (!Number.isInteger(level) || level < MIN_EARNED_MASTERY || level > MAX_MASTERY) {
    return { ok: false, refusal: { kind: "badLevel", typed: levelToken } };
  }

  return {
    ok: true,
    command: {
      name: MASTERY_COMMAND,
      mastery,
      level,
      target: targetOf(targetToken),
    },
  };
}

const MAX_TILE_COORDINATES = 3;

const HERE: Coordinate = { kind: "relative", offset: 0 };

function parseTileArguments(args: string[]): CommandParse {
  const [tileToken, ...rest] = args;
  const count = parseCount(rest[0]);
  const coordinateTokens = count === null ? rest : rest.slice(1);
  if (tileToken === undefined || coordinateTokens.length > MAX_TILE_COORDINATES) {
    return {
      ok: false,
      refusal: { kind: "badArguments", command: TILE_COMMAND },
    };
  }
  if (count !== null && (count < 1 || count > MAX_TILE_COUNT)) {
    return { ok: false, refusal: { kind: "badCount", typed: rest[0] ?? "" } };
  }

  const coordinates: Coordinate[] = [];
  for (const token of coordinateTokens) {
    const coordinate = parseCoordinate(token);
    if (!coordinate) {
      return { ok: false, refusal: { kind: "badCoordinate", typed: token } };
    }
    coordinates.push(coordinate);
  }

  const [x = HERE, y = HERE, z = HERE] = coordinates;
  return {
    ok: true,
    command: {
      name: TILE_COMMAND,
      tileId: tileToken.toLowerCase(),
      count: count ?? 1,
      at: { x, y, z },
    },
  };
}

export const MAX_TILE_COUNT = 999;

const COUNT_PATTERN = /^x(\d+)$/i;

function parseCount(token: string | undefined): number | null {
  const match = token === undefined ? null : COUNT_PATTERN.exec(token);
  if (!match) return null;
  return Number(match[1]);
}

const MIN_STATUS_ARGUMENTS = 1;
const MAX_STATUS_ARGUMENTS = 2;

function parseStatusArguments(args: string[]): CommandParse {
  const [statusToken = "", second, third] = args;
  const clearing = statusToken.toLowerCase() === STATUS_CLEAR_ARGUMENT;
  const off = !clearing && second?.toLowerCase() === STATUS_OFF_ARGUMENT;
  const most = off ? MAX_STATUS_ARGUMENTS + 1 : MAX_STATUS_ARGUMENTS;
  if (args.length < MIN_STATUS_ARGUMENTS || args.length > most) {
    return {
      ok: false,
      refusal: { kind: "badArguments", command: STATUS_COMMAND },
    };
  }

  return {
    ok: true,
    command: {
      name: STATUS_COMMAND,
      statusId: clearing ? null : statusToken,
      off,
      target: targetOf(off ? third : second),
    },
  };
}

const MIN_HEALTH_ARGUMENTS = 1;
const MAX_HEALTH_ARGUMENTS = 2;

const HEALTH_PATTERN = /^[+-]?\d+$/;

function parseHealthArguments(args: string[]): CommandParse {
  if (args.length < MIN_HEALTH_ARGUMENTS || args.length > MAX_HEALTH_ARGUMENTS) {
    return {
      ok: false,
      refusal: { kind: "badArguments", command: HEALTH_COMMAND },
    };
  }

  const [amountToken = "", targetToken] = args;
  if (!HEALTH_PATTERN.test(amountToken)) {
    return { ok: false, refusal: { kind: "badHealth", typed: amountToken } };
  }

  const magnitude = Number(amountToken);
  if (Math.abs(magnitude) > MAX_COMMAND_HP) {
    return { ok: false, refusal: { kind: "badHealth", typed: amountToken } };
  }

  const signed = amountToken.startsWith("+") || amountToken.startsWith("-");
  return {
    ok: true,
    command: {
      name: HEALTH_COMMAND,
      health: signed ? { kind: "shift", by: magnitude } : { kind: "set", hp: magnitude },
      target: targetOf(targetToken),
    },
  };
}

const COORDINATE_PATTERN = /^([+-]?)(\d+)$/;

function parseCoordinate(token: string): Coordinate | null {
  const match = COORDINATE_PATTERN.exec(token);
  if (!match) return null;

  const [, sign = "", digits = ""] = match;
  const magnitude = Number(digits);
  if (!Number.isSafeInteger(magnitude)) return null;
  if (sign === "") return { kind: "absolute", value: magnitude };
  return { kind: "relative", offset: sign === "-" ? -magnitude : magnitude };
}

function parseOffsets(
  args: string[],
  command: CommandName,
): { ok: true; values: number[] } | { ok: false; refusal: CommandRefusal } {
  if (args.length < 2 || args.length > 3) {
    return { ok: false, refusal: { kind: "badArguments", command } };
  }

  const values: number[] = [];
  for (const token of args) {
    const match = COORDINATE_PATTERN.exec(token);
    const magnitude = match ? Number(match[2]) : Number.NaN;
    if (!match || !Number.isSafeInteger(magnitude)) {
      return { ok: false, refusal: { kind: "badCoordinate", typed: token } };
    }
    values.push(match[1] === "-" ? -magnitude : magnitude);
  }
  return { ok: true, values };
}

function parseGotoArguments(args: string[]): CommandParse {
  const last = args.at(-1);
  const named = last !== undefined && !COORDINATE_PATTERN.test(last);
  const parsed = parseCell(named ? args.slice(0, -1) : args, GOTO_COMMAND);
  if (!parsed.ok) return parsed;

  return {
    ok: true,
    command: { name: GOTO_COMMAND, at: parsed.at, target: named ? targetOf(last) : null },
  };
}

function parseCell(
  args: string[],
  command: CommandName,
): { ok: true; at: MapCell } | { ok: false; refusal: CommandRefusal } {
  const parsed = parseOffsets(args, command);
  if (!parsed.ok) return parsed;

  const [x, y, z] = parsed.values;
  return { ok: true, at: { x: x!, y: y!, z: z ?? null } };
}

function parseMoveArguments(args: string[]): CommandParse {
  const parsed = parseOffsets(args, MOVE_COMMAND);
  if (!parsed.ok) return parsed;

  const [x, y, z] = parsed.values;
  return { ok: true, command: { name: MOVE_COMMAND, by: { x: x!, y: y!, z: z ?? 0 } } };
}

function parseSpawnArguments(args: string[]): CommandParse {
  const [tileToken, ...cell] = args;
  if (tileToken === undefined) {
    return { ok: false, refusal: { kind: "badArguments", command: SPAWN_COMMAND } };
  }
  const parsed = parseCell(cell, SPAWN_COMMAND);
  if (!parsed.ok) return parsed;

  return {
    ok: true,
    command: { name: SPAWN_COMMAND, tileId: tileToken.toLowerCase(), at: parsed.at },
  };
}

function parseDespawnArguments(args: string[]): CommandParse {
  if (args.length !== 1) {
    return { ok: false, refusal: { kind: "badArguments", command: DESPAWN_COMMAND } };
  }
  return { ok: true, command: { name: DESPAWN_COMMAND, target: targetOf(args[0]) } };
}

const MIN_GIVE_ARGUMENTS = 1;
const MAX_GIVE_ARGUMENTS = 3;

function parseGiveArguments(args: string[]): CommandParse {
  if (args.length < MIN_GIVE_ARGUMENTS || args.length > MAX_GIVE_ARGUMENTS) {
    return { ok: false, refusal: { kind: "badArguments", command: GIVE_COMMAND } };
  }

  const [itemToken = "", second, third] = args;
  const square = second === undefined ? null : squareOf(second);
  if (third !== undefined && square === null) {
    return { ok: false, refusal: { kind: "unknownSquare", typed: second ?? "" } };
  }

  return {
    ok: true,
    command: {
      name: GIVE_COMMAND,
      tileId: itemToken.toLowerCase(),
      square,
      target: targetOf(third ?? (square === null ? second : undefined)),
    },
  };
}

function squareOf(token: string): EquipSlot | null {
  return EQUIP_SLOTS.find((square) => square === token.toLowerCase()) ?? null;
}

function parseBrainArguments(args: string[]): CommandParse {
  if (args.length !== 2) {
    return { ok: false, refusal: { kind: "badArguments", command: BRAIN_COMMAND } };
  }

  const [bodyToken, word = ""] = args;
  return {
    ok: true,
    command: { name: BRAIN_COMMAND, target: targetOf(bodyToken), change: brainChangeOf(word) },
  };
}

function brainChangeOf(word: string): BrainChange {
  const lower = word.toLowerCase();
  if (lower === BRAIN_OFF_ARGUMENT) return { kind: "off" };
  if (lower === BRAIN_ON_ARGUMENT) return { kind: "on" };
  return { kind: "state", state: word };
}

function parseFireArguments(args: string[]): CommandParse {
  const [tileToken, fromToken, toToken] = args;
  if (args.length !== 3 || !tileToken || !fromToken || !toToken) {
    return { ok: false, refusal: { kind: "badArguments", command: FIRE_COMMAND } };
  }

  return {
    ok: true,
    command: {
      name: FIRE_COMMAND,
      tileId: tileToken.toLowerCase(),
      from: flightEndOf(fromToken),
      to: flightEndOf(toToken),
    },
  };
}

const CELL_PATTERN = /^([+-]?\d+),([+-]?\d+)(?:,([+-]?\d+))?$/;

function flightEndOf(token: string): FlightEnd {
  const match = CELL_PATTERN.exec(token);
  if (!match) return { kind: "body", target: targetOf(token) };
  const [, x = "", y = "", z] = match;
  return {
    kind: "cell",
    at: { x: Number(x), y: Number(y), z: z === undefined ? null : Number(z) },
  };
}

const TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;

const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;

function parseTimeArguments(args: string[]): CommandParse {
  if (args.length !== 1) {
    return { ok: false, refusal: { kind: "badArguments", command: TIME_COMMAND } };
  }

  const [token = ""] = args;
  const match = TIME_PATTERN.exec(token);
  const hours = match ? Number(match[1]) : Number.NaN;
  const minutes = match ? Number(match[2]) : Number.NaN;
  if (!(hours < HOURS_PER_DAY && minutes < MINUTES_PER_HOUR)) {
    return { ok: false, refusal: { kind: "badTime", typed: token } };
  }

  return {
    ok: true,
    command: { name: TIME_COMMAND, minutes: hours * MINUTES_PER_HOUR + minutes },
  };
}

export function resolveCell(at: CellRequest, from: Coord): Coord {
  return {
    x: resolveCoordinate(at.x, from.x),
    y: resolveCoordinate(at.y, from.y),
    z: resolveCoordinate(at.z, from.z),
  };
}

function resolveCoordinate(coordinate: Coordinate, origin: number): number {
  return coordinate.kind === "absolute" ? coordinate.value : origin + coordinate.offset;
}

function targetOf(token: string | undefined): string | null {
  return token === undefined || token.toLowerCase() === SELF_TARGET ? null : token;
}
