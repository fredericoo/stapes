import {
  MASTERIES,
  MAX_MASTERY,
  MIN_MASTERY,
  type Mastery,
} from "../lib/mastery";

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
 * notice notes in `AGENTS.md` — while leaving the reasons something failed
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

/**
 * How the mastery command is written, in one place.
 *
 * Shown back to whoever got it wrong, so it is the documentation as well as the
 * grammar — which is why it lives beside the parser that implements it rather
 * than in the sentence that quotes it.
 */
export const MASTERY_COMMAND_USAGE = `${COMMAND_PREFIX}${MASTERY_COMMAND} <mastery> <${MIN_MASTERY}-${MAX_MASTERY}> [player id]`;

/**
 * A command that parsed, with everything it needs to be carried out.
 *
 * A request rather than an action: nothing here has looked at the world, so a
 * target is still only an id somebody typed. Whether anybody answers to it is
 * the session's question, and it is asked once, where the actors are.
 */
export type Command = {
  name: typeof MASTERY_COMMAND;
  mastery: Mastery;
  level: number;
  /** Null for the body that typed it — either `self` or nothing at all. */
  target: string | null;
};

/**
 * Why a command did not happen.
 *
 * Both halves of the journey are in one union: the first three come out of the
 * parser and the last two out of the session, because "that is not a mastery"
 * and "nobody by that name is here" are the same kind of answer to the player
 * and differ only in which module was in a position to notice.
 */
export type CommandRefusal =
  | { kind: "unknownCommand"; typed: string }
  | { kind: "badArguments" }
  | { kind: "unknownMastery"; typed: string }
  | { kind: "badLevel"; typed: string }
  | { kind: "noSuchTarget"; typed: string }
  | { kind: "unteachableTarget"; name: string };

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
 */
export function parseCommand(raw: string): CommandParse {
  const body = raw.slice(0, MAX_COMMAND_LENGTH).trim();
  if (!isCommand(body)) {
    return { ok: false, refusal: { kind: "unknownCommand", typed: body } };
  }

  const [verb = "", ...args] = body.slice(COMMAND_PREFIX.length).split(/\s+/);
  // Lowercased because a command is typed, not aimed: "/Mastery" at the start of
  // a sentence is the phone's doing rather than the player's.
  if (verb.toLowerCase() !== MASTERY_COMMAND) {
    return {
      ok: false,
      refusal: { kind: "unknownCommand", typed: `${COMMAND_PREFIX}${verb}` },
    };
  }

  // The target is the one optional argument, so anything past it is a typo
  // rather than a command with something extra on the end.
  if (args.length < 2 || args.length > 3) {
    return { ok: false, refusal: { kind: "badArguments" } };
  }

  const [masteryToken, levelToken, targetToken] = args;

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

  const target =
    targetToken === undefined || targetToken.toLowerCase() === SELF_TARGET
      ? null
      : targetToken;

  return {
    ok: true,
    command: { name: MASTERY_COMMAND, mastery, level, target },
  };
}
