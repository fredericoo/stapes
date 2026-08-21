import type { PlacedReward } from "../lib/interactions";
import {
  MASTERIES,
  MAX_MASTERY,
  MIN_MASTERY,
  type Mastery,
} from "../lib/mastery";
import type { TileDef } from "../lib/types";
import { MASTERY_COMMAND_USAGE, type CommandRefusal } from "./commands";

/**
 * The things the game says to the player in words.
 *
 * A sentence is the last resort. Almost everything that happens is shown — a
 * blow is a number off a head, a status is an icon in the strip, a mastery is a
 * bar in the panel — and a line of prose across the bottom of the view is what
 * is left for the facts that have no picture. Two kinds qualify, and it is worth
 * naming both now because the second is what shapes this module:
 *
 * - **Something crossed a threshold you were not watching.** A level-up is the
 *   only moment the mastery bars mean anything, and it lands while you are
 *   looking at a rat rather than at the panel.
 * - **Something you asked for did not happen.** "You cannot fit there", "Your
 *   inventory is full". A refusal shows as *nothing occurring*, which is
 *   indistinguishable from the input being dropped — the sentence is the only
 *   thing that separates a rule from a bug.
 *
 * Pure functions over game state, kept out of `../render` on purpose: what the
 * game has to tell you is a fact about the rules, and only *how it is drawn* is
 * the renderer's business. @see ../render/notifications
 */

/**
 * What a mastery that has just gone up says.
 *
 * **Composed where the experience is written, not where it is read.** This used
 * to be a diff the client took across successive `masteryXp` blocks, on the
 * grounds that nothing on the wire announced a crossing — true at the time, and
 * it stopped being true the moment rewards gave notices a channel of their own.
 * Inferring was strictly worse: the client had to hold its own copy of the last
 * block, gate on `hasExperience` so the empty block held before `hello` was not
 * read as a lifetime of level-ups, and take care that a re-registered listener
 * did not replay them. All of that existed to reconstruct something the session
 * already knew exactly. Earning is the only thing that moves a mastery — being
 * *seeded* with one is not earning it — so composing it at the source has no
 * baseline problem to solve.
 *
 * One line per crossing whatever the jump: a blow worth three points says "now
 * 12" once, because the level reached is the fact, and the two rungs passed on
 * the way are not.
 *
 * **The word "level" is not in the sentence, and that is the same rule the rest
 * of this file is written under.** There are no levels — a body is a set of
 * masteries, and `../lib/mastery` says so in its first line. "Your blade mastery
 * is now 10" names the thing that moved and what it reads; "level 10" borrows a
 * noun from a game this is not, and invites the player to look for the others.
 */
export function masteryNotice(mastery: Mastery, level: number): string {
  // The mastery's own name, lowercase, because that is what the union member
  // already is — a label table here would be a second place to rename them.
  return `Your ${mastery} mastery is now ${level}`;
}

/**
 * What a reward that has just been handed over says.
 *
 * **The one notice for a thing that happened rather than a thing that did not.**
 * A reward is invisible by design — see the reward notes in `AGENTS.md`: the
 * board is not touched, the chest stays a chest and stays full, and the only
 * evidence is a line item somewhere in a bag the player may not have open. That
 * is exactly the gap a sentence is for. It is also the one moment that can never
 * come round again, which is why it is worth interrupting for at all.
 *
 * The verb is the *authored* one — `Open` on a quest chest, and whatever an
 * author writes on the next thing — lowercased into the sentence. Composed here
 * from the same `actionName` the interaction row is labelled from, so the button
 * you pressed and the line that follows it cannot come to describe two different
 * gestures. Only the first letter is lowered, so an author who writes a proper
 * noun into the verb keeps it.
 *
 * Items are **grouped by tile**, because a reward is a recipe rather than a set
 * of objects: three loaves are authored as `bread` three times, and "1 Bread, 1
 * Bread, 1 Bread" reads as a rendering fault rather than as three loaves.
 *
 * A reward that hands over nothing is a real thing to author — a tag for having
 * spoken to somebody — so it gets the sentence without the second clause rather
 * than no sentence at all. "You speak to Old Man" is the whole of what happened,
 * and silence there is indistinguishable from the tap having missed.
 */
