import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import type { BrainDef } from "../lib/brain";
import { DEFAULT_DIALOG, type DialogDef } from "../lib/dialog";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef, normalizeTiles } from "../lib/types";
import { BRAIN_TICK_MS, TICK_MS } from "./constants";
import { GameSession } from "./GameSession";

/**
 * A conversation through the session: a word said by the player reaches the
 * seller's ear on the brain tick, the reply comes out as a bubble on the
 * seller's cell, and the seller's brain can see that it is talking.
 *
 * `./dialogRuntime.test` pins the rules of the conversation itself; this is
 * about the plumbing either side of it.
 */

const frame = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

function tile(partial: Record<string, unknown>): TileDef {
  return normalizeTileDef({
    name: partial.id,
    height: 0,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    kind: "prop",
    ...partial,
  });
}

const dialog: DialogDef = {
  ...DEFAULT_DIALOG,
  greet: { hear: ["hi"], say: "Hello, {partner}." },
  bye: { hear: ["bye"], say: "Bye." },
  topics: [{ hear: ["potion"], say: "Fourteen shards." }],
};

/** Stands still, and says so the moment a conversation starts. */
const standsToServe: BrainDef = {
  initial: "idle",
  states: {
    idle: { do: [{ action: "hold" }] },
    serving: { onEnter: [{ effect: "say", text: "At your service." }], do: [{ action: "hold" }] },
  },
  transitions: [
    { from: "idle", if: { cond: "talking" }, to: "serving" },
    { from: "serving", if: { combinator: "and", not: true, rules: [{ cond: "talking" }] }, to: "idle" },
  ],
};

const tiles: TileDef[] = [
  tile({ id: "grass" }),
  // Two levels tall: a looker sees over anything no taller than itself.
  tile({ id: "crate", height: 8, walkable: false }),
  tile({
    id: "player",
    height: 4,
    kind: "battler",
    directional: true,
    walkable: false,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
  }),
  tile({ id: "seller", height: 4, walkable: false, interactions: { dialog } }),
  tile({ id: "server", height: 4, walkable: false, interactions: { dialog, brain: standsToServe } }),
  ...normalizeTiles(tilesJson as unknown[]).filter((t) => t.id === "potion-salesman"),
];

/** Open grass, the player at the origin and one body two cells east. */
function fieldWith(body: string, half = 6): MapFile {
  let map = emptyMap();
  for (let x = -half; x <= half; x++) {
    for (let y = -half; y <= half; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "e" }]);
  return replaceStack(map, 2, 0, 0, [{ tileId: "grass" }, { tileId: body }]);
}

/** Run one brain tick's worth of simulation, collecting what was said. */
function brainTick(session: GameSession): string[] {
  const said: string[] = [];
  for (let elapsed = 0; elapsed < BRAIN_TICK_MS; elapsed += TICK_MS) {
    session.tick(TICK_MS);
    for (const bubble of session.drainSpeech()) said.push(`${bubble.tileId}: ${bubble.text}`);
  }
  return said;
}

describe("talking to a body through the session", () => {
  it("answers a greeting with a bubble on the seller's cell", () => {
    const session = new GameSession(fieldWith("seller"), tiles);
    session.hear("local", "hi");
    const said = brainTick(session);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^seller: Hello, .+\.$/);
    // The partner is named as the name tag names them, never as an id.
    expect(said[0]).not.toContain("local");
  });

  it("hears a word once, on the tick after it was said", () => {
    const session = new GameSession(fieldWith("seller"), tiles);
    session.hear("local", "hi");
    brainTick(session);
    expect(brainTick(session)).toEqual([]);
  });

  it("answers a topic once greeted, and not before", () => {
    const session = new GameSession(fieldWith("seller"), tiles);
    session.hear("local", "potion");
    expect(brainTick(session)).toEqual([]);
    session.hear("local", "hi");
    brainTick(session);
    session.hear("local", "potion");
    expect(brainTick(session)).toEqual(["seller: Fourteen shards."]);
  });

  it("does not hear through a wall", () => {
    let map = fieldWith("seller");
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "crate" }]);
    const session = new GameSession(map, tiles);
    session.hear("local", "hi");
    expect(brainTick(session)).toEqual([]);
  });

  it("does not hear a creature speak, only a person", () => {
    // Two sellers side by side: one greeted, its reply is not a greeting to
    // the other. `recordSpeech` never reaches `hear`, by design.
    let map = fieldWith("seller");
    map = replaceStack(map, 0, 2, 0, [{ tileId: "grass" }, { tileId: "seller" }]);
    const session = new GameSession(map, tiles);
    session.hear("local", "hi");
    expect(brainTick(session)).toHaveLength(2);
    expect(brainTick(session)).toEqual([]);
  });

  it("lets the brain stand to serve while a conversation is on", () => {
    const session = new GameSession(fieldWith("server"), tiles);
    session.hear("local", "hi");
    const said = brainTick(session);
    // The dialog is stepped ahead of the brain, so the greeting and the brain's
    // reaction land on the same tick — mouth first.
    expect(said[0]).toMatch(/^server: Hello/);
    expect(said[1]).toBe("server: At your service.");

    session.hear("local", "bye");
    expect(brainTick(session)).toEqual(["server: Bye."]);
    // Back to idle, and a second greeting serves again.
    session.hear("local", "hi");
    expect(brainTick(session)[1]).toBe("server: At your service.");
  });

  it("is a body at all: a tile with only a dialog is adopted", () => {
    const session = new GameSession(fieldWith("seller"), tiles);
    expect(session.actorSnapshots().map((a) => a.tileId).sort()).toEqual(["player", "seller"]);
  });
});

describe("the potion salesman, as authored", () => {
  it("greets, explains the recipe, and says goodbye", () => {
    const session = new GameSession(fieldWith("potion-salesman"), tiles);
    session.hear("local", "hello");
    expect(brainTick(session)[0]).toMatch(/^potion-salesman: Hello, .+ Ask me about the potion/);
    session.hear("local", "how do you make it?");
    expect(brainTick(session)).toEqual([
      expect.stringContaining("Ten arcane crystals"),
    ]);
    session.hear("local", "bye");
    expect(brainTick(session)).toEqual([expect.stringContaining("Mind the dark")]);
  });
});
