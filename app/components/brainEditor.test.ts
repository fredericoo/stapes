import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import { nearest, slot, thing, type BrainDef, type Selector } from "../lib/brain";
import { normalizeTileDef, normalizeTiles, type TileDef } from "../lib/types";
import {
  arrayMove,
  bodyTileIds,
  dropSelfAims,
  paramPatch,
  renamedState,
  selectorVocabulary,
} from "./BrainEditor";
import { ACTIONS, CONDITIONS } from "../lib/brainCatalog";
import { FRAME } from "../lib/testTile";

function tile(partial: Record<string, unknown> & { id: string }): TileDef {
  return normalizeTileDef({
    name: partial.id,
    height: 2,
    directional: false,
    variants: { default: [FRAME] },
    attributes: {},
    ...partial,
  });
}

const LIBRARY: TileDef[] = [
  tile({ id: "stone-wall", height: 4 }),
  tile({ id: "rat", actor: true }),
  tile({ id: "player", height: 4 }),
  tile({
    id: "cat",
    interactions: { brain: { initial: "i", states: { i: { do: [] } }, transitions: [] } },
  }),
];

describe("reordering", () => {
  it("pulls an item out and drops it back in at the target", () => {
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
    expect(Object.keys(renamedState(brain, "idle", "resting").states)).toEqual(["resting", "flee"]);
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
    expect(selectorVocabulary(brain, LIBRARY).kinds.map((k) => k.key)).toEqual([
      "nearest",
      "thing",
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
    expect(selectorVocabulary(brain, LIBRARY).kinds.map((k) => k.key)).toEqual([
      "nearest",
      "thing",
      "speaker",
      "attacker",
      "home",
      "$spooked",
    ]);
  });

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
    const { kinds } = selectorVocabulary(brain, LIBRARY);

    expect(kinds[0]!.make()).toEqual(nearest("player"));
    expect(kinds.at(-1)!.make()).toEqual(slot("spooked"));
  });

  it("labels each tile chip with the tile name", () => {
    const named = [tile({ id: "player", height: 4, name: "Player" })];
    const { kinds } = selectorVocabulary(
      { initial: "i", states: { i: { do: [] } }, transitions: [] },
      named,
    );
    expect(kinds[0]!.tiles).toEqual([{ tileId: "player", label: "Player" }]);
  });

  it("offers only tiles a body can be, player first", () => {
    expect(bodyTileIds(LIBRARY)).toEqual(["player", "cat", "rat"]);
  });

  it("keeps the player even though nothing marks it an actor", () => {
    expect(bodyTileIds([tile({ id: "player", height: 4 })])).toEqual(["player"]);
  });

  it("stays short against the shipped library", () => {
    const authored = normalizeTiles(tilesJson as unknown[]);
    const offered = bodyTileIds(authored);

    expect(offered[0]).toBe("player");
    expect(offered.length).toBeGreaterThan(1);
    expect(offered.length).toBeLessThan(authored.length / 4);
  });
});

describe("editing a parameter", () => {
  const NOISE_TEXT = CONDITIONS.heard_noise.params.find((spec) => spec.key === "text")!;

  it("writes a value somebody typed", () => {
    expect(paramPatch({ cond: "heard_noise", cells: 20 }, NOISE_TEXT, "howl")).toEqual({
      cond: "heard_noise",
      cells: 20,
      text: "howl",
    });
  });

  it("takes the key away again when the box is emptied", () => {
    const patched = paramPatch({ cond: "heard_noise", cells: 20, text: "howl" }, NOISE_TEXT, "");

    expect(patched).toEqual({ cond: "heard_noise", cells: 20 });
    expect(patched).not.toHaveProperty("text");
  });

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

    expect(paramPatch({ cond: "heard", text: "ps", cells: 5, los: true }, los, false)).toEqual({
      cond: "heard",
      text: "ps",
      cells: 5,
    });
  });
});

describe("picking a spell for a cast row", () => {
  const CAST = ACTIONS.cast.params;
  const SPELL = CAST.find((spec) => spec.key === "spell")!;
  const brain: BrainDef = { initial: "i", states: { i: { do: [] } }, transitions: [] };
  const vocab = selectorVocabulary(brain, LIBRARY, {}, [
    { name: "Curl up", effect: { kind: "bolt", on: "caster", statuses: [] } },
    { name: "Ember", effect: { kind: "bolt", on: "target", damage: 4 } },
  ]);
  const aimed = { action: "cast", spell: 2, of: nearest("player") };

  it("drops the target when the spell lands on its caster", () => {
    const next = dropSelfAims(paramPatch(aimed, SPELL, 1), CAST, vocab);

    expect(next).toEqual({ action: "cast", spell: 1 });
  });

  it("keeps it for a spell that needs somebody", () => {
    expect(dropSelfAims(aimed, CAST, vocab)).toEqual(aimed);
  });
});

describe("what a selector affords", () => {
  const ORCHARD: TileDef[] = [
    ...LIBRARY,
    tile({
      id: "bush",
      interactions: {
        extract: {
          actionName: "Pick",
          durability: 3,
          tileId: "picked-bush",
          durationMs: 2000,
          slots: [{ tileId: "berry", chance: 100 }],
        },
      },
    }),
    tile({ id: "boulder", interactions: { push: { climb: "half", moveOnTileIds: [] } } }),
    tile({ id: "hedge", height: 2 }),
  ];

  function tilesFor(brain: BrainDef, key: string) {
    const kind = selectorVocabulary(brain, ORCHARD).kinds.find((one) => one.key === key);
    return kind?.tiles.map((one) => one.tileId);
  }

  function describe_(brain: BrainDef, selector: Selector) {
    return selectorVocabulary(brain, ORCHARD).describe(selector);
  }

  const IDLE: BrainDef = {
    initial: "idle",
    states: { idle: { do: [] } },
    transitions: [],
  };

  it("offers a thing for every tile that does something", () => {
    const things = tilesFor(IDLE, "thing");
    expect(things).toContain("bush");
    expect(things).toContain("boulder");
    expect(things).not.toContain("hedge");
    expect(things).not.toContain("rat");
  });

  it("says what the tile can have done to it, in the author's own word", () => {
    expect(describe_(IDLE, thing("bush"))).toEqual({
      tiles: ["bush"],
      affords: ["pick"],
    });
    expect(describe_(IDLE, nearest("rat"))?.affords).toEqual(["attack"]);
  });

  it("names only the verbs a brain actually has", () => {
    expect(describe_(IDLE, thing("boulder"))).toEqual({
      tiles: ["boulder"],
      affords: [],
    });
  });

  it("unions the verbs across a list of tiles", () => {
    expect(describe_(IDLE, thing("bush", "boulder"))).toEqual({
      tiles: ["bush", "boulder"],
      affords: ["pick"],
    });
  });

  it("carries the answer through to the slot the brain binds", () => {
    const brain: BrainDef = {
      ...IDLE,
      transitions: [
        {
          from: "idle",
          if: { cond: "stuck" },
          bind: { bush: thing("bush") },
          to: "idle",
        },
      ],
    };

    expect(describe_(brain, slot("bush"))).toEqual({
      tiles: ["bush"],
      affords: ["pick"],
    });
  });

  it("says nothing about a selector that names no tile", () => {
    expect(describe_(IDLE, { type: "speaker" })).toBeNull();
    expect(describe_(IDLE, { type: "home" })).toBeNull();
  });
});
