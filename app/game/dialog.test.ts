import { describe, expect, it } from "vitest";
import statusesJson from "../../data/statuses.json";
import tilesJson from "../../data/tiles.json";
import type { BrainDef } from "../lib/brain";
import type { DialogDef } from "../lib/dialog";
import { DEFAULT_CONTAINER } from "../lib/item";
import { emptyMap, replaceStack } from "../lib/mapData";
import { statusesById } from "../lib/status";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";
import { normalizeTileDef, normalizeTiles } from "../lib/types";
import type { ObjectRef } from "./affordances";
import { BRAIN_TICK_MS, TICK_MS } from "./constants";
import { GameSession } from "./GameSession";

/**
 * A conversation through the session: Talk pressed on a body, buttons pressed
 * on the panel, and the world deciding what each press comes to.
 *
 * `./dialogRuntime.test` pins what a press does to a conversation; this is
 * about the plumbing either side of it — reach, who may talk at once, the
 * brain seeing it, and a trade actually moving things.
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
  opening: "Hello, {partner}.",
  options: [
    { label: "Recipe", say: "Fourteen shards." },
    {
      label: "Buy",
      say: "Deal?",
      then: [
        {
          label: "Yes",
          do: [{ effect: "trade", take: [{ tileId: "shard", count: 14 }], give: [{ tileId: "potion", count: 1 }] }],
          say: "Here you go.",
          else: "That's not fourteen shards.",
        },
      ],
    },
    {
      label: "Bless me",
      if: { combinator: "and", not: true, rules: [{ cond: "has_tag", tag: "blessed" }] },
      do: [{ effect: "add_status", statusId: "luminous" }, { effect: "tag", tag: "blessed" }],
      say: "Shine.",
      else: "Once is enough.",
    },
    {
      label: "Curse me",
      do: [{ effect: "add_status", statusId: "no-such-status" }],
      say: "Wither.",
      else: "I've lost the words.",
    },
  ],
};

/** Stands still, and says so the moment anybody starts talking to it. */
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
  tile({ id: "wall", height: 8, walkable: false }),
  tile({ id: "step", height: 2, walkable: true }),
  tile({ id: "block", height: 4, walkable: true }),
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
  tile({ id: "seller", height: 4, walkable: false, interactions: { dialog } }),
  tile({ id: "server", height: 4, walkable: false, interactions: { dialog, brain: standsToServe } }),
  ...normalizeTiles(tilesJson as unknown[]).filter((t) =>
    ["potion-salesman", "arcane-shard", "luminous-potion", "empty-bottle"].includes(t.id),
  ),
];

const catalogue = statusesById(statusesJson);

/** Open grass, the player at the origin and one body at (bx, by). */
function fieldWith(body: string, bx = 2, by = 0, half = 6): MapFile {
  let map = emptyMap();
  for (let x = -half; x <= half; x++) {
    for (let y = -half; y <= half; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "e" }]);
  return replaceStack(map, bx, by, 0, [{ tileId: "grass" }, { tileId: body }]);
}

function bodyRef(session: GameSession, tileId: string): ObjectRef {
  const actor = session.actorSnapshots().find((a) => a.tileId === tileId)!;
  return { x: actor.x, y: actor.y, z: actor.z, stackIndex: actor.stackIndex };
}

function talkTo(session: GameSession, tileId: string): boolean {
  return session.talk({ kind: "open", ref: bodyRef(session, tileId) });
}

function press(session: GameSession, index: number) {
  session.talk({ kind: "choose", index });
  return session.getSnapshot().conversation;
}

function confirm(session: GameSession, amount: number) {
  session.talk({ kind: "confirm", amount });
  return session.getSnapshot().conversation;
}

/** Run one brain tick's worth of simulation, collecting what was said. */
function brainTick(session: GameSession): string[] {
  const said: string[] = [];
  for (let elapsed = 0; elapsed < BRAIN_TICK_MS; elapsed += TICK_MS) {
    session.tick(TICK_MS);
    for (const bubble of session.drainSpeech()) said.push(bubble.text);
  }
  return said;
}

function bagOf(session: GameSession) {
  return session.getSnapshot().equipment.bag?.contents?.map((i) =>
    i.count ? `${i.tileId}x${i.count}` : i.tileId,
  );
}

