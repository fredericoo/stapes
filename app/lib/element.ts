/**
 * The three things magic is made of, and which of them beats which.
 *
 * ## Why this is its own module, below `./mastery`
 *
 * An element is a mastery — you get better at fire by throwing fire — so
 * `./mastery` folds these three into {@link Mastery} and every block of numbers
 * in the game carries them for free. But the *wheel* is not a fact about a body:
 * it is a rule about how two spells' worth of magic meet, and `./mastery` has no
 * business knowing it any more than it knows what a tile is.
 *
 * So this module holds the vocabulary and the wheel and imports nothing at all,
 * `./mastery` imports it, and the two functions that read a wheel out of a block
 * of numbers — {@link spellElements}, {@link bodyElements} — live over there
 * with the block they read. One direction, no cycle.
 */

/**
 * The elements, and there are exactly three.
 *
 * **Closed on purpose, and the closure is what makes the wheel a wheel.** Three
 * is the smallest number where every element beats one and loses to one, so no
 * element is the best and none is the worst; a fourth would need a second
 * relation to keep that true and would stop being something a player can hold in
 * their head.
 *
 * `arcane` is deliberately not here. Arcane is how good you are at magic *at
 * all* — it is what gates a stone and what every cast trains — and the elements
 * are what that skill is pointed at. A body has one of the first and up to three
 * of the second, which is why one is a weapon mastery and these are not.
 */
export type Element = "fire" | "water" | "nature";

export const ELEMENTS: Element[] = ["fire", "water", "nature"];

/**
 * What each element has the better of.
 *
 * Water douses fire, fire burns nature, nature drinks water. Written as one map
 * rather than as a list of pairs because every element beats exactly one thing:
 * a second entry for an element would be a wheel that had stopped being one, and
 * this shape cannot express it.
 */
const BEATS: Record<Element, Element> = {
  water: "fire",
  fire: "nature",
  nature: "water",
};

/** Whether the first element has the better of the second. */
export function beats(attacking: Element, defending: Element): boolean {
  return BEATS[attacking] === defending;
}

/**
 * What being on the right side of the wheel is worth.
 *
 * Half again, and the wrong side pays its reciprocal rather than a separately
 * chosen figure — which is the property that makes a mirror cancel exactly. A
 * body attuned to all three elements at once is beaten by every element and
 * beats every element, so its multiplier is `1.5 × ⅔ × 1` and comes to precisely
 * one. That is the right answer for somebody who has specialised in nothing, and
 * it falls out of the arithmetic rather than being a case anybody wrote.
 *
 * It is also why **specialising has a cost**: the day a caster's Fire pulls
 * ahead of their Water and Nature they stop being neutral and start being a
 * thing water is good against. Nothing enforces that — it is what
 * {@link bodyElements} means by "whatever you are most attuned to".
 */
export const EFFECTIVENESS_EDGE = 1.5;

/** Neither side has the better of it, which is nearly every exchange. */
export const NEUTRAL = 1;

/**
 * What one lot of elements is worth against another, as a multiple of the plain
 * rate.
 *
 * **Per element being defended, and multiplied**, which is the rule that makes
 * multi-element spells and multi-element bodies behave sensibly without a second
 * mechanism. Each element a body is attuned to is looked at once: if any part of
 * the spell beats it the spell gains an edge, if it beats any part of the spell
 * the spell loses one, and otherwise nothing happens.
 *
 * **An advantage anywhere beats a disadvantage everywhere**, which is why the
 * second test is an `else`. A fire-and-water spell thrown at a nature body has
 * fire's edge over nature and nature's edge over its water, and the honest
 * reading of that is that the caster picks which half to throw. Paying both
 * would make breadth a liability, and a spell that asks two elements already
 * costs twice as much to earn.
 *
 * Elementless on either side is {@link NEUTRAL}: a spell made of nothing has no
 * edge, and a body attuned to nothing offers none. That is the overwhelmingly
 * common answer — every hearth burn, every venomous bite and every body that has
 * never picked a side.
 */
export function effectiveness(
  attacking: readonly Element[],
  defending: readonly Element[],
): number {
  if (attacking.length === 0 || defending.length === 0) return NEUTRAL;

  let multiplier = NEUTRAL;
  for (const against of defending) {
    if (attacking.some((element) => beats(element, against))) {
      multiplier *= EFFECTIVENESS_EDGE;
    } else if (attacking.some((element) => beats(against, element))) {
      multiplier /= EFFECTIVENESS_EDGE;
    }
  }
  return multiplier;
}
