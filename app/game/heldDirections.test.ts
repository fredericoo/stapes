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