describe("opening a conversation", () => {
  it("opens on the seller with the opening line, and reports it once", () => {
    const session = new GameSession(fieldWith("seller"), tiles);
    expect(talkTo(session, "seller")).toBe(true);
    const conversation = session.getSnapshot().conversation;
    expect(conversation).toMatchObject({ tileId: "seller", path: [] });
    expect(conversation?.line).toMatch(/^Hello, .+\.$/);
    expect(conversation?.line).not.toContain("local");
    expect(session.drainConversationChanges()).toEqual(["local"]);
    expect(session.drainConversationChanges()).toEqual([]);
  });

  it("refuses a body with no dialog, and one out of reach", () => {
    const far = new GameSession(fieldWith("seller", 4, 0), tiles);
    expect(talkTo(far, "seller")).toBe(false);
    expect(far.canTalk(bodyRef(far, "seller"))).toBe(false);
    const near = new GameSession(fieldWith("seller", 3, 1), tiles);
    expect(near.canTalk(bodyRef(near, "seller"))).toBe(true);
  });

  it("refuses through a wall", () => {
    let map = fieldWith("seller");
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "wall" }]);
    const session = new GameSession(map, tiles);
    expect(talkTo(session, "seller")).toBe(false);
  });

  it("talks across a step, and not up a whole level", () => {
    let map = fieldWith("seller");
    map = replaceStack(map, 2, 0, 0, [{ tileId: "grass" }, { tileId: "step" }, { tileId: "seller" }]);
    expect(new GameSession(map, tiles).canTalk({ x: 2, y: 0, z: 0, stackIndex: 2 })).toBe(true);
    map = replaceStack(map, 2, 0, 0, [{ tileId: "grass" }, { tileId: "block" }, { tileId: "seller" }]);
    expect(new GameSession(map, tiles).canTalk({ x: 2, y: 0, z: 0, stackIndex: 2 })).toBe(false);
  });

  it("closes when the player walks out of reach, silently", () => {
    const session = new GameSession(fieldWith("seller"), tiles);
    talkTo(session, "seller");
    session.drainConversationChanges();
    // Four cells west: three steps' worth of walking, well past 3.5.
    session.setInput({ directions: ["w"] });
    for (let elapsed = 0; elapsed < 4 * 400; elapsed += TICK_MS) session.tick(TICK_MS);
    session.setInput({ directions: [] });
    expect(session.getSnapshot().conversation).toBeNull();
    expect(session.drainConversationChanges()).toEqual(["local"]);
  });

  it("closes on Close, once", () => {
    const session = new GameSession(fieldWith("seller"), tiles);
    talkTo(session, "seller");
    expect(session.talk({ kind: "close" })).toBe(true);
    expect(session.getSnapshot().conversation).toBeNull();
    expect(session.talk({ kind: "close" })).toBe(false);
  });

  it("is a body at all: a tile with only a dialog is adopted", () => {
    const session = new GameSession(fieldWith("seller"), tiles);
    expect(session.actorSnapshots().map((a) => a.tileId).sort()).toEqual(["player", "seller"]);
  });
});

describe("pressing buttons", () => {
  it("answers, descends, and comes back up", () => {
    const session = new GameSession(fieldWith("seller"), tiles);
    talkTo(session, "seller");
    expect(press(session, 0)).toMatchObject({ path: [0], line: "Fourteen shards.", stage: "answered" });
    session.talk({ kind: "back" });
    expect(press(session, 1)).toMatchObject({ path: [1], line: "Deal?", stage: "asking" });
    session.talk({ kind: "back" });
    expect(session.getSnapshot().conversation).toMatchObject({ path: [], stage: "asking" });
  });

  it("ignores a press with no panel open, and one at nothing", () => {
    const session = new GameSession(fieldWith("seller"), tiles);
    expect(session.talk({ kind: "choose", index: 0 })).toBe(false);
    talkTo(session, "seller");
    expect(session.talk({ kind: "choose", index: 7 })).toBe(false);
  });

  it("lets the brain stand to serve while anybody is talking", () => {
    const session = new GameSession(fieldWith("server"), tiles);
    expect(brainTick(session)).toEqual([]);
    talkTo(session, "server");
    expect(brainTick(session)).toEqual(["At your service."]);
    session.talk({ kind: "close" });
    brainTick(session);
    talkTo(session, "server");
    expect(brainTick(session)).toEqual(["At your service."]);
  });
});

