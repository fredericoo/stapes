import { evaluateCondition } from "../lib/conditions";
import {
  clampAmount,
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
  | { kind: "choose"; index: number; amount?: number }
  | { kind: "back" }
  | { kind: "close" };

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
  };
}

/** Back pressed: the opening line again, and the root buttons. */
export function backToRoot(
  dialog: DialogDef,
  conversation: Conversation,
  view: PartnerView,
): Conversation {
  return { ...conversation, path: [], line: fillPartner(dialog.opening, view) };
}

/**
 * A button pressed, by its position among the buttons on offer.
 *
 * Null for a position nothing is at — a stale panel, or a client making it up
 * — and the caller leaves the conversation as it was. Otherwise the option's
 * `if` is asked, its `do` is run, and the reply is its `say`; a refusal of
 * either leaves the path where it was with the `else` line, because "yes"
 * again once the shards are in hand is the same question, not a new one.
 */
export function chooseOption(
  dialog: DialogDef,
  conversation: Conversation,
  index: number,
  requestedAmount: number | undefined,
  view: PartnerView,
): Conversation | null {
  const option = optionsAt(dialog, conversation.path)[index];
  if (!option) return null;

  const amount = clampAmount(option, requestedAmount);
  const scaled = scaledBy(option, amount);
  if (!answers(scaled, view)) {
    const line = option.else ? fillPartner(option.else, view) : conversation.line;
    return { ...conversation, line };
  }

  // The path descends only where there is somewhere to descend to. A reply
  // with no follow-ups lands back at the root, buttons and all, so the panel
  // never shows a reply with nothing under it.
  const pressed = pathTo(dialog, conversation.path, index);
  const path = option.then?.length ? pressed : [];
  return { ...conversation, path, line: fillPartner(option.say, view) };
}

/**
 * Where a press at `index` among the buttons at `path` leads.
 *
 * The buttons at a path are either that reply's `then` or the root's, and the
 * two lead to different places: a root button pressed while a reply is on
 * screen starts over from the root.
 */
function pathTo(
  dialog: DialogDef,
  path: readonly number[],
  index: number,
): number[] {
  const shownFromRoot = optionsAt(dialog, path) === dialog.options;
  return shownFromRoot ? [index] : [...path, index];
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
