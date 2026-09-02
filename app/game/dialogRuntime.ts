import {
  anchorPath,
  clampAmount,
  commandAt,
  listAt,
  type CommandPath,
  type DialogCommand,
  type DialogDef,
  type DialogTrade,
  type TradeSide,
} from "../lib/dialog";
import { NOBODY } from "./brainRuntime";

/**
 * One player running one NPC's script, a press at a time.
 *
 * An interpreter over `DialogDef.script`: it runs commands from the counter
 * until one that has to wait for the player — `choices`, `request_trade` —
 * or the end, and a press resumes it. Pure functions over (script, where the
 * conversation is, what was pressed), so a test can drive a whole talk
 * without a session and the editor can run the same functions against a
 * pretend kit. Nothing here knows how a press reached the server or how a
 * line reaches a panel.
 *
 * The state is the *player's* — see `Conversation` — which is what lets any
 * number of people talk to one salesman at once. Whether they are still near
 * enough to is the session's question, asked every tick; this module only
 * answers what a press does.
 */

/**
 * What a player may do to a conversation: open one, press a choice, take or
 * refuse a trade, or close the panel. The `talk` message's payload — see
 * `../net/protocol` — and `GameSession.talk`'s argument, so the wire and the
 * local session take the same verb.
 */
export type TalkAction =
  | { kind: "open"; ref: { x: number; y: number; z: number; stackIndex: number } }
  | { kind: "choose"; index: number }
  | { kind: "trade"; amount: number }
  | { kind: "cancel" }
  | { kind: "close" };

/**
 * One line of the transcript: who, and what.
 *
 * `npc` is a `say`; `you` is a choice pressed, in the button's own words;
 * `note` is something that happened rather than something said — a trade
 * going through, or refused.
 */
export type TranscriptEntry = { who: "npc" | "you" | "note"; text: string };

/**
 * Where one player is in one NPC's script, and everything said so far.
 *
 * `pc` is a `CommandPath` to the command the script is waiting on — or, once
 * the script has run out, a path nothing is at. The panel draws the
 * transcript in full and the controls the waiting command needs; there is no
 * "current line", because every line stays.
 */
export type Conversation = {
  npcId: string;
  /**
   * The NPC's tile, so the panel can draw the body and read its script off
   * the catalogue it already holds — the script is never on the wire.
   */
  tileId: string;
  pc: number[];
  transcript: TranscriptEntry[];
};

/** What a command asks a partner to do, once every number in it is known. */
export type DialogEffectDef =
  | { effect: "trade"; take: TradeSide[]; give: TradeSide[] }
  | { effect: "add_status"; statusId: string }
  | { effect: "remove_status"; statusId: string }
  | { effect: "tag"; tag: string };

/**
 * What the script may ask of the partner — `BrainContext` with the legs cut
 * off, and the partner already chosen. The session builds one per
 * conversation.
 */
export type PartnerView = {
  /** The partner's name, or null once they are gone. */
  name(): string | null;
  /**
   * Run these effects on the partner, all or none. False when any of them
   * cannot be — and then nothing has changed.
   */
  attempt(effects: readonly DialogEffectDef[]): boolean;
};

/**
 * The most commands run between two presses.
 *
 * A `goto` to an anchor above it with no wait between is a script that never
 * comes back to the player. The lint cannot see every such loop, so the
 * interpreter stops, which reads as the script ending — and an author who
 * wrote one finds out the moment they try it.
 */
export const MAX_STEPS_PER_PRESS = 200;

/** What the transcript says when a trade the panel offered did not go through. */
export const TRADE_REFUSED = "That trade did not go through.";

/** What the transcript says for the player when they refuse a trade. */
export const CANCEL_LABEL = "Cancel";

/** Talk pressed: run from the top until something waits. */
export function openConversation(
  dialog: DialogDef,
  npc: { id: string; tileId: string },
  view: PartnerView,
): Conversation {
  return run(dialog, { npcId: npc.id, tileId: npc.tileId, pc: [0], transcript: [] }, view);
}

/** The command the conversation is waiting on, or null once it has ended. */
export function waitingOn(
  dialog: DialogDef,
  conversation: Conversation,
): Extract<DialogCommand, { kind: "choices" }> | DialogTrade | null {
  const command = commandAt(dialog, conversation.pc);
  if (command?.kind === "choices" || command?.kind === "request_trade") return command;
  return null;
}

/**
 * A choice pressed, by its position among the buttons on offer.
 *
 * Null when the script is not waiting on choices, or for a position nothing
 * is at — a stale panel, or a client making it up — and the caller leaves the
 * conversation as it was.
 */
