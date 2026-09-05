import { describe, expect, it } from "vitest";
import type { GameInput } from "./GameSession";
import { HeldDirections } from "./heldDirections";

function recorder() {
  const sent: GameInput[] = [];
  const input = new HeldDirections((i) => sent.push(i));
  const latest = () => sent[sent.length - 1];
  return { input, sent, latest };
}

describe("HeldDirections", () => {
  it("walks the way the last press pointed", () => {
    const { input, latest } = recorder();
    input.press("e");
    input.press("n");
    // The simulation takes the last direction in the list, so order is the
    // whole meaning of this list.
    expect(latest()!.directions).toEqual(["e", "n"]);
  });

  it("falls back to what is still held", () => {
    const { input, latest } = recorder();
    input.press("e");
    input.press("n");
    input.release("n");
    expect(latest()!.directions).toEqual(["e"]);
  });

  it("does not stack a repeated press", () => {
    const { input, latest } = recorder();
    input.press("e");
    input.press("e");
    expect(latest()!.directions).toEqual(["e"]);
    // And one release is enough to stop: a second press must not need a second
    // release, or a finger that re-enters a button leaves the avatar walking.
    input.release("e");
    expect(latest()!.directions).toEqual([]);
  });

  it("ignores a release nobody pressed", () => {
    const { input, sent } = recorder();
    input.release("w");
    expect(sent).toEqual([]);
  });

  it("drops everything on clear", () => {
    const { input, latest } = recorder();
    input.press("e");
    input.setModifiers({ faceOnly: true, preferDescend: true });
    input.clear();
    expect(latest()).toEqual({
      directions: [],
      faceOnly: false,
      preferDescend: false,
    });
  });

  /**
   * The renderer sends on every event and a held key repeats, so silence when
   * nothing changed is what keeps a walk across a room from being hundreds of
   * identical messages on the wire.
   */
  it("says nothing when nothing changed", () => {
    const { input, sent } = recorder();
    input.setModifiers({ faceOnly: false, preferDescend: false });
    input.clear();
    expect(sent).toEqual([]);
  });

  it("carries the modifiers alongside", () => {
    const { input, latest } = recorder();
    input.setModifiers({ faceOnly: true, preferDescend: false });
    input.press("s");
    expect(latest()).toEqual({
      directions: ["s"],
      faceOnly: true,
      preferDescend: false,
    });
  });
});

/**
 * A clicked walk is one more thing pressing a direction, and this is where the
 * two are settled — the same "latest wins" rule the keys order themselves by,
 * with the click as a press nobody will ever let go of. @see ./walkTo
 */
describe("a clicked direction against the keys", () => {
  it("outranks a key that was already down", () => {
    const { input, latest } = recorder();
    input.press("e");
    input.setAuto("n");
    expect(latest()!.directions).toEqual(["n"]);
  });

  it("hands the keys back rather than emptying the input", () => {
    const { input, latest } = recorder();
    input.press("e");
    input.setAuto("n");
    input.setAuto(null);
    // The key was never released, so this is what the player's hand is still
    // asking for. Emptying here is a key gone dead in their hand.
    expect(latest()!.directions).toEqual(["e"]);
  });

  it("is dropped by a press, and does not come back", () => {
    const { input, latest } = recorder();
    input.setAuto("n");
    input.press("e");
    expect(latest()!.directions).toEqual(["e"]);
    expect(input.autoPressed).toBe(false);
  });

  it("goes with the keys when the window does", () => {
    const { input, latest } = recorder();
    input.setAuto("n");
    input.clear();
    // Nobody is going to release it, and a body walking itself across town in
    // a tab that is not in front of anybody is the stuck key this guards.
    expect(latest()!.directions).toEqual([]);
    expect(input.autoPressed).toBe(false);
  });

  it("says nothing when asked for the direction it is already walking", () => {
    const { input, sent } = recorder();
    input.setAuto("n");
    input.setAuto("n");
    expect(sent).toHaveLength(1);
  });
});
