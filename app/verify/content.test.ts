import { describe, expect, it } from "vitest";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile } from "../lib/types";
import { checkContent, type Finding } from "./content";

type Json = Record<string, any>;

type Content = { tiles: Json[]; statuses: Json[]; traits: Json[]; tilesets: Json[]; map: MapFile };

function tile(id: string, fields: Json = {}): Json {
  return {
    id,
    name: id,
    height: 0,
    type: "simple",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: "sheet", x: 0, y: 0 },
    sprite: {
      frames: [
        { sprite: { rect: { x: 0, y: 0, w: 1, h: 1 }, base: { x: 0, y: 0 } }, durationMs: 200 },
      ],
    },
    ...fields,
  };
}

function autotile(id: string): Json {
  const frames = [
    { sprite: { rect: { x: 0, y: 0, w: 1, h: 1 }, base: { x: 0, y: 0 } }, durationMs: 200 },
  ];
  return tile(id, { type: "autotile", sprite: undefined, slices: { 0: { frames } } });
}

function content(): Content {
  const rat = tile("rat", {
    kind: "battler",
    interactions: {
      battler: {
        baseHp: 8,
        masteries: { sharp: 4 },
        naturalWeapon: {
          type: "weapon",
          damage: 1,
          def: 0,
          accuracy: 78,
          variance: 20,
          spd: 68,
          mastery: "sharp",
        },
        kit: [{ slot: "weapon", tileId: "bread", chance: 5 }],
      },
    },
  });
  return {
    tiles: [
      tile("player"),
      tile("bread", { kind: "item", interactions: { item: { type: "consumable", hp: 1 } } }),
      rat,
    ],
    statuses: [
      {
        id: "poison",
        name: "Poisoned",
        description: "Hurts for a while.",
        tone: "bad",
        fromMs: 1_000,
        toMs: 2_000,
        everyMs: "1000 * (2 - has_status('combat'))",
        effects: { hp: "0 - 1" },
      },
    ],
    traits: [
      {
        id: "naps",
        name: "Naps",
        states: { napping: { do: [{ action: "hold" }] } },
        triggers: [{ if: { cond: "stuck" }, to: "napping" }],
        transitions: [],
      },
    ],
    tilesets: [{ id: "sheet", name: "Sheet", file: "sheet.png", width: 16, height: 16 }],
    map: replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "player" }]),
  };
}

function check(c: Content) {
  return checkContent({
    tiles: { value: c.tiles },
    statuses: { value: c.statuses },
    traits: { value: c.traits },
    tilesets: { value: c.tilesets },
    sheetSizes: { "sheet.png": { width: 16, height: 16 } },
    map: { value: c.map },
  });
}

const battlerOf = (c: Content) => c.tiles.find((t) => t.id === "rat")!.interactions.battler;

