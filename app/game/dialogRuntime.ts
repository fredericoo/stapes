import { evaluateCondition } from "../lib/conditions";
import {
  clampAmount,
  optionAt,
  optionsAt,
  type DialogCondition,
  type DialogConditionDef,
  type DialogDef,
  type DialogEffectDef,
  type DialogOption,
} from "../lib/dialog";
import { NOBODY } from "./brainRuntime";

/**
 * One player talking to one NPC, a press at a time.
 *
 * Pure functions over (def, where the conversation is, what was pressed), so a
 * test can drive a whole talk without a session and the editor can run the
 * same functions against a pretend kit. Nothing here knows how a press reached
 * the server or how a line reaches a panel.
 *
 * The state is the *player's* — see `Conversation` — which is what lets any
 * number of people talk to one salesman at once. Whether they are still near
 * enough to is the session's question, asked every tick; this module only
 * answers what a press does.
 */

/**
 * What a player may do to a conversation: open one, press a button, go back
 * to the first buttons, or close the panel. The `talk` message's payload — see
 * `../net/protocol` — and `GameSession.talk`'s argument, so the wire and the
 * local session take the same verb.
 */
export type TalkAction =
  | { kind: "open"; ref: { x: number; y: number; z: number; stackIndex: number } }
  | { kind: "choose"; index: number }
  /** The stepper's number, once the NPC has asked for one. */
  | { kind: "confirm"; amount: number }
  | { kind: "back" }
  | { kind: "close" };

/**
 * What the panel shows under the line.
 *
 * - `asking`: the buttons under the path — the root's, or a reply's `then`.
 * - `counting`: the option at the path wants an amount; a stepper and its
 *   confirm button.
 * - `answered`: a leaf reply, or a refusal; only *Back*.
 *
 * Decided where the press was answered, so the panel never has to work out
 * from a path whether a reply succeeded.
 */
export type ConversationStage = "asking" | "counting" | "answered";

/**
 * Where one player is in one NPC's dialog.
 *
 * `path` is indices from the root, one per `then` descended, so a def reloaded
 * under a running conversation resolves to *an* option or to nothing rather
 * than to a stale object. `line` is what the NPC last said, `{partner}` filled,
 * because whether it was the `say` or the `else` is decided where the kit is,
 * and the panel must not have to guess.
 */
export type Conversation = {
  npcId: string;
  /**
   * The NPC's tile, so the panel can draw the body and read its dialog off the
   * catalogue it already holds — the buttons are never on the wire.
   */
  tileId: string;
  path: number[];
  line: string;
  stage: ConversationStage;
};

/**
 * What a press may ask of the partner — `BrainContext` with the legs cut off,
 * and the partner already chosen. The session builds one per conversation.
 */
export type PartnerView = {
  /** The partner's name, or null once they are gone. */
  name(): string | null;
  /** Does the partner carry at least so many of a tile? @see ./trade */
  carries(tileId: string, count: number): boolean;
  /** Is there room on the partner for so many of a tile? @see ./trade */
  roomFor(tileId: string, count: number): boolean;
  hasTag(tag: string): boolean;
  hasStatus(statusId: string): boolean;
  /**
   * Run these effects on the partner, all or none. False when any of them
   * cannot be — and then nothing has changed, which is what lets an option's
   * `else` be said honestly.
   */
  attempt(effects: readonly DialogEffectDef[]): boolean;
};

/** Talk pressed: the opening line, and the root buttons. */
export function openConversation(
  dialog: DialogDef,
  npc: { id: string; tileId: string },
  view: PartnerView,
): Conversation {
  return {
    npcId: npc.id,
    tileId: npc.tileId,
    path: [],
    line: fillPartner(dialog.opening, view),
    stage: "asking",
  };
}

/**
 * Back pressed: one level up, with that reply's line said again and its
 * buttons on offer — or the opening line and the root's from the top.
 *
 * Up one rather than to the root, because this is a tree and a player three
 * presses deep who wants a different answer to the last question should not
 * have to find the question again. Saying the parent's line again is a
 * repeat of words, never of deeds: nothing is asked or run on the way back.
 */
export function goBack(
  dialog: DialogDef,
  conversation: Conversation,
  view: PartnerView,
): Conversation {
  const path = conversation.path.slice(0, -1);
  const parent = path.length === 0 ? null : optionAt(dialog, path);
  const line = fillPartner(parent ? parent.say : dialog.opening, view);
  return { ...conversation, path, line, stage: "asking" };
}

