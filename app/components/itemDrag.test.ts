import { describe, expect, it } from "vitest";
import type { SlotRef } from "../game/itemMoves";
import { releaseTo } from "./useItemDrag";

/**
 * Where letting go of a dragged item sends it.
 *
 * The rule changed for one reason: **a cooling stone was the one refusal a
 * player could see and get no word about.** Dropping one on the floor answered
 * with a sentence; dragging the same stone into a bag answered with nothing,
 * because the drag is gated client-side, no square lit up, and a release onto no
 * lit target fell through to a world drop that found no cell under the panel.
 *
 * These pin the two halves that fix it: a square under the pointer is handed on
 * whether or not it lit up, and everything that is not a square still goes where
 * it went before.
 */

const BAG: SlotRef = { kind: "contents", index: 0 };
const HAND: SlotRef = { kind: "weapon" };
const POINT = { x: 10, y: 20 };

describe("where a release goes", () => {
  it("sends a lit square the move it lit up for", () => {
    expect(releaseTo(HAND, HAND, POINT)).toEqual({ kind: "slot", to: HAND });
  });

  /**
   * The change. The session refuses it and, for a cooling stone, says why —
   * which is the only reason the attempt is worth making at all.
   */
  it("sends a square that did not light up, so the session can answer", () => {
    expect(releaseTo(null, BAG, POINT)).toEqual({ kind: "slot", to: BAG });
  });

  /**
   * And the lit one still wins where they differ. They cannot in practice — a
   * lit square is found by the same lookup — but a rule that read the wrong one
   * of two answers would be a move landing somewhere the player did not aim.
   */
  it("prefers the lit square when the two disagree", () => {
    expect(releaseTo(HAND, BAG, POINT)).toEqual({ kind: "slot", to: HAND });
  });

  it("falls through to the world when the pointer is over no square", () => {
    expect(releaseTo(null, null, POINT)).toEqual({ kind: "world" });
  });

  /**
   * A release with no position at all — a cancel, or a flick whose pointer
   * never reported a move. There is nowhere to put the thing, so it goes back
   * where it came from, which is the gesture's own undo.
   */
  it("does nothing when there is no position to release at", () => {
    expect(releaseTo(null, null, null)).toEqual({ kind: "nothing" });
  });
});
