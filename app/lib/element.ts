export type Element = "fire" | "water" | "nature";

export const ELEMENTS: Element[] = ["fire", "water", "nature"];

const BEATS: Record<Element, Element> = {
  water: "fire",
  fire: "nature",
  nature: "water",
};

export function beats(attacking: Element, defending: Element): boolean {
  return BEATS[attacking] === defending;
}

export const EFFECTIVENESS_EDGE = 1.5;

export const NEUTRAL = 1;

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