const FAULTS: {
  fault: string;
  seed: (c: Content) => void;
  found: Omit<Finding, "message">;
}[] = [
  {
    fault: "a natural spell cast in 0ms, which drops the whole battler block",
    seed: (c) => {
      battlerOf(c).spells = [
        {
          type: "stone",
          name: "Bite",
          effect: { kind: "bolt", damage: 2, on: "target" },
          cooldownMs: 5_000,
          castTimeMs: 0,
        },
      ];
    },
    found: { severity: "error", file: "tiles.json", id: "rat", path: "interactions.battler" },
  },
  {
    fault: "a human naming a head nobody drew",
    seed: (c) => {
      c.tiles.find((t) => t.id === "rat")!.human = { skin: "default", hair: "red", head: "mohawk" };
    },
    found: { severity: "error", file: "tiles.json", id: "rat", path: "human" },
  },
  {
    fault: "a human on a tile whose frames are not one character block",
    seed: (c) => {
      c.tiles.find((t) => t.id === "rat")!.human = {
        skin: "default",
        hair: "red",
        head: "short-hair",
      };
    },
    found: { severity: "error", file: "tiles.json", id: "rat", path: "human" },
  },
  {
    fault: "armour drawn as a part from another layer than its slot dresses",
    seed: (c) => {
      c.tiles.push(
        tile("boots", {
          kind: "item",
          interactions: {
            item: { type: "armor", slot: "footwear", def: 1, humanPart: "iron-helmet" },
          },
        }),
      );
    },
    found: {
      severity: "error",
      file: "tiles.json",
      id: "boots",
      path: "interactions.item.humanPart",
    },
  },
  {
    fault: "a kit naming a tile nobody defines",
    seed: (c) => {
      battlerOf(c).kit[0].tileId = "loaf";
    },
    found: {
      severity: "error",
      file: "tiles.json",
      id: "rat",
      path: "interactions.battler.kit[0].tileId",
    },
  },
  {
    fault: "a kit row the schema refuses, which empties the whole kit",
    seed: (c) => {
      battlerOf(c).kit[0].slot = "mouth";
    },
    found: { severity: "error", file: "tiles.json", id: "rat", path: "interactions.battler.kit" },
  },
  {
    fault: "a brain casting a spell the body does not have",
    seed: (c) => {
      c.tiles.find((t) => t.id === "rat")!.interactions.brain = {
        initial: "idle",
        states: { idle: { do: [{ action: "cast", spell: 1 }] } },
        transitions: [],
      };
    },
    found: {
      severity: "error",
      file: "tiles.json",
      id: "rat",
      path: "interactions.brain.states.idle.do[0].spell",
    },
  },
  {
    fault: "a brain calling a trait nobody defines",
    seed: (c) => {
      c.tiles.find((t) => t.id === "rat")!.interactions.brain = {
        initial: "idle",
        states: { idle: { do: [{ action: "hold" }] } },
        transitions: [],
        traits: [{ trait: "sleepwalks" }],
      };
    },
    found: { severity: "error", file: "tiles.json", id: "rat", path: "interactions.brain" },
  },
  {
    fault: "a status formula asking about a status nobody defines",
    seed: (c) => {
      c.statuses[0]!.everyMs = "1000 * (2 - has_status('fighting'))";
    },
    found: { severity: "error", file: "statuses.json", id: "poison", path: "everyMs" },
  },
  {
    fault: "art that runs off the bottom of its sheet",
    seed: (c) => {
      c.tiles.find((t) => t.id === "bread")!.anchor.y = 2;
    },
    found: { severity: "error", file: "tiles.json", id: "bread", path: "anchor" },
  },
  {
    fault: "mud on dirt with nothing under either but each other",
    seed: (c) => {
      c.tiles.push(tile("grass-2"), autotile("dirt"), autotile("mud"));
      c.map = replaceStack(c.map, 3, 0, 0, [{ tileId: "dirt" }, { tileId: "mud" }]);
      c.map = replaceStack(c.map, 4, 0, 0, [{ tileId: "grass-2" }]);
    },
    found: { severity: "warn", file: "map.json", id: "mud", path: "" },
  },
  {
    fault: "a path on grass beside sand it does not connect to",
    seed: (c) => {
      c.tiles.push(tile("grass-2"), tile("sand-dunes"), autotile("dirt"));
      c.map = replaceStack(c.map, 3, 0, 0, [{ tileId: "grass-2" }, { tileId: "dirt" }]);
      c.map = replaceStack(c.map, 4, 0, 0, [{ tileId: "sand-dunes" }]);
    },
    found: { severity: "warn", file: "map.json", id: "dirt", path: "" },
  },
  {
    fault: "water under the rim of deep water it does not connect to",
    seed: (c) => {
      c.tiles.push(autotile("water"), autotile("deep-water"));
      c.map = replaceStack(c.map, 3, 0, 0, [{ tileId: "water" }, { tileId: "deep-water" }]);
      c.map = replaceStack(c.map, 4, 0, 0, [{ tileId: "deep-water" }]);
    },
    found: { severity: "warn", file: "map.json", id: "water", path: "" },
  },
  {
    fault: "a map with a second player tile",
    seed: (c) => {
      c.map = replaceStack(c.map, 5, 0, 0, [{ tileId: "player" }]);
    },
    found: { severity: "warn", file: "map.json", id: "player", path: "" },
  },
];

