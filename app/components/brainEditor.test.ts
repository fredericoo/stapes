import { describe, expect, it } from "vitest";
import type { BrainDef } from "../lib/brain";
import { arrayMove, renamedState, selectorOptions } from "./BrainEditor";

/**
 * The editor's pure moves, tested where the correctness actually lives: order is
 * the semantics, so a reorder that dropped an item or a rename that missed a
 * reference would author a different creature than the one on screen.
 */

describe("reordering", () => {
  it("pulls an item out and drops it back in at the target", () => {
    // Drag the head to the tail, and a middle item up to the front.
    expect(arrayMove(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(arrayMove(["a", "b", "c"], 1, 0)).toEqual(["b", "a", "c"]);
  });

  it("is a no-op in place or out of bounds", () => {
    expect(arrayMove(["a", "b"], 1, 1)).toEqual(["a", "b"]);
    expect(arrayMove(["a", "b"], 0, 5)).toEqual(["a", "b"]);
  });
});

describe("renaming a state", () => {
  const brain: BrainDef = {
    initial: "idle",
    states: {
      idle: { do: [{ action: "hold" }] },
      flee: { do: [{ action: "step_away_from", of: "$spooked" }] },
    },
    transitions: [
      { from: "idle", if: { cond: "stuck" }, to: "flee" },
      { from: "flee", if: { cond: "stuck" }, to: "idle" },
    ],
  };

  it("re-keys the state and every reference to it", () => {
    const next = renamedState(brain, "flee", "bolt");
    expect(Object.keys(next.states)).toEqual(["idle", "bolt"]);
    expect(next.transitions[0]!.to).toBe("bolt");
    expect(next.transitions[1]!.from).toBe("bolt");
  });

  it("follows the initial pointer when the initial state is renamed", () => {
    expect(renamedState(brain, "idle", "resting").initial).toBe("resting");
  });

  it("keeps the states in their authored order", () => {
    // Order is not semantic for states, but a rename that reshuffled them would
    // scramble the editor's own list under the author's hands.
    expect(Object.keys(renamedState(brain, "idle", "resting").states)).toEqual([
      "resting",
      "flee",
    ]);
  });

  it("leaves a wildcard source alone", () => {
    const wild: BrainDef = {
      ...brain,
      transitions: [{ from: "any", if: { cond: "stuck" }, to: "flee" }],
    };
    expect(renamedState(wild, "flee", "bolt").transitions[0]!.from).toBe("any");
  });
});

describe("offering selectors", () => {
  it("is the live queries alone when nothing is bound", () => {
    const brain: BrainDef = {
      initial: "idle",
      states: { idle: { do: [] } },
      transitions: [],
    };
    // Both are answerable without anything having been bound: one asks the
    // board who is nearest, the other asks the transition who just spoke.
    expect(selectorOptions(brain)).toEqual(["nearest_player", "speaker"]);
  });

  it("adds a slot for each thing a transition binds, as $name", () => {
    const brain: BrainDef = {
      initial: "idle",
      states: { idle: { do: [] } },
      transitions: [
        {
          from: "idle",
          if: { cond: "in_range", of: "nearest_player", cells: 3 },
          bind: { spooked: "nearest_player" },
          to: "idle",
        },
      ],
    };
    expect(selectorOptions(brain)).toEqual([
      "nearest_player",
      "speaker",
      "$spooked",
    ]);
  });
});
