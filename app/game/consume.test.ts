import { describe, expect, it } from "vitest";
import { DEFAULT_CONTAINER } from "../lib/item";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { STARTING_BAG_TILE_ID } from "./constants";
import { GameSession } from "./GameSession";

/**
 * Eating and drinking, as the session runs them.
 *
 * The item rules have their own files; this is about what a consume *does* —
 * the thing stops existing, the hit points move, and both refusals and deaths
 * land on the same paths every other cause of them uses.
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

const PLAYER_MAX_HP = 100;

function consumable(id: string, hp: number): TileDef {
  return tile({
    id,
    kind: "item",
    intangible: true,
    interactions: { item: { type: "consumable", label: "Eat", hp } },
  });
}

const tiles: TileDef[] = [
  tile({ id: "grass" }),
  tile({
    id: "player",
    height: 2,
    kind: "battler",
    directional: true,
    walkable: false,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
    interactions: {
      battler: { maxHp: PLAYER_MAX_HP, atk: 5, def: 0, acc: 100, flee: 0, spd: 100 },
    },
  }),
  tile({
    id: STARTING_BAG_TILE_ID,
    kind: "item",
    intangible: true,
    interactions: { item: { ...DEFAULT_CONTAINER } },
  }),
  consumable("cherry", 5),
  consumable("poison", -10),
  consumable("hemlock", -PLAYER_MAX_HP),
  tile({
    id: "sword",
    kind: "item",
    intangible: true,
    interactions: {
      item: { type: "weapon", atk: 1, def: 0, acc: 0, spd: 0, mastery: "blade" },
    },
  }),
  tile({
    id: "chest",
    kind: "item",
    intangible: true,
    interactions: { item: { ...DEFAULT_CONTAINER, size: 2, equippable: false } },
  }),
];

/** Open grass with the player at the origin. */
function field(half = 4): MapFile {
  let map = emptyMap();
  for (let x = -half; x <= half; x++) {
    for (let y = -half; y <= half; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  return replaceStack(map, 0, 0, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "e" },
  ]);
}

function withItem(x: number, y: number, tileId: string): GameSession {
  const map = replaceStack(field(), x, y, 0, [
    { tileId: "grass" },
    { tileId },
  ]);
  return new GameSession(map, tiles);
}

function refAt(session: GameSession, x: number, y: number) {
  const stack = getStack(session.getMap(), x, y, 0);
  return { x, y, z: 0, stackIndex: stack.length - 1 };
}

function hpOf(session: GameSession): number | null {
  return (
    session.actorSnapshots().find((a) => a.tileId === "player")?.hp ?? null
  );
}

function tilesAt(session: GameSession, x: number, y: number): string[] {
  return getStack(session.getMap(), x, y, 0).map((p) => p.tileId);
}

describe("eating off the floor", () => {
  it("takes the thing off the board without it ever entering the bag", () => {
    const session = withItem(1, 0, "cherry");
    session.drainEquipmentChanges();

    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(
      true,
    );
    expect(tilesAt(session, 1, 0)).toEqual(["grass"]);
    expect(session.getSnapshot().equipment.bag?.contents).toEqual([]);
    // Nothing entered the kit, so there is nothing to announce.
    expect(session.drainEquipmentChanges()).toEqual([]);
  });

  it("heals by what the tile says, up to the body's own maximum", () => {
    let map = field();
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "poison" }]);
    map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }, { tileId: "cherry" }]);
    const session = new GameSession(map, tiles);

    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });
    expect(hpOf(session)).toBe(PLAYER_MAX_HP - 10);

    session.consume({ kind: "floor", ref: refAt(session, 0, 1) });
    expect(hpOf(session)).toBe(PLAYER_MAX_HP - 10 + 5);
  });

  it("never heals past full, and still spends the item", () => {
    const session = withItem(1, 0, "cherry");
    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(
      true,
    );
    expect(hpOf(session)).toBe(PLAYER_MAX_HP);
    expect(tilesAt(session, 1, 0)).toEqual(["grass"]);
  });

  // Poison rides the damage path, so it shows its number like a blow does —
  // one codepath for losing hit points, however they were lost.
  it("shows poison as a damage number", () => {
    const session = withItem(1, 0, "poison");
    session.consume({ kind: "floor", ref: refAt(session, 1, 0) });

    const fresh = session.getSnapshot().damage.filter((d) => d.elapsedMs === 0);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.amount).toBe(10);
  });

  it("kills through the same death every blow uses", () => {
    const session = withItem(1, 0, "hemlock");
    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(
      true,
    );

    expect(session.actorSnapshots()).toEqual([]);
    // The body is off the board too, not just the runtime.
    expect(tilesAt(session, 0, 0)).toEqual(["grass"]);
  });

  it("refuses one two cells away", () => {
    const session = withItem(2, 0, "cherry");
    expect(session.consume({ kind: "floor", ref: refAt(session, 2, 0) })).toBe(
      false,
    );
    expect(tilesAt(session, 2, 0)).toEqual(["grass", "cherry"]);
  });

  it("refuses one buried under something else", () => {
    const map = replaceStack(field(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "cherry" },
      { tileId: "grass" },
    ]);
    const session = new GameSession(map, tiles);
    expect(
      session.consume({ kind: "floor", ref: { x: 1, y: 0, z: 0, stackIndex: 1 } }),
    ).toBe(false);
  });

  it("refuses a thing that is not a consumable", () => {
    const session = withItem(1, 0, "sword");
    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(
      false,
    );
    expect(tilesAt(session, 1, 0)).toEqual(["grass", "sword"]);
  });

  it("has nothing to say for an actor who is not here", () => {
    const session = withItem(1, 0, "cherry");
    expect(
      session.consume({ kind: "floor", ref: refAt(session, 1, 0) }, "nobody"),
    ).toBe(false);
  });
});

