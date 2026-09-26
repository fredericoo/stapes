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
