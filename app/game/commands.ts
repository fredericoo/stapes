import { MAX_CONSUMABLE_HP_SHIFT } from "../lib/item";
import {
  MASTERIES,
  MAX_MASTERY,
  MIN_MASTERY,
  type Mastery,
} from "../lib/mastery";
import type { Coord } from "../lib/types";

/**
 * Things typed into the chat field that are instructions rather than speech.
 *
 * **A slash is the whole of the distinction**, and it is drawn here rather than
 * anywhere else so that both ends agree without either having to know what the
 * commands are: the client sends a `command` frame instead of a `say` frame, and
 * the server never broadcasts a bubble it would then have to take back. Deciding
 * it at the point of broadcast instead — server sees a slash, swallows the
 * message — would work, but it would put a rule about *what a player meant* in
 * the middle of the fan-out, and a bug there is a private line said out loud.
 *
 * ## Nobody is checked
 *
 * These are admin commands with no admin: any connected player may run any of
 * them, on themselves or on anybody else. That is deliberate for now and it is
 * the first thing that has to change before this world is anything but a
 * playground — the shape here is ready for it, because a command is parsed into
 * a request before anything acts on it, and a permission check is one gate at
 * the point of acting.
 *
 * ## Parsing says what it could not understand, and stops there
 *
 * A refusal travels as a {@link CommandRefusal} rather than as prose, because
 * this module knows the grammar and `./notices` knows how the game talks. The
 * split is what keeps every sentence the player reads in one file — see the
 * notice notes in `docs/notes.md` — while leaving the reasons something failed
 * enumerable, and therefore testable, here.
 *
 * **Every failure has a reason, and the reason is the point.** A command that
 * quietly does nothing is indistinguishable from a command that was dropped on
 * the way, which is the same argument every other refusal in this game is
 * written under.
 */

/** What tells an instruction from a thing somebody said. */
export const COMMAND_PREFIX = "/";

/** The target that means "the body that typed this". */
export const SELF_TARGET = "self";

/**
 * The most a command may be, in characters.
 *
 * Generous next to a chat line, because a target is a uuid and a uuid is 36
 * characters of the budget on its own. It exists at all for the reason the chat
 * cap does: the socket is the boundary, and a client must not be able to hand
 * the parser something unbounded to walk.
 */
export const MAX_COMMAND_LENGTH = 256;

/** Whether this is an instruction rather than something to say out loud. */
export function isCommand(text: string): boolean {
  return text.startsWith(COMMAND_PREFIX);
}

export const MASTERY_COMMAND = "mastery";
export const TILE_COMMAND = "tile";
export const STATUS_COMMAND = "status";
export const HEALTH_COMMAND = "health";

/** The argument that takes everything off instead of putting something on. */
export const STATUS_CLEAR_ARGUMENT = "clear";

/** Every verb this module knows, which is every verb there is. */
export type CommandName =
  | typeof MASTERY_COMMAND
  | typeof TILE_COMMAND
  | typeof STATUS_COMMAND
  | typeof HEALTH_COMMAND;

/**
 * How each command is written, in one place.
 *
 * Shown back to whoever got it wrong, so it is the documentation as well as the
 * grammar — which is why it lives beside the parser that implements it rather
 * than in the sentence that quotes it. Keyed by verb rather than exported one
 * constant at a time so that a refusal can carry *which* command was misspelt
 * and the sentence can look up the line without a switch of its own.
 */
export const COMMAND_USAGE: Record<CommandName, string> = {
  [MASTERY_COMMAND]: `${COMMAND_PREFIX}${MASTERY_COMMAND} <mastery> <${MIN_MASTERY}-${MAX_MASTERY}> [player id]`,
  // The count is written `x12` and comes first because it is the one
  // argument that cannot be told from a coordinate by position alone.
  [TILE_COMMAND]: `${COMMAND_PREFIX}${TILE_COMMAND} <tile> [xN] [x] [y] [z]`,
  // `clear` is part of the grammar rather than a second verb, because it is the
  // same sentence with the same target and only the thing being put on differs.
  // A debugging command that can only be switched *on* is a poor one: tuning
  // what a burn looks like means seeing it start, and then not having to wait
  // half a minute to see it start again.
  [STATUS_COMMAND]: `${COMMAND_PREFIX}${STATUS_COMMAND} <status id | ${STATUS_CLEAR_ARGUMENT}> [player id]`,
  // The sign is the whole grammar, and it is the reason this is one command
  // rather than three: `50` is a place to put somebody, `+10` and `-10` are
  // things to do to them, and somebody debugging a fight wants both without
  // learning two verbs.
  [HEALTH_COMMAND]: `${COMMAND_PREFIX}${HEALTH_COMMAND} <n | +n | -n> [player id]`,
};