describe("trading through the panel", () => {
  function shopWith(south: PlacedTile | null): GameSession {
    let map = fieldWith("seller");
    if (south) map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }, south]);
    return new GameSession(map, tiles, { statuses: catalogue });
  }

  it("takes the shards and hands over the potion, announcing the kit once", () => {
    const session = shopWith({ tileId: "shard", count: 14 });
    session.pickUp({ x: 0, y: 1, z: 0, stackIndex: 1 });
    session.drainEquipmentChanges();
    talkTo(session, "seller");
    press(session, 1);
    expect(press(session, 0)?.line).toBe("Here you go.");
    expect(bagOf(session)).toEqual(["potion"]);
    expect(session.drainEquipmentChanges()).toEqual([session.getSnapshot().self.id]);
  });

  it("refuses when short, says so, and leaves the kit alone", () => {
    const session = shopWith({ tileId: "shard", count: 13 });
    session.pickUp({ x: 0, y: 1, z: 0, stackIndex: 1 });
    session.drainEquipmentChanges();
    talkTo(session, "seller");
    press(session, 1);
    expect(press(session, 0)).toMatchObject({ path: [1, 0], line: "That's not fourteen shards.", stage: "answered" });
    expect(bagOf(session)).toEqual(["shardx13"]);
    expect(session.drainEquipmentChanges()).toEqual([]);
  });

  it("pays out of a bag held in a hand", () => {
    const session = shopWith({
      tileId: "bag",
      itemId: "itm_purse",
      contents: [{ id: "itm_shards", tileId: "shard", count: 20 }],
    });
    session.pickUp({ x: 0, y: 1, z: 0, stackIndex: 1 });
    expect(session.getSnapshot().equipment.offhand?.tileId).toBe("bag");
    talkTo(session, "seller");
    press(session, 1);
    expect(press(session, 0)?.line).toBe("Here you go.");
    expect(session.getSnapshot().equipment.offhand?.contents).toEqual([
      { id: "itm_shards", tileId: "shard", count: 6 },
    ]);
    expect(bagOf(session)).toEqual(["potion"]);
  });

  it("grants a status and a tag together, and reads the tag back", () => {
    const session = shopWith(null);
    talkTo(session, "seller");
    expect(press(session, 2)?.line).toBe("Shine.");
    expect(session.statusesOf("local")?.map((s) => s.defId)).toEqual(["luminous"]);
    expect(session.getSnapshot().tags).toEqual(["blessed"]);
    // A leaf: the same button is a Back away, and asks again.
    session.talk({ kind: "back" });
    expect(press(session, 2)?.line).toBe("Once is enough.");
  });

  it("refuses a status nobody authored, rather than doing half", () => {
    const session = shopWith(null);
    talkTo(session, "seller");
    expect(press(session, 3)?.line).toBe("I've lost the words.");
    expect(session.statusesOf("local")).toEqual([]);
  });
});

describe("the potion salesman, as authored", () => {
  it("sells two potions, buys three bottles in one confirm, and refuses when short", () => {
    let map = fieldWith("potion-salesman");
    map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }, { tileId: "arcane-shard", count: 28 }]);
    map = replaceStack(map, 1, 1, 0, [{ tileId: "grass" }, { tileId: "empty-bottle", count: 3 }]);
    const session = new GameSession(map, tiles, { statuses: catalogue });
    session.pickUp({ x: 0, y: 1, z: 0, stackIndex: 1 });
    session.pickUp({ x: 1, y: 1, z: 0, stackIndex: 1 });

    talkTo(session, "potion-salesman");
    expect(session.getSnapshot().conversation?.line).toContain("what'll it be");
    expect(press(session, 0)?.line).toContain("Fourteen shards apiece");
    expect(press(session, 0)).toMatchObject({ stage: "counting", line: "How many? Fourteen shards each." });
    expect(confirm(session, 2)?.line).toContain("Drink them somewhere dark");
    expect(bagOf(session)).toEqual(["empty-bottlex3", "luminous-potionx2"]);

    session.talk({ kind: "back" });
    session.talk({ kind: "back" });
    expect(press(session, 1)).toMatchObject({ stage: "counting" });
    expect(confirm(session, 3)?.line).toContain("Ta,");
    expect(bagOf(session)).toEqual(["luminous-potionx2", "arcane-shardx6"]);

    session.talk({ kind: "back" });
    press(session, 1);
    expect(confirm(session, 1)).toMatchObject({ stage: "answered", line: expect.stringContaining("not got that many") });
  });
});
