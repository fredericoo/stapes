import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import { nearest, slot, type BrainDef } from "../lib/brain";
import { normalizeTileDef, normalizeTiles, type TileDef } from "../lib/types";
import {
  arrayMove,
  bodyTileIds,
  paramPatch,
  renamedState,
  selectorOptions,
} from "./BrainEditor";
import { CONDITIONS } from "../lib/brainCatalog";

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
      flee: { do: [{ action: "step_away_from", of: slot("spooked") }] },
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
    // `nearest` per tile a body can be, then the two that ask the transition who
    // just spoke and who just swung, then the one that names a place instead of
    // a body.
    expect(selectorOptions(brain, LIBRARY).map((o) => o.key)).toEqual([
      "nearest:player",
      "nearest:cat",
      "nearest:rat",
      "speaker",
      "attacker",
      "home",
    ]);
  });

  it("adds a slot for each thing a transition binds, as $name", () => {
    const brain: BrainDef = {
      initial: "idle",
      states: { idle: { do: [] } },
      transitions: [
        {
          from: "idle",
          if: { cond: "in_range", of: nearest("player"), cells: 3 },
          bind: { spooked: nearest("player") },
          to: "idle",
        },
      ],
    };
    expect(selectorOptions(brain, LIBRARY).map((o) => o.key)).toEqual([
      "nearest:player",
      "nearest:cat",
      "nearest:rat",
      "speaker",
      "attacker",
      "home",
      "$spooked",
    ]);
  });

  /** The value behind each option is the object the brain actually stores. */
  it("carries the selector itself, not a string to be parsed back", () => {
    const brain: BrainDef = {
      initial: "idle",
      states: { idle: { do: [] } },
      transitions: [
        {
          from: "idle",
          if: { cond: "stuck" },
          bind: { spooked: nearest("player") },
          to: "idle",
        },
      ],
    };
    const options = selectorOptions(brain, LIBRARY);

    expect(options[0]!.selector).toEqual(nearest("player"));
    expect(options.at(-1)!.selector).toEqual(slot("spooked"));
  });

  /** A tile's own name, so the picker reads as the world does. */
  it("labels each nearest option with the tile name", () => {
    const named = [tile({ id: "player", height: 2, name: "Player" })];
    expect(selectorOptions({ initial: "i", states: { i: { do: [] } }, transitions: [] }, named)[0])
      .toMatchObject({ key: "nearest:player", label: "nearest Player" });
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

    expect(offered).toEqual([
      "player",
      "cat",
      "cave-troll",
      "deer",
      "rat",
      "shopkeeper",
      "snake",
      "wolf",
    ]);
    expect(offered.length).toBeLessThan(authored.length / 4);
  });
});

/**
 * Writing one field back into a condition.
 *
 * The interesting half is what happens to a field somebody emptied: a value
 * meaning "not set" has to leave the key off entirely, because the schema reads
 * absence and a falsy value as two different things — and one of them makes the
 * creature inert.
 */
describe("editing a parameter", () => {
  /** The text box on `heard noise`, which is authored as optional. */
  const NOISE_TEXT = CONDITIONS.heard_noise.params.find(
    (spec) => spec.key === "text",
  )!;

  it("writes a value somebody typed", () => {
    expect(paramPatch({ cond: "heard_noise", cells: 20 }, NOISE_TEXT, "howl")).toEqual({
      cond: "heard_noise",
      cells: 20,
      text: "howl",
    });
  });

  /** An empty box on an optional field is "any sound", not a word of no letters. */
  it("takes the key away again when the box is emptied", () => {
    const patched = paramPatch(
      { cond: "heard_noise", cells: 20, text: "howl" },
      NOISE_TEXT,
      "",
    );

    expect(patched).toEqual({ cond: "heard_noise", cells: 20 });
    expect(patched).not.toHaveProperty("text");
  });

  /**
   * The same emptied box on a field that requires one stays empty and stays
   * broken, which is the honest outcome: there is no "any word" to fall back to.
   */
  it("leaves a required text where it is, empty and all", () => {
    const required = CONDITIONS.heard.params.find((spec) => spec.key === "text")!;

    expect(paramPatch({ cond: "heard", text: "ps", cells: 5 }, required, "")).toEqual({
      cond: "heard",
      text: "",
      cells: 5,
    });
  });

  it("authors a false flag as its absence", () => {
    const los = CONDITIONS.heard.params.find((spec) => spec.key === "los")!;

    expect(
      paramPatch({ cond: "heard", text: "ps", cells: 5, los: true }, los, false),
    ).toEqual({ cond: "heard", text: "ps", cells: 5 });
  });
});
