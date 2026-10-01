import type { Conversation, TalkAction } from "../app/game/dialogRuntime";
import { waitingOn } from "../app/game/dialogRuntime";
import {
  anchorPath,
  resolveDialog,
  walkCommands,
  type CommandPath,
  type DialogCommand,
  type DialogDef,
  type TradeSide,
} from "../app/lib/dialog";
import type { TileDef } from "../app/lib/types";

/**
 * One trade an NPC offers, found by reading its dialog from the tile
 * catalogue. `path` is where the `request_trade` sits in the script, which is
 * also the counter a conversation stops at while waiting on it.
 */
export type Offer = {
  readonly npc: string;
  readonly npcName: string;
  readonly path: CommandPath;
  readonly take: readonly TradeSide[];
  readonly give: readonly TradeSide[];
  readonly min: number;
  readonly max: number;
};

const offersByCatalogue = new WeakMap<Record<string, TileDef>, readonly Offer[]>();

/** Every trade every NPC in the catalogue offers. */
export function offersIn(tilesById: Record<string, TileDef>): readonly Offer[] {
  const cached = offersByCatalogue.get(tilesById);
  if (cached) return cached;
  const offers: Offer[] = [];
  for (const def of Object.values(tilesById)) {
    const dialog = resolveDialog(def);
    if (!dialog) continue;
    for (const { path, command } of walkCommands(dialog)) {
      if (command.kind !== "request_trade") continue;
      offers.push({
        npc: def.id,
        npcName: def.name,
        path,
        take: command.take,
        give: command.give,
        min: command.min,
        max: command.max,
      });
    }
  }
  offersByCatalogue.set(tilesById, offers);
  return offers;
}

/**
 * The tile most offers ask for, which is what the world uses as money. Read
 * from the catalogue so a shop priced in something else changes it.
 */
export function currencyOf(offers: readonly Offer[]): string | null {
  const counts = new Map<string, number>();
  for (const offer of offers) {
    for (const side of offer.take) counts.set(side.tileId, (counts.get(side.tileId) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [tileId, count] of counts) {
    if (count > bestCount) {
      best = tileId;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The next thing to say to an NPC to reach the trade at `target` and make it
 * `amount` times, or `close` when the script cannot lead there from where the
 * conversation is. A different trade is cancelled, and a menu is answered
 * with the option that leads to the target.
 */
export function nextTalk(
  dialog: DialogDef,
  conversation: Conversation,
  target: CommandPath,
  amount: number,
): TalkAction {
  const waiting = waitingOn(dialog, conversation);
  if (!waiting) return { kind: "close" };
  if (waiting.kind === "request_trade") {
    return samePath(conversation.pc, target) ? { kind: "trade", amount } : { kind: "cancel" };
  }
  const options = waiting.options;
  for (let index = 0; index < options.length; index++) {
    const branch = [...conversation.pc, index];
    if (startsWith(target, branch)) return { kind: "choose", index };
  }
  for (let index = 0; index < options.length; index++) {
    const branch = [...conversation.pc, index];
    if (leadsTo(dialog, options[index]!.then, branch, target)) return { kind: "choose", index };
  }
  return { kind: "close" };
}

/**
 * Whether running `list` (at `listPath`) can arrive at `target` through a
 * `goto`. Only the first jump is followed: a script whose menu is reached by
 * a chain of jumps is answered by `close`, which ends the visit rather than
 * looping on it.
 */
function leadsTo(
  dialog: DialogDef,
  list: readonly DialogCommand[],
  listPath: CommandPath,
  target: CommandPath,
): boolean {
  for (let index = 0; index < list.length; index++) {
    const command = list[index]!;
    if (startsWith(target, [...listPath, index])) return true;
    if (command.kind !== "goto") continue;
    const anchor = anchorPath(dialog, command.name);
    if (!anchor) return false;
    const parent = anchor.slice(0, -1);
    const at = anchor[anchor.length - 1]!;
    return startsWith(target, parent) && (target[parent.length] ?? -1) > at;
  }
  return false;
}

function startsWith(path: CommandPath, prefix: CommandPath): boolean {
  if (prefix.length > path.length) return false;
  return prefix.every((step, i) => path[i] === step);
}

function samePath(a: CommandPath, b: CommandPath): boolean {
  return a.length === b.length && startsWith(a, b);
}