export function rewardNotice(
  reward: PlacedReward,
  giver: TileDef,
  tilesById: Record<string, TileDef>,
): string {
  const opening = `You ${verbOf(reward)} ${giver.name}`;
  const items = countedItems(reward.itemTileIds, tilesById);
  return items.length === 0 ? opening : `${opening} and receive ${items}`;
}

/**
 * What an author called the gesture, or "take".
 *
 * The same fallback the interaction row uses, and it is deliberately the plain
 * word rather than "receive": a tile being a reward is the author's word for it,
 * not the player's, and a row that says "Take" must not be followed by a line
 * that says you were given something.
 */
const DEFAULT_REWARD_VERB = "take";

function verbOf(reward: PlacedReward): string {
  const authored = reward.actionName?.trim();
  if (!authored) return DEFAULT_REWARD_VERB;
  return authored[0].toLowerCase() + authored.slice(1);
}

/**
 * "1 Hand Lantern, 1 Rusty Sword", in the order the reward was authored in.
 *
 * Authored order rather than sorted, so the line reads the way the author laid
 * the chest out — and a tile the catalogue no longer holds falls back to its id,
 * which is ugly on purpose: a reward handing over something unnamed is a content
 * bug, and a sentence that quietly skipped it would hide the missing item.
 */
function countedItems(
  tileIds: string[],
  tilesById: Record<string, TileDef>,
): string {
  const counted = new Map<string, number>();
  for (const tileId of tileIds) {
    counted.set(tileId, (counted.get(tileId) ?? 0) + 1);
  }
  return [...counted]
    .map(([tileId, count]) => `${count} ${tilesById[tileId]?.name ?? tileId}`)
    .join(", ");
}

/**
 * What somebody else's mastery moving says, to whoever moved it.
 *
 * The sibling of {@link masteryNotice} and not a parameter on it, because the
 * two are read by different people: the body whose mastery changed is told what
 * *theirs* now reads, and the admin who changed it is told what *they* just did.
 * Folding them into one function taking an optional name would put a branch in
 * the middle of a sentence that has no branch in it.
 *
 * Only a command reaches this. Nothing a player does in a fight can move
 * anybody's masteries but their own.
 */
export function otherMasteryNotice(
  name: string,
  mastery: Mastery,
  level: number,
): string {
  return `${name}'s ${mastery} mastery is now ${level}`;
}

/**
 * Why a command did not happen, in words.
 *
 * **The refusal is the whole feature.** A command is typed blind — there is no
 * menu offering it and no row lighting up to say it would work — so the only
 * thing separating a mistyped mastery from a broken server is this sentence.
 * That is the same argument "You cannot fit there" is written under, turned up:
 * a refusal that shows as nothing occurring is indistinguishable from the input
 * being dropped, and here *everything* about the input was invisible.
 *
 * Every sentence names what was typed back at the player where there is
 * something to name. "There is no mastery by that name" leaves them re-reading
 * their own line to find out which word was wrong.
 *
 * The lists and the usage line come from `./commands`, so the grammar the parser
 * enforces and the grammar the player is shown cannot drift apart.
 */
export function commandRefusalNotice(refusal: CommandRefusal): string {
  switch (refusal.kind) {
    case "unknownCommand":
      return `There is no ${refusal.typed} command`;
    case "badArguments":
      return `Say ${MASTERY_COMMAND_USAGE}`;
    case "unknownMastery":
      return `No mastery called "${refusal.typed}". Try ${MASTERIES.join(", ")}`;
    case "badLevel":
      return `"${refusal.typed}" is not a mastery between ${MIN_MASTERY} and ${MAX_MASTERY}`;
    case "noSuchTarget":
      return `Nobody here answers to "${refusal.typed}"`;
    case "unteachableTarget":
      // Named rather than explained, because "a creature's masteries are
      // authored and there is no runtime block to write to" is a fact about the
      // engine and the player asked a question about a deer.
      return `${refusal.name} does not learn`;
  }
}
