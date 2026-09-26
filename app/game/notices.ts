import { formatClock, type MinutesOfDay } from "../lib/clock";
import type { CraftInteraction, ExtractInteraction, PlacedReward } from "../lib/interactions";
import { DEFAULT_CRAFT_VERB, DEFAULT_EXTRACT_VERB } from "../lib/interactions";
import { MASTERIES, MAX_MASTERY, MIN_MASTERY, type Mastery } from "../lib/mastery";
import type { Coord, TileDef } from "../lib/types";
import type { CastRefusal } from "./casting";
import { COMMAND_USAGE, MAX_TILE_COUNT, type CommandRefusal } from "./commands";
import type { PathRefusal } from "./pathfinding";

export function masteryNotice(mastery: Mastery, level: number): string {
  return `Your ${mastery} mastery is now ${level}`;
}

export function rewardNotice(
  reward: PlacedReward,
  giver: TileDef,
  tilesById: Record<string, TileDef>,
): string {
  const opening = `You ${verbOf(reward)} ${giver.name}`;
  const items = countedItems(reward.itemTileIds, tilesById);
  return items.length === 0 ? opening : `${opening} and receive ${items}`;
}

const DEFAULT_REWARD_VERB = "take";

function sentenceVerb(authored: string | undefined, fallback: string): string {
  const verb = authored?.trim();
  if (!verb) return fallback;
  return verb[0].toLowerCase() + verb.slice(1);
}

function verbOf(reward: PlacedReward): string {
  return sentenceVerb(reward.actionName, DEFAULT_REWARD_VERB);
}

function countedItems(tileIds: string[], tilesById: Record<string, TileDef>): string {
  const counted = new Map<string, number>();
  for (const tileId of tileIds) {
    counted.set(tileId, (counted.get(tileId) ?? 0) + 1);
  }
  return [...counted]
    .map(([tileId, count]) => `${count} ${tilesById[tileId]?.name ?? tileId}`)
    .join(", ");
}

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

export function craftNotice(
  craft: CraftInteraction,
  crafter: TileDef,
  tileIds: readonly string[],
  tilesById: Record<string, TileDef>,
): string {
  const opening = `You ${sentenceVerb(craft.actionName, DEFAULT_CRAFT_SENTENCE_VERB)} at ${crafter.name}`;
  if (tileIds.length === 0) return `${opening} and it comes to nothing`;
  return `${opening} and make ${countedItems([...tileIds], tilesById)}`;
}

const DEFAULT_CRAFT_SENTENCE_VERB = DEFAULT_CRAFT_VERB.toLowerCase();

const DEFAULT_EXTRACT_SENTENCE_VERB = DEFAULT_EXTRACT_VERB.toLowerCase();

export function otherMasteryNotice(name: string, mastery: Mastery, level: number): string {
  return `${name}'s ${mastery} mastery is now ${level}`;
}

export function castRefusalNotice(refusal: CastRefusal): string | null {
  return refusal === "noTarget" ? "Select a target first" : null;
}

export function commandRefusalNotice(refusal: CommandRefusal): string {
  switch (refusal.kind) {
    case "notAdmin":
      return "Only an administrator can run commands";
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
      return `${refusal.name} does not learn`;
    case "badCoordinate":
      return `"${refusal.typed}" is not a coordinate. A number is a cell of the map, +1 and -1 are steps from where you stand`;
    case "badCount":
      return `"${refusal.typed}" is not a count. Write x1 to x${MAX_TILE_COUNT}, and write it before the coordinates`;
    case "unknownTile":
      return `No tile called "${refusal.typed}"`;
    case "spawnMarkerTile":
      return `"${refusal.typed}" marks where the world starts, and there is only ever one`;
    case "nowhereToPlace":
      return "You are not standing anywhere";
    case "noRoom":
      return `Nothing will fit at ${cellName(refusal.at)}`;
    case "badHealth":
      return `"${refusal.typed}" is not a number of hit points. Say a figure, or one with a + or - in front of it`;
    case "badTime":
      return `"${refusal.typed}" is not a time. Write it like 18:00, from 00:00 to 23:59`;
    case "unharmableTarget":
      return `${refusal.name} has no health to change`;
    case "immuneTarget":
      return `${refusal.name} cannot be ${statusInSentence(refusal.status)}`;
    case "unknownStatus":
      return refusal.known.length === 0
        ? `No status called "${refusal.typed}", and this world authored none`
        : `No status called "${refusal.typed}". Try ${refusal.known.join(", ")}`;
  }
}

function cellName(at: Coord): string {
  return `${at.x}, ${at.y}, ${at.z}`;
}

export function tileNotice(name: string, at: Coord, count = 1): string {
  const many = count > 1 ? ` ×${count}` : "";
  return `${name}${many} appears at ${cellName(at)}`;
}

export function noRoomToLeaveNotice(name: string): string {
  return `There is nowhere to put ${name}`;
}

export function noRouteNotice(why: PathRefusal): string {
  switch (why) {
    case "unreachable":
      return "There is no way there from here";
    case "detour":
      return "There is no short way there";
    case "budget":
      return "There is no short way there";
  }
}

export function timeNotice(minutes: MinutesOfDay): string {
  return `It is now ${formatClock(minutes)}`;
}

export function statusAcquiredNotice(name: string): string {
  return `You are ${statusInSentence(name)}`;
}

export function statusInSentence(name: string): string {
  return name.toLowerCase();
}

export function otherStatusNotice(name: string, status: string): string {
  return `${name} is ${statusInSentence(status)}`;
}

export function spawnMarkNotice(): string {
  return "You will respawn here.";
}

export function spawnMarkUnchangedNotice(): string {
  return "You already respawn here.";
}

export function statusesClearedNotice(): string {
  return "Nothing is on you now.";
}

export function healthNotice(hp: number, maxHp: number): string {
  return `${hp}/${maxHp} health.`;
}