export function chooseOption(
  dialog: DialogDef,
  conversation: Conversation,
  index: number,
  view: PartnerView,
): Conversation | null {
  const waiting = waitingOn(dialog, conversation);
  if (waiting?.kind !== "choices") return null;
  const option = waiting.options[index];
  if (!option) return null;
  const said = [...conversation.transcript, { who: "you" as const, text: option.label }];
  return run(dialog, { ...conversation, pc: [...conversation.pc, index, 0], transcript: said }, view);
}

/**
 * Trade pressed, for so many units.
 *
 * The plan is run against the partner in full; a refusal — the client's
 * preview was a round trip old, or a client making it up — leaves the script
 * waiting where it was with a note in the transcript, and nothing changed.
 */
export function acceptTrade(
  dialog: DialogDef,
  conversation: Conversation,
  requestedAmount: number,
  view: PartnerView,
): Conversation | null {
  const waiting = waitingOn(dialog, conversation);
  if (waiting?.kind !== "request_trade") return null;
  const amount = clampAmount(waiting, requestedAmount);
  const done = view.attempt([scaledTrade(waiting, amount)]);
  if (!done) {
    const note = { who: "note" as const, text: TRADE_REFUSED };
    return { ...conversation, transcript: [...conversation.transcript, note] };
  }
  const note = { who: "note" as const, text: `Traded ×${amount}.` };
  const at = { ...conversation, pc: [...conversation.pc, 0, 0], transcript: [...conversation.transcript, note] };
  return run(dialog, at, view);
}

/** A trade's sides for so many units, as the one effect it comes to. */
export function scaledTrade(trade: DialogTrade, amount: number): DialogEffectDef {
  const times = (side: TradeSide) => ({ tileId: side.tileId, count: side.count * amount });
  return { effect: "trade", take: trade.take.map(times), give: trade.give.map(times) };
}

/** Cancel pressed on a trade: its cancel branch runs. */
export function cancelTrade(
  dialog: DialogDef,
  conversation: Conversation,
  view: PartnerView,
): Conversation | null {
  const waiting = waitingOn(dialog, conversation);
  if (waiting?.kind !== "request_trade") return null;
  const said = [...conversation.transcript, { who: "you" as const, text: CANCEL_LABEL }];
  return run(dialog, { ...conversation, pc: [...conversation.pc, 1, 0], transcript: said }, view);
}

/**
 * Run from the counter until a command waits or the script ends.
 *
 * A list that runs out pops back to the command that held it and continues
 * after that command; the root running out is the end. Effects that cannot
 * be — a status nobody authored — are skipped rather than stopping the
 * script, because a line the author wrote after them is still worth saying.
 */
function run(dialog: DialogDef, at: Conversation, view: PartnerView): Conversation {
  let pc = at.pc;
  const transcript = [...at.transcript];
  for (let steps = 0; steps < MAX_STEPS_PER_PRESS; steps++) {
    const command = commandAt(dialog, pc);
    if (!command) {
      const parent = afterBlock(dialog, pc);
      if (!parent) return { ...at, pc, transcript };
      pc = parent;
      continue;
    }
    if (command.kind === "choices" || command.kind === "request_trade") {
      return { ...at, pc, transcript };
    }
    if (command.kind === "goto") {
      const target = anchorPath(dialog, command.name);
      pc = advance(target ?? pc);
      continue;
    }
    if (command.kind === "say") {
      transcript.push({ who: "npc", text: fillPartner(command.text, view) });
    } else if (command.kind !== "anchor") {
      view.attempt([effectOf(command)]);
    }
    pc = advance(pc);
  }
  return { ...at, pc, transcript };
}

/** The counter one past the command that held the list `pc` ran out of. */
function afterBlock(dialog: DialogDef, pc: CommandPath): number[] | null {
  if (pc.length < 3) return null;
  const holder = pc.slice(0, -2);
  return listAt(dialog, holder.slice(0, -1)) ? advance(holder) : null;
}

function advance(pc: CommandPath): number[] {
  const next = [...pc];
  next[next.length - 1]! += 1;
  return next;
}

function effectOf(
  command: Extract<DialogCommand, { kind: "add_status" | "remove_status" | "tag" }>,
): DialogEffectDef {
  if (command.kind === "tag") return { effect: "tag", tag: command.tag };
  if (command.kind === "add_status") return { effect: "add_status", statusId: command.statusId };
  return { effect: "remove_status", statusId: command.statusId };
}

const PARTNER_PLACEHOLDER = /\{partner\}/g;

/**
 * An authored line with `{partner}` filled in.
 *
 * One placeholder rather than the brain's slot syntax, because a conversation
 * has exactly one person in it worth naming. The fallback is the brain's own
 * word for a subject that has gone missing, so a partner who logged out
 * mid-sentence reads the same way here as there.
 */
export function fillPartner(line: string, view: PartnerView): string {
  if (!line.includes("{")) return line;
  return line.replace(PARTNER_PLACEHOLDER, view.name() ?? NOBODY);
}
