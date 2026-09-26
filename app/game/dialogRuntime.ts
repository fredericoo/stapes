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

export type TalkAction =
  | { kind: "open"; ref: { x: number; y: number; z: number; stackIndex: number } }
  | { kind: "choose"; index: number }
  | { kind: "trade"; amount: number }
  | { kind: "cancel" }
  | { kind: "close" };

export type TranscriptEntry = { who: "npc" | "you" | "note"; text: string };

export type Conversation = {
  npcId: string;
  tileId: string;
  pc: number[];
  transcript: TranscriptEntry[];
};

export type DialogEffectDef =
  | { effect: "trade"; take: TradeSide[]; give: TradeSide[] }
  | { effect: "add_status"; statusId: string }
  | { effect: "remove_status"; statusId: string }
  | { effect: "tag"; tag: string };

export type PartnerView = {
  name(): string | null;
  attempt(effects: readonly DialogEffectDef[]): boolean;
};

export const MAX_STEPS_PER_PRESS = 200;

export const TRADE_REFUSED = "That trade did not go through.";

export const CANCEL_LABEL = "Cancel";

export function openConversation(
  dialog: DialogDef,
  npc: { id: string; tileId: string },
  view: PartnerView,
): Conversation {
  return run(dialog, { npcId: npc.id, tileId: npc.tileId, pc: [0], transcript: [] }, view);
}

export function waitingOn(
  dialog: DialogDef,
  conversation: Conversation,
): Extract<DialogCommand, { kind: "choices" }> | DialogTrade | null {
  const command = commandAt(dialog, conversation.pc);
  if (command?.kind === "choices" || command?.kind === "request_trade") return command;
  return null;
}

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
  return run(
    dialog,
    { ...conversation, pc: [...conversation.pc, index, 0], transcript: said },
    view,
  );
}

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
  const at = {
    ...conversation,
    pc: [...conversation.pc, 0, 0],
    transcript: [...conversation.transcript, note],
  };
  return run(dialog, at, view);
}

export function scaledTrade(trade: DialogTrade, amount: number): DialogEffectDef {
  const times = (side: TradeSide) => ({ tileId: side.tileId, count: side.count * amount });
  return { effect: "trade", take: trade.take.map(times), give: trade.give.map(times) };
}

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

export function fillPartner(line: string, view: PartnerView): string {
  if (!line.includes("{")) return line;
  return line.replace(PARTNER_PLACEHOLDER, view.name() ?? NOBODY);
}
