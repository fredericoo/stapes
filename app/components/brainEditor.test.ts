import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import type { BrainDef } from "../lib/brain";
import { normalizeTileDef, normalizeTiles, type TileDef } from "../lib/types";
import {
  arrayMove,
  bodyTileIds,
  renamedState,
  selectorOptions,
} from "./BrainEditor";

const frame = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

function tile(partial: Record<string, unknown> & { id: string }): TileDef {
  return normalizeTileDef({
    name: partial.id,
    height: 1,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    ...partial,
  });
}

/** A player, two things that can be bodies, and scenery that cannot. */
const LIBRARY: TileDef[] = [
  tile({ id: "stone-wall", height: 2 }),
  tile({ id: "rat", actor: true }),
  tile({ id: "player", height: 2 }),
  tile({ id: "cat", interactions: { brain: { initial: "i", states: { i: { do: [] } }, transitions: [] } } }),
];

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
    // Every one of these is answerable without anything having been bound: one
    // `nearest:` per tile a body can be, then the two that ask the transition who
    // just spoke and who just swung.
    expect(selectorOptions(brain, LIBRARY)).toEqual([
      "nearest:player",
      "nearest:cat",
      "nearest:rat",
      "speaker",
      "attacker",
    ]);
  });

  it("adds a slot for each thing a transition binds, as $name", () => {
    const brain: BrainDef = {
      initial: "idle",
      states: { idle: { do: [] } },
      transitions: [
        {
          from: "idle",
          if: { cond: "in_range", of: "nearest:player", cells: 3 },
          bind: { spooked: "nearest:player" },
          to: "idle",
        },
      ],
    };
    expect(selectorOptions(brain, LIBRARY)).toEqual([
      "nearest:player",
      "nearest:cat",
      "nearest:rat",
      "speaker",
      "attacker",
      "$spooked",
    ]);
  });

  /**
   * The picker names bodies, not tiles. Offering the whole library would bury
   * the four things anything can be standing on under a hundred walls and floors.
   */
  it("offers only tiles a body can be, player first", () => {
    expect(bodyTileIds(LIBRARY)).toEqual(["player", "cat", "rat"]);
  });

  /**
   * The player is a body because somebody connected to it, not because of an
   * authored flag — so the rule that finds the others cannot find it.
   */
  it("keeps the player even though nothing marks it an actor", () => {
    expect(bodyTileIds([tile({ id: "player", height: 2 })])).toEqual(["player"]);
  });

  /**
   * Against the library we actually ship, because the picker being *short* is the
   * point: a list with every wall and floor in it would be unusable, and nothing
   * about the filter says so until it meets a real tiles.json.
   */
  it("stays short against the shipped library", () => {
    const authored = normalizeTiles(tilesJson as unknown[]);
    const offered = bodyTileIds(authored);

    expect(offered).toEqual(["player", "cat", "deer", "rat", "snake"]);
    expect(offered.length).toBeLessThan(authored.length / 4);
  });
});
