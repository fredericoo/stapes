import { describe, expect, it } from "vitest";
import type { BrainDef } from "../lib/brain";
import { moved, renamedState, selectorOptions } from "./BrainEditor";

/**
 * The editor's pure moves, tested where the correctness actually lives: order is
 * the semantics, so a reorder that dropped an item or a rename that missed a
 * reference would author a different creature than the one on screen.
 */

describe("reordering", () => {
  it("swaps a neighbour and leaves the rest", () => {
    expect(moved(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moved(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
  });

  it("is a no-op past either edge", () => {
    expect(moved(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moved(["a", "b"], 1, 1)).toEqual(["a", "b"]);
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
  it("is the live query alone when nothing is bound", () => {
    const brain: BrainDef = {
      initial: "idle",
      states: { idle: { do: [] } },
      transitions: [],
    };
    expect(selectorOptions(brain)).toEqual(["nearest_player"]);
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
    expect(selectorOptions(brain)).toEqual(["nearest_player", "$spooked"]);
  });
});