/**
 * Where a command was pointed, before anything has looked at the board.
 *
 * A coordinate is *typed* one of two ways and the sign is the whole of the
 * difference: `3` is the third column of the map and `+3` is three columns from
 * wherever you are standing. Kept as the distinction the player made rather
 * than resolved here, because resolving needs an origin and the parser has no
 * business knowing where anybody is — see {@link resolveCell}, which is handed
 * one.
 *
 * The cost of spelling it this way is that an *absolute* negative cannot be
 * written: `-1` is a step back, so column -1 and level -1 are reachable only by
 * offset. That is the trade the sign buys, and the offsets are what an admin
 * standing in the world actually types.
 */
export type Coordinate =
  | { kind: "absolute"; value: number }
  | { kind: "relative"; offset: number };

/** A cell named on all three axes, each independently absolute or relative. */
export type CellRequest = {
  x: Coordinate;
  y: Coordinate;
  z: Coordinate;
};

/**
 * The most hit points one command may name.
 *
 * A sanity bound rather than a balance one, borrowed from the figure a
 * consumable is allowed to move — the two are the same kind of number, and a
 * second answer to "how big can a hit point figure be" is a second thing to keep
 * in step.
 */
export const MAX_COMMAND_HP = MAX_CONSUMABLE_HP_SHIFT;

/**
 * A command that parsed, with everything it needs to be carried out.
 *
 * A request rather than an action: nothing here has looked at the world, so a
 * target is still only an id somebody typed and a tile is still only a key.
 * Whether anybody answers to it — and whether the catalogue holds that tile —
 * is the session's question, and it is asked once, where the world is.
 */
export type Command =
  | {
      name: typeof MASTERY_COMMAND;
      mastery: Mastery;
      level: number;
      /** Null for the body that typed it — either `self` or nothing at all. */
      target: string | null;
    }
  | {
      name: typeof TILE_COMMAND;
      /**
       * The key of the tile to put down, lowercased.
       *
       * Not checked against anything: the catalogue is world data the parser
       * has never been handed, so "there is no tile called that" is a sentence
       * only the session is in a position to say.
       */
      tileId: string;
      /**
       * How many to put down, one unless a `x12` was typed.
       *
       * A number of *placements* rather than a pile size — see
       * {@link MAX_TILE_COUNT} — so it means the same thing for a shard and for
       * a crate, and the session does not have to know which it got.
       */
      count: number;
      at: CellRequest;
    }
  | {
      name: typeof STATUS_COMMAND;
      /**
       * The status to put on, or null to take everything off.
       *
       * Not checked against a catalogue here either, and for the reason
       * {@link TileCommand}'s `tileId` is not: a status id names an entry in a
       * file the world loaded, which this module has never seen.
       */
      statusId: string | null;
      /** Null for the body that typed it — either `self` or nothing at all. */
      target: string | null;
    }
  | {
      name: typeof HEALTH_COMMAND;
      health: HealthChange;
      /** Null for the body that typed it — either `self` or nothing at all. */
      target: string | null;
    };

export type MasteryCommand = Extract<Command, { name: typeof MASTERY_COMMAND }>;
export type TileCommand = Extract<Command, { name: typeof TILE_COMMAND }>;
export type StatusCommand = Extract<Command, { name: typeof STATUS_COMMAND }>;
export type HealthCommand = Extract<Command, { name: typeof HEALTH_COMMAND }>;

/**
 * What a health command asks for.
 *
 * Two shapes rather than one signed number, because "put them at 10" and "take
 * 10 off them" are different requests that a bare `10` cannot tell apart — and
 * the session answers them differently: a shift downwards goes through the same
 * damage a blow does, and a set is worked out against a maximum first.
 */
export type HealthChange =
  | { kind: "set"; hp: number }
  /** Signed: positive heals, negative harms. */
  | { kind: "shift"; by: number };

/**
 * Why a command did not happen.
 *
 * Both halves of the journey are in one union: the parser's failures and the
 * session's sit together, because "that is not a mastery" and "nobody by that
 * name is here" are the same kind of answer to the player and differ only in
 * which module was in a position to notice.
 */
export type CommandRefusal =
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
  /** The summoner has no body, so there is no "here" to place anything near. */
  | { kind: "nowhereToPlace" }
  | { kind: "noRoom"; at: Coord }
  // From the session rather than the parser — the catalogue is the world's.
  // The known ids ride along so the answer names the alternatives, the way the
  // mastery refusal does.
  | { kind: "unknownStatus"; typed: string; known: readonly string[] }
  | { kind: "badHealth"; typed: string }
  /** A body with no hit points to move — a crate, a sign, a tuft of grass. */
  | { kind: "unharmableTarget"; name: string };

export type CommandParse =
  | { ok: true; command: Command }
  | { ok: false; refusal: CommandRefusal };

