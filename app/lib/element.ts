/**
 * The three elements and which of them beats which.
 *
 * Its own module below `./mastery`, importing nothing: an element is a
 * mastery, so `./mastery` folds these into {@link Mastery}, but the wheel is
 * a rule about how two spells meet rather than a fact about a body.
 * {@link spellElements} and {@link bodyElements} live in `./mastery` with the
 * block they read, so the dependency runs one way.
 */

/**
 * Exactly three: the smallest number where every element beats one and loses
 * to one, so none is best or worst. A fourth would need a second relation.
 *
 * `arcane` is not an element. It is how good you are at magic at all (it
 * gates a stone and every cast trains it); the elements are what that skill
 * is pointed at. A body has one arcane and up to three elements, which is why
 * arcane is a weapon mastery and these are not.
 */
export type Element = "fire" | "water" | "nature";

export const ELEMENTS: Element[] = ["fire", "water", "nature"];

/**
 * Water douses fire, fire burns nature, nature drinks water. A map rather than
 * a list of pairs because every element beats exactly one thing, and this
 * shape cannot express a second.
 */
const BEATS: Record<Element, Element> = {
  water: "fire",
  fire: "nature",
  nature: "water",
};

export function beats(attacking: Element, defending: Element): boolean {
  return BEATS[attacking] === defending;
}

/**
 * Multiplier for the winning side of the wheel. The losing side pays its
 * reciprocal rather than a separate figure, so a body attuned to all three
 * elements comes to `1.5 × ⅔ × 1 = 1`: specialised in nothing, neutral to
 * everything, with no special case written for it.
 */
export const EFFECTIVENESS_EDGE = 1.5;

export const NEUTRAL = 1;

/**
 * What one lot of elements is worth against another, as a multiple of the
 * plain rate. Per defended element, multiplied: if any part of the spell beats
 * it the spell gains an edge, else if it beats any part of the spell the spell
 * loses one.
 *
 * The second test is an `else` so an advantage anywhere beats a disadvantage
 * everywhere: a fire-and-water spell against a nature body gains fire's edge
 * and does not also pay for its water. Paying both would make breadth a
 * liability, and a two-element spell already costs twice as much to earn.
 *
 * Elementless on either side is {@link NEUTRAL}.
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
