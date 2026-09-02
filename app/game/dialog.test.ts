import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import type { BrainDef } from "../lib/brain";
import statusesJson from "../../data/statuses.json";
import { DEFAULT_DIALOG, type DialogDef } from "../lib/dialog";
import { DEFAULT_CONTAINER } from "../lib/item";
import { statusesById } from "../lib/status";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";
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

/** Sells a potion for fourteen shards, and blesses a customer once. */
const shopDialog: DialogDef = {
  ...DEFAULT_DIALOG,
  greet: { hear: ["hi"], say: "Hello." },
  bye: { hear: ["bye"], say: "Bye." },
  topics: [
    {
      hear: ["potion"],
      say: "Fourteen shards. Deal?",
      then: [
        {
          hear: ["yes"],
          do: [{ effect: "trade", take: [{ tileId: "shard", count: 14 }], give: [{ tileId: "potion", count: 1 }] }],
          say: "Here you go.",
          else: "That's not fourteen shards.",
        },
      ],
    },
    {
      hear: ["bless"],
      if: { combinator: "and", not: true, rules: [{ cond: "has_tag", tag: "blessed" }] },
      do: [{ effect: "add_status", statusId: "luminous" }, { effect: "tag", tag: "blessed" }],
      say: "Shine.",
      else: "Once is enough.",
    },
    { hear: ["curse"], do: [{ effect: "add_status", statusId: "no-such-status" }], say: "Wither.", else: "I've lost the words." },
  ],
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
    interactions: {
      battler: {
        masteries: { toughness: 10 },
        naturalWeapon: { type: "weapon", damage: 5, def: 0, accuracy: 100, variance: 0, spd: 100, mastery: "fist" },
        kit: [{ slot: "bag", tileId: "bag", chance: 100 }],
      },
    },
  }),
  tile({ id: "bag", kind: "item", intangible: true, interactions: { item: { ...DEFAULT_CONTAINER } } }),
  tile({ id: "shard", kind: "item", intangible: true, interactions: { item: { type: "artifact", pile: 99 } } }),
  tile({ id: "potion", kind: "item", intangible: true, interactions: { item: { type: "consumable", label: "Drink", hp: 0, pile: 4 } } }),
  tile({ id: "shop", height: 4, walkable: false, interactions: { dialog: shopDialog } }),
  tile({ id: "seller", height: 4, walkable: false, interactions: { dialog } }),
  tile({ id: "server", height: 4, walkable: false, interactions: { dialog, brain: standsToServe } }),
  ...normalizeTiles(tilesJson as unknown[]).filter((t) =>
    ["potion-salesman", "arcane-shard", "luminous-potion", "empty-bottle"].includes(t.id),
  ),
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

  it("sells a potion for fourteen shards, and buys a bottle for two", () => {
    let map = fieldWith("potion-salesman");
    map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }, { tileId: "arcane-shard", count: 14 }]);
    map = replaceStack(map, 1, 1, 0, [{ tileId: "grass" }, { tileId: "empty-bottle" }]);
    const session = new GameSession(map, tiles);
    session.pickUp({ x: 0, y: 1, z: 0, stackIndex: 1 });
    session.pickUp({ x: 1, y: 1, z: 0, stackIndex: 1 });
    const say = (line: string) => {
      session.hear("local", line);
      return brainTick(session);
    };
    const bag = () =>
      session.getSnapshot().equipment.bag?.contents?.map((i) =>
        i.count ? `${i.tileId}x${i.count}` : i.tileId,
      );

    say("hi");
    expect(say("potion")).toEqual([expect.stringContaining("Fourteen shards. Deal?")]);
    expect(say("yes")).toEqual([expect.stringContaining("Drink it somewhere dark")]);
    expect(bag()).toEqual(["empty-bottle", "luminous-potion"]);

    expect(say("bottle")).toEqual([expect.stringContaining("Sell one?")]);
    expect(say("yes")).toEqual(["potion-salesman: Ta. Any more?"]);
    expect(bag()).toEqual(["luminous-potion", "arcane-shardx2"]);
    expect(say("yes")).toEqual(["potion-salesman: That's the last of them."]);

    say("potion");
    expect(say("yes")).toEqual([expect.stringContaining("That's not fourteen shards")]);
  });
});

describe("trading through the session", () => {
  const catalogue = statusesById(statusesJson);

  /** The shop two cells east, and whatever else on the cell south. */
  function shopWith(south: PlacedTile | null): GameSession {
    let map = fieldWith("shop");
    if (south) map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }, south]);
    return new GameSession(map, tiles, { statuses: catalogue });
  }

  function bagOf(session: GameSession) {
    return session.getSnapshot().equipment.bag?.contents?.map((i) =>
      i.count ? `${i.tileId}x${i.count}` : i.tileId,
    );
  }

  function talk(session: GameSession, ...lines: string[]): string[] {
    let said: string[] = [];
    for (const line of lines) {
      session.hear("local", line);
      said = brainTick(session);
    }
    return said;
  }

  it("takes the shards and hands over the potion, announcing the kit once", () => {
    const session = shopWith({ tileId: "shard", count: 14 });
    session.pickUp({ x: 0, y: 1, z: 0, stackIndex: 1 });
    session.drainEquipmentChanges();
    expect(talk(session, "hi", "potion", "yes")).toEqual(["shop: Here you go."]);
    expect(bagOf(session)).toEqual(["potion"]);
    expect(session.drainEquipmentChanges()).toEqual([session.getSnapshot().self.id]);
  });

  it("refuses when short, says so, and leaves the kit alone", () => {
    const session = shopWith({ tileId: "shard", count: 13 });
    session.pickUp({ x: 0, y: 1, z: 0, stackIndex: 1 });
    session.drainEquipmentChanges();
    expect(talk(session, "hi", "potion", "yes")).toEqual(["shop: That's not fourteen shards."]);
    expect(bagOf(session)).toEqual(["shardx13"]);
    expect(session.drainEquipmentChanges()).toEqual([]);
  });

  it("pays out of a bag held in a hand", () => {
    const session = shopWith({
      tileId: "bag",
      itemId: "itm_purse",
      contents: [{ id: "itm_shards", tileId: "shard", count: 20 }],
    });
    // A second bag never goes in the bag; it goes to a hand, shards and all.
    session.pickUp({ x: 0, y: 1, z: 0, stackIndex: 1 });
    expect(session.getSnapshot().equipment.offhand?.tileId).toBe("bag");
    expect(talk(session, "hi", "potion", "yes")).toEqual(["shop: Here you go."]);
    expect(session.getSnapshot().equipment.offhand?.contents).toEqual([
      { id: "itm_shards", tileId: "shard", count: 6 },
    ]);
    expect(bagOf(session)).toEqual(["potion"]);
  });

  it("grants a status and a tag together, and reads the tag back", () => {
    const session = shopWith(null);
    expect(talk(session, "hi", "bless")).toEqual(["shop: Shine."]);
    expect(session.statusesOf("local")?.map((s) => s.defId)).toEqual(["luminous"]);
    expect(session.getSnapshot().tags).toEqual(["blessed"]);
    expect(talk(session, "bless")).toEqual(["shop: Once is enough."]);
  });

  it("refuses a status nobody authored, rather than doing half", () => {
    const session = shopWith(null);
    expect(talk(session, "hi", "curse")).toEqual(["shop: I've lost the words."]);
    expect(session.statusesOf("local")).toEqual([]);
  });
});