describe("checkContent", () => {
  it("finds nothing in content that loads and names only what exists", () => {
    expect(check(content()).findings).toEqual([]);
  });

  it("loads a brain built from a trait the way the game expands it", () => {
    const c = content();
    c.tiles.find((t) => t.id === "rat")!.interactions.brain = {
      initial: "idle",
      states: { idle: { do: [{ action: "hold" }] } },
      transitions: [],
      traits: [{ trait: "naps" }],
    };

    expect(check(c).findings).toEqual([]);
  });

  it("accepts mud on dirt with a full tile under them", () => {
    const c = content();
    c.tiles.push(tile("grass-2"), autotile("dirt"), autotile("mud"));
    c.map = replaceStack(c.map, 3, 0, 0, [
      { tileId: "grass-2" },
      { tileId: "dirt" },
      { tileId: "mud" },
    ]);

    expect(check(c).findings.filter((f) => f.file === "map.json")).toEqual([]);
  });

  it("accepts mud on dirt inside a field of dirt, which draws whole under it", () => {
    const c = content();
    c.tiles.push(tile("grass-2"), autotile("dirt"), autotile("mud"));
    for (let x = 2; x <= 8; x++) {
      for (let y = -3; y <= 3; y++) c.map = replaceStack(c.map, x, y, 0, [{ tileId: "dirt" }]);
    }
    c.map = replaceStack(c.map, 5, 0, 0, [{ tileId: "dirt" }, { tileId: "mud" }]);

    expect(check(c).findings.filter((f) => f.id === "mud")).toEqual([]);
  });

  it("accepts dirt with nothing under it whose edges face only empty cells", () => {
    const c = content();
    c.tiles.push(autotile("dirt"));
    c.map = replaceStack(c.map, 3, 0, 0, [{ tileId: "dirt" }]);

    expect(check(c).findings.filter((f) => f.file === "map.json")).toEqual([]);
  });

  it("accepts a path on grass beside sand it connects to", () => {
    const c = content();
    c.tiles.push(tile("grass-2"), tile("sand-dunes"), {
      ...autotile("dirt"),
      connectsTo: ["sand-dunes"],
    });
    c.map = replaceStack(c.map, 3, 0, 0, [{ tileId: "grass-2" }, { tileId: "dirt" }]);
    c.map = replaceStack(c.map, 4, 0, 0, [{ tileId: "sand-dunes" }]);

    expect(check(c).findings.filter((f) => f.file === "map.json")).toEqual([]);
  });

  it("accepts a path on grass beside grass and beside a path on sand", () => {
    const c = content();
    c.tiles.push(tile("grass-2"), tile("sand-dunes"), autotile("dirt"));
    c.map = replaceStack(c.map, 3, 0, 0, [{ tileId: "grass-2" }]);
    c.map = replaceStack(c.map, 4, 0, 0, [{ tileId: "grass-2" }, { tileId: "dirt" }]);
    c.map = replaceStack(c.map, 5, 0, 0, [{ tileId: "sand-dunes" }, { tileId: "dirt" }]);

    expect(check(c).findings.filter((f) => f.file === "map.json")).toEqual([]);
  });

  it("accepts water on sand beside a path over grass that connects to sand", () => {
    const c = content();
    c.tiles.push(tile("grass-2"), tile("sand-dunes"), autotile("water"), {
      ...autotile("dirt"),
      connectsTo: ["sand-dunes"],
    });
    for (let x = 2; x <= 8; x++) {
      for (let y = -3; y <= 3; y++) {
        c.map = replaceStack(c.map, x, y, 0, [{ tileId: "grass-2" }, { tileId: "dirt" }]);
      }
    }
    c.map = replaceStack(c.map, 5, 0, 0, [{ tileId: "sand-dunes" }, { tileId: "water" }]);

    expect(check(c).findings.filter((f) => f.file === "map.json")).toEqual([]);
  });

  it("accepts water under the rim of deep water it connects to", () => {
    const c = content();
    c.tiles.push({ ...autotile("water"), connectsTo: ["deep-water"] }, autotile("deep-water"));
    c.map = replaceStack(c.map, 3, 0, 0, [{ tileId: "water" }, { tileId: "deep-water" }]);
    c.map = replaceStack(c.map, 4, 0, 0, [{ tileId: "deep-water" }]);

    expect(check(c).findings.filter((f) => f.file === "map.json")).toEqual([]);
  });

  it.each(FAULTS)("reports $fault", ({ seed, found }) => {
    const faulty = content();
    seed(faulty);
    const report = check(faulty);

    expect(report.findings).toContainEqual(expect.objectContaining(found));
    expect(report.ok).toBe(found.severity === "warn");
  });
});
