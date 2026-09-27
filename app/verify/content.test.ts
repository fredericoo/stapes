import { describe, expect, it } from "vitest";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile } from "../lib/types";
import { checkContent, type Finding } from "./content";

type Json = Record<string, any>;

type Content = { tiles: Json[]; statuses: Json[]; tilesets: Json[]; map: MapFile };

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
    tilesets: [{ id: "sheet", name: "Sheet", file: "sheet.png", width: 16, height: 16 }],
    map: replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "player" }]),
  };
}

function check(c: Content) {
  return checkContent({
    tiles: { value: c.tiles },
    statuses: { value: c.statuses },
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

  it.each(FAULTS)("reports $fault", ({ seed, found }) => {
    const faulty = content();
    seed(faulty);
    const report = check(faulty);

    expect(report.findings).toContainEqual(expect.objectContaining(found));
    expect(report.ok).toBe(found.severity === "warn");
  });
});
