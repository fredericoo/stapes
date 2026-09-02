import type { ExtractInteraction, PlacedReward } from "../lib/interactions";
import { DEFAULT_EXTRACT_VERB } from "../lib/interactions";
import {
  MASTERIES,
  MAX_MASTERY,
  MIN_MASTERY,
  type Mastery,
} from "../lib/mastery";
import type { Coord, TileDef } from "../lib/types";
import { COMMAND_USAGE, type CommandRefusal } from "./commands";

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
 * A reward is invisible by design — see the reward notes in `docs/notes.md`:
 * the board is not touched, the chest stays a chest and stays full, and the
 * only evidence is a line item somewhere in a bag the player may not have open.
 * That is exactly the gap a sentence is for. It is also the one moment that can
 * never come round again, which is why it is worth interrupting for at all.
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

/**
 * The author's verb, ready to sit mid-sentence.
 *
 * **The rule is that the line uses the same word the button did.** A player who
 * pressed "Mine" and was told they *worked* the crystal has been handed two
 * names for one act and has to decide whether they are the same thing. Whatever
 * `objectActionLabel` puts on the row is what belongs here, lowercased because
 * it arrives capitalised for a button and this is the middle of a sentence.
 *
 * Shared rather than written per notice, so a mechanism that grows an authored
 * verb cannot quietly grow a second opinion about how to say it — which is
 * exactly what the extract line did before this existed.
 */
function sentenceVerb(authored: string | undefined, fallback: string): string {
  const verb = authored?.trim();
  if (!verb) return fallback;
  return verb[0]!.toLowerCase() + verb.slice(1);
}

function verbOf(reward: PlacedReward): string {
  return sentenceVerb(reward.actionName, DEFAULT_REWARD_VERB);
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
 * What working a resource says to whoever worked it.
 *
 * **The author's verb, exactly as the row said it** — "You mine Arcane Crystal
 * and take 1 Arcane Shard". It used to say "work" whatever the row said, which
 * was one word too many in a game where the author had already chosen one: a
 * player who pressed "Mine" and read that they *worked* the crystal has been
 * given two names for one act. See {@link sentenceVerb}, which both this and a
 * reward's line go through.
 *
 * **An empty pull gets its own sentence rather than none.** A crystal that
 * yielded nothing is the case this line exists for: silence is indistinguishable
 * from the tap having missed, and a player who has just spent one of the vein's
 * three pulls on nothing very much needs to be told that is what happened.
 *
 * Grouped by tile on `rewardNotice`'s argument — three berries out of one bush
 * are three draws on one slot, and "1 Berry, 1 Berry, 1 Berry" reads as a
 * rendering fault.
 */
export function extractNotice(
  extract: ExtractInteraction,
  worked: TileDef,
  tileIds: readonly string[],
  tilesById: Record<string, TileDef>,
): string {
  const opening = `You ${sentenceVerb(extract.actionName, DEFAULT_EXTRACT_SENTENCE_VERB)} ${worked.name}`;
  if (tileIds.length === 0) return `${opening} and find nothing`;
  return `${opening} and take ${countedItems([...tileIds], tilesById)}`;
}

/**
 * What an unnamed resource reads as mid-sentence.
 *
 * {@link DEFAULT_EXTRACT_VERB} lowercased, and derived rather than typed out so
 * that renaming the row's fallback cannot leave the sentence saying the other
 * word — which is the whole failure this function exists to fix, one level up.
 */
const DEFAULT_EXTRACT_SENTENCE_VERB = DEFAULT_EXTRACT_VERB.toLowerCase();

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
      return `Say ${COMMAND_USAGE[refusal.command]}`;
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
    case "badCoordinate":
      // Both spellings shown, because the sign is the whole grammar and a
      // player who typed one of them wrote the other by mistake.
      return `"${refusal.typed}" is not a coordinate. A number is a cell of the map, +1 and -1 are steps from where you stand`;
    case "unknownTile":
      // No list, unlike the masteries above: there are as many tiles as an
      // author cares to draw, and a sentence that tried to name them all would
      // be longer than the chat log it lands in.
      return `No tile called "${refusal.typed}"`;
    case "spawnMarkerTile":
      // The one tile that cannot be put down, and the reason is worth saying:
      // it is not that the tile is special-cased, it is that a map is allowed
      // exactly one of them and a second would be a world that cannot open.
      return `"${refusal.typed}" marks where the world starts, and there is only ever one`;
    case "nowhereToPlace":
      return "You are not standing anywhere";
    case "noRoom":
      return `Nothing will fit at ${cellName(refusal.at)}`;
    case "badHealth":
      return `"${refusal.typed}" is not a number of hit points. Say a figure, or one with a + or - in front of it`;
    case "unharmableTarget":
      // Named rather than explained, on the terms `unteachableTarget` is: "that
      // body has no battler block" is a fact about the engine, and the player
      // asked a question about a crate.
      return `${refusal.name} has no health to change`;
    case "unknownStatus":
      // The known ids rather than a count, on the terms the mastery refusal is
      // written under: a player re-reading their own line to work out which word
      // was wrong is the failure both of these avoid.
      return refusal.known.length === 0
        ? `No status called "${refusal.typed}", and this world authored none`
        : `No status called "${refusal.typed}". Try ${refusal.known.join(", ")}`;
  }
}

/**
 * A cell, as a player reads one back.
 *
 * Three numbers in the order they are typed, so the sentence a refusal comes
 * back with can be edited into the command that would have worked.
 */
function cellName(at: Coord): string {
  return `${at.x}, ${at.y}, ${at.z}`;
}

/**
 * What a tile called into the world says.
 *
 * **Said even though the thing is right there**, which is the opposite of this
 * module's usual rule, and absolute coordinates are why: `/tile apple 0 0 0`
 * puts an apple somewhere the summoner is almost certainly not looking, and a
 * command whose whole effect is off screen is indistinguishable from one that
 * was dropped. Naming the cell back is also the only confirmation that `+1`
 * went the way the player thought it did.
 *
 * The tile's own name, so what the catalogue calls a thing and what the game
 * calls it are one string.
 */
export function tileNotice(name: string, at: Coord): string {
  return `${name} appears at ${cellName(at)}`;
}

/**
 * Why a drink did not happen: what it would have left behind has nowhere to go.
 *
 * The one consume refusal that earns a sentence. Every other reason a consume
 * is refused is a reason the row was never offered — out of reach, not a
 * consumable, an empty slot — where this one is a fact about the kit that the
 * row cannot see: the potion is right there and drinkable, and what stops it is
 * the bottle. A refusal that showed as nothing occurring would be a potion that
 * looks broken. The name is the tile's own, so what the catalogue calls the
 * thing and what the game calls it are one string.
 */
export function noRoomToLeaveNotice(name: string): string {
  return `There is nowhere to put ${name}`;
}

/** What a body is told when a status is put on it by hand. */
export function statusGrantedNotice(name: string): string {
  return `${name}.`;
}

/** What a body is told when everything running on it is taken off. */
export function statusesClearedNotice(): string {
  return "Nothing is on you now.";
}

/**
 * What health reads at, after a command moved it.
 *
 * The figure and its ceiling together, because every one of the three forms —
 * set, heal, harm — is asking the same question underneath, which is *where
 * that leaves them*. A bare "healed 10" leaves the person who typed it counting.
 */
export function healthNotice(hp: number, maxHp: number): string {
  return `${hp}/${maxHp} health.`;
}