describe("eating out of a slot", () => {
  it("spends the thing in the bag and announces the kit change once", () => {
    const session = withItem(1, 0, "cherry");
    session.pickUp(refAt(session, 1, 0));
    session.drainEquipmentChanges();

    expect(session.consume({ kind: "slot", slot: { kind: "contents", index: 0 } })).toBe(
      true,
    );
    expect(session.getSnapshot().equipment.bag?.contents).toEqual([]);
    expect(session.drainEquipmentChanges()).toEqual([
      session.getSnapshot().self.id,
    ]);
  });

  it("moves the hit points exactly as a floor meal does", () => {
    let map = field();
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "poison" }]);
    map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }, { tileId: "cherry" }]);
    const session = new GameSession(map, tiles);
    session.pickUp(refAt(session, 1, 0));
    session.pickUp(refAt(session, 0, 1));

    session.consume({ kind: "slot", slot: { kind: "contents", index: 0 } });
    expect(hpOf(session)).toBe(PLAYER_MAX_HP - 10);

    session.consume({ kind: "slot", slot: { kind: "contents", index: 0 } });
    expect(hpOf(session)).toBe(PLAYER_MAX_HP - 10 + 5);
    expect(session.getSnapshot().equipment.bag?.contents).toEqual([]);
  });

  it("eats straight out of a chest on the floor, rewriting its placement", () => {
    const map = replaceStack(field(), 1, 0, 0, [
      { tileId: "grass" },
      {
        tileId: "chest",
        itemId: "itm_chest",
        contents: [{ id: "itm_snack", tileId: "cherry" }],
      },
    ]);
    const session = new GameSession(map, tiles);
    session.drainEquipmentChanges();
    const chest = refAt(session, 1, 0);

    expect(
      session.consume({
        kind: "slot",
        slot: { kind: "ground", ref: chest, index: 0 },
      }),
    ).toBe(true);
    expect(getStack(session.getMap(), 1, 0, 0)[1]!.contents).toEqual([]);
    // The chest's placement changed and nobody's kit did.
    expect(session.drainEquipmentChanges()).toEqual([]);
  });

  it("refuses a chest the player has walked away from", () => {
    const map = replaceStack(field(), 3, 0, 0, [
      { tileId: "grass" },
      {
        tileId: "chest",
        itemId: "itm_chest",
        contents: [{ id: "itm_snack", tileId: "cherry" }],
      },
    ]);
    const session = new GameSession(map, tiles);
    const chest = refAt(session, 3, 0);

    expect(
      session.consume({
        kind: "slot",
        slot: { kind: "ground", ref: chest, index: 0 },
      }),
    ).toBe(false);
    expect(getStack(session.getMap(), 3, 0, 0)[1]!.contents).toHaveLength(1);
  });

  it("refuses a slot holding something that is not a consumable", () => {
    const session = withItem(1, 0, "sword");
    session.pickUp(refAt(session, 1, 0));

    expect(
      session.consume({ kind: "slot", slot: { kind: "contents", index: 0 } }),
    ).toBe(false);
    expect(session.getSnapshot().equipment.bag?.contents).toHaveLength(1);
  });

  it("refuses an empty slot", () => {
    const session = new GameSession(field(), tiles);
    expect(
      session.consume({ kind: "slot", slot: { kind: "contents", index: 0 } }),
    ).toBe(false);
  });
});

/**
 * A body with no hit points cannot be fed. The check runs before anything is
 * destroyed, so the refusal costs nothing — better an inert cherry than one
 * wasted on a body the number cannot land on.
 */
describe("a consumer with no hit points", () => {
  const ghostTiles = tiles.map((t) =>
    t.id === "player" ? { ...t, kind: "prop" as const } : t,
  );

  it("refuses, and the thing is still there", () => {
    const map = replaceStack(field(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "cherry" },
    ]);
    const session = new GameSession(map, ghostTiles);

    expect(session.consume({ kind: "floor", ref: refAt(session, 1, 0) })).toBe(
      false,
    );
    expect(tilesAt(session, 1, 0)).toEqual(["grass", "cherry"]);
  });
});