/**
 * Read a typed line as a command, or say what stopped it.
 *
 * Hand-rolled rather than handed to valibot, which is otherwise this codebase's
 * answer at a runtime boundary. A schema's job is to answer *whether* a value is
 * acceptable, and every failure here has to answer *why* in words a player can
 * act on — "there is no blad mastery" and "a mastery is a whole number from 0 to
 * 100" are different sentences reached from what is essentially one union
 * member. The frame itself is still schema-checked, on the wire, where the
 * question genuinely is whether it is a string of bounded length.
 *
 * Whitespace is collapsed rather than counted, so a double space between
 * arguments is not a syntax error. Nobody typing into a game meant it.
 *
 * The verb is read here and its arguments nowhere near here, so that adding a
 * command is a function rather than another arm of a growing branch.
 */
export function parseCommand(raw: string): CommandParse {
  const body = raw.slice(0, MAX_COMMAND_LENGTH).trim();
  if (!isCommand(body)) {
    return { ok: false, refusal: { kind: "unknownCommand", typed: body } };
  }

  const [verb = "", ...args] = body.slice(COMMAND_PREFIX.length).split(/\s+/);
  // Lowercased because a command is typed, not aimed: "/Mastery" at the start of
  // a sentence is the phone's doing rather than the player's.
  switch (verb.toLowerCase()) {
    case MASTERY_COMMAND:
      return parseMasteryArguments(args);
    case TILE_COMMAND:
      return parseTileArguments(args);
    case STATUS_COMMAND:
      return parseStatusArguments(args);
    case HEALTH_COMMAND:
      return parseHealthArguments(args);
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
  // The target is the one optional argument, so anything past it is a typo
  // rather than a command with something extra on the end.
  if (
    args.length < MIN_MASTERY_ARGUMENTS ||
    args.length > MAX_MASTERY_ARGUMENTS
  ) {
    return {
      ok: false,
      refusal: { kind: "badArguments", command: MASTERY_COMMAND },
    };
  }

  const [masteryToken = "", levelToken = "", targetToken] = args;

  const mastery = MASTERIES.find(
    (candidate) => candidate === masteryToken.toLowerCase(),
  );
  if (!mastery) {
    return {
      ok: false,
      refusal: { kind: "unknownMastery", typed: masteryToken },
    };
  }

  // `Number` rather than `parseInt`, which reads "10abc" as ten and would set a
  // mastery off the back of a line the player mistyped.
  const level = Number(levelToken);
  if (!Number.isInteger(level) || level < MIN_MASTERY || level > MAX_MASTERY) {
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

/** One axis per coordinate, and there are three axes. */
const MAX_TILE_COORDINATES = 3;

/**
 * The coordinate an axis takes when nobody named it: wherever the summoner is.
 *
 * Which is what makes `/tile apple +1` mean "one east of me, same row, same
 * level" without the grammar having a second shape for a partly-named cell.
 */
const HERE: Coordinate = { kind: "relative", offset: 0 };

/**
 * A tile to put down, and up to three coordinates saying where.
 *
 * Naming no coordinates at all is the common case and means "here", which the
 * session reads as *underfoot* rather than on top of the stack — see
 * `GameSession.runTileCommand`. Nothing in the grammar says so, because where a
 * thing lands in a stack is a fact about bodies standing in it.
 */
function parseTileArguments(args: string[]): CommandParse {
  const [tileToken, ...rest] = args;
  const count = parseCount(rest[0]);
  // A count is not a coordinate, so a line that opens with one has a token
  // fewer left to spend on axes.
  const coordinateTokens = count === null ? rest : rest.slice(1);
  if (
    tileToken === undefined ||
    coordinateTokens.length > MAX_TILE_COORDINATES
  ) {
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
    // Lowercased on the same grounds the verb is: tile keys are kebab-case and
    // a phone capitalises the word after a space as readily as the first one.
    command: {
      name: TILE_COMMAND,
      tileId: tileToken.toLowerCase(),
      count: count ?? 1,
      at: { x, y, z },
    },
  };
}

/**
 * The most one `/tile` may put down at once.
 *
 * A sanity bound rather than a balance one, on {@link MAX_COMMAND_HP}'s terms:
 * wide enough for the case this exists for — a hundred shards to test a price
 * with — and narrow enough that a typo'd fourth digit reads as malformed rather
 * than as a command that spends a second filling a cell.
 *
 * Deliberately not a pile's ceiling. A count is *how many times the command
 * runs*, not how big a pile it makes: a hundred shards is a full pile of
 * ninety-nine and one beside it, and a hundred crates is a hundred crates until
 * the cell runs out of room.
 */
export const MAX_TILE_COUNT = 999;

/**
 * How many of it, written `x12` and only ever first.
 *
 * Null for a token that is not one, which is how the caller tells "no count
 * was given" from "a count was given and it is out of range" — the first falls
 * through to the coordinates, the second is a refusal naming the word.
 *
 * **`x` cannot collide with a coordinate**, which is what lets the two share a
 * position: {@link COORDINATE_PATTERN} takes digits with an optional sign and
 * nothing else, so no coordinate anybody could type starts with a letter. That
 * is also why the count has to be first — `/tile apple +1 x5` would otherwise
 * need the parser to decide whether a trailing token is a third axis or a
 * quantity, and there is no reading of `x5` that makes it an axis. It is
 * refused as the coordinate it is standing in the place of.
 */
const COUNT_PATTERN = /^x(\d+)$/i;

function parseCount(token: string | undefined): number | null {
  const match = token === undefined ? null : COUNT_PATTERN.exec(token);
  if (!match) return null;
  // Whatever it says, in range or not: a `x0` or a `x100000` is a count that
  // was typed, and the caller owes it a sentence rather than a fallback. A
  // digit string too long to be a number lands on Infinity and fails the same
  // range check.
  return Number(match[1]);
}

/** The id is required; the target is the one optional argument. */
const MIN_STATUS_ARGUMENTS = 1;
const MAX_STATUS_ARGUMENTS = 2;

/**
 * `/status <id|clear> [player]`.
 *
 * The id keeps the case it was typed in, unlike a mastery and unlike a tile: a
 * status id is an authored key rather than a word from a list this module owns,
 * and lower-casing it would quietly refuse a perfectly good `Poison` that
 * somebody chose to write that way. Only `clear` — this module's own word — is
 * matched case-insensitively.
 */
function parseStatusArguments(args: string[]): CommandParse {
  if (
    args.length < MIN_STATUS_ARGUMENTS ||
    args.length > MAX_STATUS_ARGUMENTS
  ) {
    return {
      ok: false,
      refusal: { kind: "badArguments", command: STATUS_COMMAND },
    };
  }

  const [statusToken = "", targetToken] = args;
  const clearing = statusToken.toLowerCase() === STATUS_CLEAR_ARGUMENT;

  return {
    ok: true,
    command: {
      name: STATUS_COMMAND,
      statusId: clearing ? null : statusToken,
      target: targetOf(targetToken),
    },
  };
}

/** The figure is required; the target is the one optional argument. */
const MIN_HEALTH_ARGUMENTS = 1;
const MAX_HEALTH_ARGUMENTS = 2;

/**
 * A whole number of hit points, with an optional leading sign.
 *
 * Anchored at both ends on the terms {@link COORDINATE_PATTERN} is: `Number`
 * alone accepts "1e3", " 10 " and "0x10", none of which anybody typed on
 * purpose, and one of them is a thousand hit points.
 */
const HEALTH_PATTERN = /^[+-]?\d+$/;

/**
 * `/health <n|+n|-n> [player]`.
 *
 * The sign is read off the **text**, not off the number, and it has to be:
 * `Number("+10")` and `Number("10")` are the same ten, and the difference
 * between them is the whole difference between healing somebody and moving them.
 * The same trick the tile command's coordinates turn on.
 */
function parseHealthArguments(args: string[]): CommandParse {
  if (
    args.length < MIN_HEALTH_ARGUMENTS ||
    args.length > MAX_HEALTH_ARGUMENTS
  ) {
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
      health: signed
        ? { kind: "shift", by: magnitude }
        : { kind: "set", hp: magnitude },
      target: targetOf(targetToken),
    },
  };
}

/**
 * A whole number, with the sign — and only the sign — making it an offset.
 *
 * Anchored at both ends, so "1.5", "1e3" and "12px" are refused rather than
 * read as twelve. The magnitude is bounded by what a number can represent
 * exactly, because a coordinate that has already lost precision names a cell
 * nobody typed.
 */
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

/**
 * The cell a request names, given where the body that typed it is standing.
 *
 * Here rather than in the session because it is the other half of the grammar:
 * what `+1` *means* is settled in the file that decided `+1` was a thing anyone
 * could type, and the session's business is only which body the origin comes
 * from.
 */
export function resolveCell(at: CellRequest, from: Coord): Coord {
  return {
    x: resolveCoordinate(at.x, from.x),
    y: resolveCoordinate(at.y, from.y),
    z: resolveCoordinate(at.z, from.z),
  };
}

function resolveCoordinate(coordinate: Coordinate, origin: number): number {
  return coordinate.kind === "absolute"
    ? coordinate.value
    : origin + coordinate.offset;
}

/** `self` and an absent argument are the same request: whoever typed it. */
function targetOf(token: string | undefined): string | null {
  return token === undefined || token.toLowerCase() === SELF_TARGET
    ? null
    : token;
}
