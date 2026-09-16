import { weaponHandling } from "./battler";
import { resolveWeapon } from "./item";
import {
  type Masteries,
  MASTERIES,
  MASTERY_LABELS,
  requirementShortfall,
  masteriesFromXp,
  masteryLevel,
  type MasteryXp,
} from "./mastery";
import type { TileDef } from "./types";

/**
 * What a weapon asks of you, and what you are getting out of it — in numbers.
 *
 * ## This replaced a sentence, and the sentence was the problem
 *
 * There used to be a `weaponFeel` here, turning the same facts into second-person
 * prose: "You can hardly wield it", "You can wield it like a toy". It read
 * beautifully and it withheld the one thing a player actually needs. Somebody
 * holding a sword they are clumsy with wants to know **which mastery is short
 * and by how much**, and no amount of atmosphere answers that — it leaves them
 * to infer a rule from a mood, and the rule is not guessable: the points missing
 * are pooled across every mastery a weapon asks for, each one costs a twentieth
 * of your accuracy and swing rate, and none of it touches damage.
 *
 * Roleplay is a fine reason to be vague about a story and a bad reason to be
 * vague about a gate. So this says the gate: every requirement, your level
 * against it, and the share of the weapon that comes to.
 *
 * ## One source, both places a weapon describes itself
 *
 * The look label in the world and the inspect lines in a panel go through here,
 * so the sword on the floor and the sword in your bag cannot come to say
 * different things about the same hands. Levels are read out of experience
 * rather than passed in, on the same grounds `./mastery` gives for experience
 * being what travels: there is one place a level is derived and it is not here.
 */

/**
 * The lines a weapon owes whoever is looking at it, or none at all.
 *
 * Empty for anything that is not a weapon — most of what a player can point at —
 * and **empty for a weapon that asks nothing**, which is bare hands and every
 * natural weapon: there is no gate to explain, and a line saying "100%" where
 * there was never a question would be noise on every fist in the world.
 */
export function weaponDemand(
  masteries: Masteries,
  requirements: Masteries | undefined,
): string[] {
  const asked = MASTERIES.filter((mastery) => (requirements?.[mastery] ?? 0) > 0);
  if (asked.length === 0) return [];

  const lines = asked.map((mastery) => {
    const required = requirements?.[mastery] ?? 0;
    const have = masteryLevel(masteries, mastery);
    // Named even when it is met, because a weapon's requirements are part of
    // what it *is* — a player deciding between two swords wants to know what the
    // better one will ask of them before they have it.
    return have >= required
      ? `${MASTERY_LABELS[mastery]} ${required} — met`
      : `${MASTERY_LABELS[mastery]} ${required} — you have ${have}`;
  });

  // What the shortfall actually costs, which the requirement lines above cannot
  // tell you on their own: the points missing are pooled across every mastery a
  // weapon asks for, so a player short on two of them has to add up their own
  // gap before the rule applies. **Damage is named because it is the surprising
  // half**: a weapon you are short of hits as hard as it is written to, and a
  // player who was not told that will put it back down.
  const handling = weaponHandling(requirementShortfall(masteries, requirements));
  lines.push(
    handling >= 1
      ? "Full accuracy and swing rate"
      : `${Math.round(handling * 100)}% accuracy and swing rate; full damage`,
  );
  return lines;
}

/** The same lines for a tile and a block of earned experience. */
export function weaponDemandFor(
  def: TileDef | undefined,
  masteryXp: MasteryXp,
): string[] {
  const weapon = def ? resolveWeapon(def) : null;
  if (!weapon) return [];
  return weaponDemand(masteriesFromXp(masteryXp), weapon.requirements);
}
