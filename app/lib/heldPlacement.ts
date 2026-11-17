import type { HeldPartId } from "./humanParts";
import type { Direction } from "./types";

export type Hand = "weaponHand" | "offHand";

/**
 * Where a hand holds things in one frame: whether they are painted behind
 * the figure or over it, and how far the held part's frame is moved, in
 * pixels right and down.
 */
export type HeldPlacement = { behind: boolean; at: readonly [number, number] };

/** One placement per pose, in the order of `SHEET_POSES`. */
export type HeldPlacements = readonly [HeldPlacement, HeldPlacement, HeldPlacement];

export const HANDS = ["weaponHand", "offHand"] as const satisfies readonly Hand[];

/**
 * A shield is carried in front of the body where a weapon is carried at its
 * side, so the two are placed by tables of their own.
 */
export type Carry = "weapon" | "shield";

const SHIELDS: ReadonlySet<HeldPartId> = new Set(["wooden-shield", "metal-shield"]);

export function carryOf(part: HeldPartId): Carry {
  return SHIELDS.has(part) ? "shield" : "weapon";
}

export const HELD_PLACEMENT: Record<Carry, Record<Hand, Record<Direction, HeldPlacements>>> = {
  weapon: {
    weaponHand: {
      s: [
        { behind: true, at: [-2, 0] },
        { behind: true, at: [-2, 1] },
        { behind: false, at: [-2, 2] },
      ],
      e: [
        { behind: false, at: [-1, 3] },
        { behind: false, at: [0, 3] },
        { behind: false, at: [1, 3] },
      ],
      w: [
        { behind: true, at: [3, -1] },
        { behind: true, at: [2, -1] },
        { behind: true, at: [0, -1] },
      ],
      n: [
        { behind: true, at: [4, 2] },
        { behind: true, at: [4, 1] },
        { behind: false, at: [4, -1] },
      ],
    },
    offHand: {
      s: [
        { behind: false, at: [3, 0] },
        { behind: false, at: [4, 0] },
        { behind: false, at: [4, -2] },
      ],
      e: [
        { behind: true, at: [2, -1] },
        { behind: true, at: [1, -1] },
        { behind: true, at: [0, -1] },
      ],
      w: [
        { behind: false, at: [-1, 3] },
        { behind: false, at: [0, 3] },
        { behind: false, at: [1, 2] },
      ],
      n: [
        { behind: true, at: [0, 1] },
        { behind: true, at: [0, 2] },
        { behind: true, at: [-1, 3] },
      ],
    },
  },
  shield: {
    weaponHand: {
      s: [
        { behind: false, at: [-4, -2] },
        { behind: false, at: [-4, 0] },
        { behind: false, at: [-3, 0] },
      ],
      e: [
        { behind: false, at: [-1, 3] },
        { behind: false, at: [0, 3] },
        { behind: false, at: [1, 3] },
      ],
      w: [
        { behind: true, at: [3, -1] },
        { behind: true, at: [2, -1] },
        { behind: true, at: [0, -1] },
      ],
      n: [
        { behind: true, at: [4, 2] },
        { behind: true, at: [4, 1] },
        { behind: false, at: [4, -1] },
      ],
    },
    offHand: {
      s: [
        { behind: false, at: [3, 0] },
        { behind: false, at: [4, 0] },
        { behind: false, at: [4, -2] },
      ],
      e: [
        { behind: true, at: [2, -1] },
        { behind: true, at: [1, -1] },
        { behind: true, at: [0, -1] },
      ],
      w: [
        { behind: false, at: [-1, 3] },
        { behind: false, at: [0, 3] },
        { behind: false, at: [1, 2] },
      ],
      n: [
        { behind: true, at: [0, 1] },
        { behind: true, at: [0, 2] },
        { behind: true, at: [-1, 3] },
      ],
    },
  },
};