/**
 * A button pressed, by its position among the buttons on offer.
 *
 * Null for a position nothing is at — a stale panel, or a client making it up
 * — or for a press while the NPC is waiting on an amount; the caller leaves
 * the conversation as it was. An option with an amount is a question first:
 * the NPC asks, and nothing is run until {@link confirmAmount}. Anything else
 * is answered on the spot.
 */
export function chooseOption(
  dialog: DialogDef,
  conversation: Conversation,
  index: number,
  view: PartnerView,
): Conversation | null {
  if (conversation.stage !== "asking") return null;
  const option = optionsAt(dialog, conversation.path)[index];
  if (!option) return null;

  const path = [...conversation.path, index];
  if (option.amount) {
    return { ...conversation, path, line: fillPartner(option.amount.prompt, view), stage: "counting" };
  }
  return answer(option, { ...conversation, path }, 1, view);
}

/**
 * The stepper's number handed over, for the option the NPC is waiting on.
 *
 * Null unless the NPC is actually waiting on one — a confirm sent against
 * a panel that has moved on is a race, not an answer.
 */
export function confirmAmount(
  dialog: DialogDef,
  conversation: Conversation,
  requestedAmount: number,
  view: PartnerView,
): Conversation | null {
  if (conversation.stage !== "counting") return null;
  const option = optionAt(dialog, conversation.path);
  if (!option?.amount) return null;
  return answer(option, conversation, clampAmount(option, requestedAmount), view);
}

/**
 * The option's `if` asked and its `do` run, and the reply that comes of it.
 *
 * A refusal says `else` — or leaves the last line, for an option with none —
 * and is a leaf: only *Back* is on offer, because the question was answered,
 * even if the answer was no. A success says `say` and offers the reply's
 * follow-ups, or only *Back* when it has none.
 */
function answer(
  option: DialogOption,
  at: Conversation,
  amount: number,
  view: PartnerView,
): Conversation {
  if (!answers(scaledBy(option, amount), view)) {
    const line = option.else ? fillPartner(option.else, view) : at.line;
    return { ...at, line, stage: "answered" };
  }
  return {
    ...at,
    line: fillPartner(option.say, view),
    stage: option.then?.length ? "asking" : "answered",
  };
}

/**
 * The option with every count multiplied by the chosen amount.
 *
 * Trade sides and the counted conditions alike, so "sell 5" asks for five
 * bottles, takes five, and gives five times the price. Uncounted parts — a
 * tag, a status — are what they are however many.
 */
function scaledBy(option: DialogOption, amount: number): DialogOption {
  if (amount === 1) return option;
  const times = (side: { tileId: string; count: number }) => ({
    tileId: side.tileId,
    count: side.count * amount,
  });
  return {
    ...option,
    if: option.if ? scaleCondition(option.if, amount) : undefined,
    do: option.do?.map((effect) =>
      effect.effect === "trade"
        ? { ...effect, take: effect.take.map(times), give: effect.give.map(times) }
        : effect,
    ),
  };
}

function scaleCondition(condition: DialogCondition, amount: number): DialogCondition {
  if ("rules" in condition) {
    return { ...condition, rules: condition.rules.map((rule) => scaleCondition(rule, amount)) };
  }
  if (condition.cond === "carries" || condition.cond === "room_for") {
    return { ...condition, count: condition.count * amount };
  }
  return condition;
}

/**
 * May this option answer — does its `if` hold, and did its `do` run?
 *
 * The condition is asked first and the effects only then, so an option that
 * asks `carries` and then trades never runs a trade it already knows is short.
 * Both refusals read the same to the caller because they are the same to the
 * partner: nothing happened, and the `else` line says why.
 */
function answers(option: DialogOption, view: PartnerView): boolean {
  if (option.if && !holds(option.if, view)) return false;
  if (option.do?.length && !view.attempt(option.do)) return false;
  return true;
}

function holds(condition: DialogCondition, view: PartnerView): boolean {
  return evaluateCondition(condition, (leaf) => leafHolds(leaf, view));
}

/** Every leaf is a question about the partner and nothing else. */
function leafHolds(leaf: DialogConditionDef, view: PartnerView): boolean {
  switch (leaf.cond) {
    case "carries":
      return view.carries(leaf.tileId, leaf.count);
    case "room_for":
      return view.roomFor(leaf.tileId, leaf.count);
    case "has_tag":
      return view.hasTag(leaf.tag);
    case "has_status":
      return view.hasStatus(leaf.statusId);
  }
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
