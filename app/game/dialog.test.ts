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
import { TRADE_REFUSED } from "./dialogRuntime";
import { GameSession } from "./GameSession";

/**
 * A conversation through the session: Talk pressed on a body, choices and
 * trades pressed on the panel, and the world deciding what each press comes
 * to.
 *
 * `./dialogRuntime.test` pins what the interpreter does; this is about the
 * plumbing either side of it — reach, who may talk at once, the brain seeing
 * it, and a trade actually moving things.
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

const say = (text: string) => ({ kind: "say" as const, text });
const back = { kind: "goto" as const, name: "main" };

const dialog: DialogDef = {
  script: [
    say("Hello, {partner}."),
    { kind: "anchor", name: "main" },
    {
      kind: "choices",
      options: [
        { label: "Recipe", then: [say("Fourteen shards."), back] },
        {
          label: "Buy",
          then: [
            {
              kind: "request_trade",
              take: [{ tileId: "shard", count: 14 }],
              give: [{ tileId: "potion", count: 1 }],
              min: 1,
              max: 3,
              traded: [say("Here you go."), back],
              cancel: [say("Fine."), back],
            },
          ],
        },
        { label: "Bless me", then: [{ kind: "add_status", statusId: "luminous" }, { kind: "tag", tag: "blessed" }, say("Shine."), back] },
        { label: "Cure me", then: [{ kind: "remove_status", statusId: "luminous" }, say("Dim."), back] },
      ],
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

function trade(session: GameSession, amount: number) {
  session.talk({ kind: "trade", amount });
  return session.getSnapshot().conversation;
}

const lastLine = (session: GameSession) => session.getSnapshot().conversation?.transcript.at(-1)?.text;

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
  it("opens on the seller at its first choice, and reports it once", () => {
    const session = new GameSession(fieldWith("seller"), tiles);
    expect(talkTo(session, "seller")).toBe(true);
    const conversation = session.getSnapshot().conversation;
    expect(conversation).toMatchObject({ tileId: "seller", pc: [2] });
    expect(conversation?.transcript[0]?.text).toMatch(/^Hello, .+\.$/);
    expect(conversation?.transcript[0]?.text).not.toContain("local");
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
    expect(talkTo(new GameSession(map, tiles), "seller")).toBe(false);
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

describe("pressing", () => {
  it("records the choice, answers, and comes back to the menu", () => {
    const session = new GameSession(fieldWith("seller"), tiles);
    talkTo(session, "seller");
    const after = press(session, 0);
    expect(after?.transcript.slice(1).map((e) => e.text)).toEqual(["Recipe", "Fourteen shards."]);
    expect(after?.pc).toEqual([2]);
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
    expect(trade(session, 1)?.transcript.slice(-2).map((e) => e.text)).toEqual(["Traded ×1.", "Here you go."]);
    expect(bagOf(session)).toEqual(["potion"]);
    expect(session.drainEquipmentChanges()).toEqual([session.getSnapshot().self.id]);
  });

  it("refuses when short, notes it, and leaves the kit alone", () => {
    const session = shopWith({ tileId: "shard", count: 13 });
    session.pickUp({ x: 0, y: 1, z: 0, stackIndex: 1 });
    session.drainEquipmentChanges();
    talkTo(session, "seller");
    press(session, 1);
    expect(trade(session, 1)?.transcript.at(-1)?.text).toBe(TRADE_REFUSED);
    expect(bagOf(session)).toEqual(["shardx13"]);
    expect(session.drainEquipmentChanges()).toEqual([]);
  });

  it("pays out of a bag held in a hand", () => {
    const session = shopWith({
      tileId: "bag",
      itemId: "itm_purse",
      contents: [{ id: "itm_shards", tileId: "shard", count: 30 }],
    });
    session.pickUp({ x: 0, y: 1, z: 0, stackIndex: 1 });
    expect(session.getSnapshot().equipment.offhand?.tileId).toBe("bag");
    talkTo(session, "seller");
    press(session, 1);
    expect(lastLine(session)).toBeUndefined;
    trade(session, 2);
    expect(session.getSnapshot().equipment.offhand?.contents).toEqual([
      { id: "itm_shards", tileId: "shard", count: 2 },
    ]);
    expect(bagOf(session)).toEqual(["potionx2"]);
  });

  it("runs the cancel branch on Cancel", () => {
    const session = shopWith(null);
    talkTo(session, "seller");
    press(session, 1);
    session.talk({ kind: "cancel" });
    expect(lastLine(session)).toBe("Fine.");
  });

  it("grants and removes a status, and writes a tag", () => {
    const session = shopWith(null);
    talkTo(session, "seller");
    expect(press(session, 2)?.transcript.at(-1)?.text).toBe("Shine.");
    expect(session.statusesOf("local")?.map((s) => s.defId)).toEqual(["luminous"]);
    expect(session.getSnapshot().tags).toEqual(["blessed"]);
    expect(press(session, 3)?.transcript.at(-1)?.text).toBe("Dim.");
    expect(session.statusesOf("local")).toEqual([]);
  });
});

describe("the potion salesman, as authored", () => {
  it("sells two potions, buys three bottles, and refuses when short", () => {
    let map = fieldWith("potion-salesman");
    map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }, { tileId: "arcane-shard", count: 28 }]);
    map = replaceStack(map, 1, 1, 0, [{ tileId: "grass" }, { tileId: "empty-bottle", count: 3 }]);
    const session = new GameSession(map, tiles, { statuses: catalogue });
    session.pickUp({ x: 0, y: 1, z: 0, stackIndex: 1 });
    session.pickUp({ x: 1, y: 1, z: 0, stackIndex: 1 });

    talkTo(session, "potion-salesman");
    expect(lastLine(session)).toContain("Potions, or a recipe");
    press(session, 0);
    expect(lastLine(session)).toContain("how many");
    trade(session, 2);
    expect(lastLine(session)).toContain("Drink them somewhere dark");
    expect(bagOf(session)).toEqual(["empty-bottlex3", "luminous-potionx2"]);

    press(session, 1);
    trade(session, 3);
    expect(lastLine(session)).toContain("Ta.");
    expect(bagOf(session)).toEqual(["luminous-potionx2", "arcane-shardx6"]);

    press(session, 0);
    trade(session, 1);
    expect(lastLine(session)).toBe(TRADE_REFUSED);
    session.talk({ kind: "cancel" });
    press(session, 3);
    expect(lastLine(session)).toContain("Mind the dark");
    expect(session.talk({ kind: "choose", index: 0 })).toBe(false);
  });
});
