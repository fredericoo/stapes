import { describe, expect, it } from "vitest";
import type { ItemInstance } from "../lib/itemInstance";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { Coord, MapFile, PlacedTile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { TICK_MS } from "./constants";
import { DecayIndex, applyDecay, findDecayCells } from "./decay";
import { emptyEquipment, type Equipment } from "./equipment";
import { GameSession, LOCAL_ACTOR_ID } from "./GameSession";
import { Rng } from "./rng";

/**
 * The bag `player`'s kit is authored with — see `app/lib/kit.ts`. A literal
 * here like every other tile id in this file: what a body carries is authored
 * content now, so there is no constant in the engine left to import.
 */
const BAG_TILE_ID = "basic-bag";

/** Fixed lifetimes, so a test asserts a deadline rather than a distribution. */
const BLOOD_MS = 1000;
const STAIN_MS = 2000;

/** The spread the jitter tests draw from. */
const JITTER_FROM_MS = 1000;
const JITTER_TO_MS = 5000;

/** Fixed lifetimes for the things somebody can carry. */
const BERRY_MS = 3000;
const ROTTEN_MS = 4000;

/**
 * A lifetime longer than a fight, for the one thing that has to survive being
 * fought over. See the `scarecrow` tile.
 */
const GOURD_MS = 60_000;

function tile(
  partial: Record<string, unknown> & Pick<TileDef, "id" | "height">,
): TileDef {
  return normalizeTileDef({
    name: partial.id,
    directional: false,
    variants: {
      default: [
        {
          sprite: {
            tilesetId: "basic",
            rect: { x: 0, y: 0, w: 1, h: 1 },
            base: { x: 0, y: 0 },
          },
          durationMs: 200,
        },
      ],
    },
    attributes: {},
    ...partial,
  });
}

function directionalTile(id: string, extra: Record<string, unknown> = {}) {
  const frames = [
    {
      sprite: {
        tilesetId: "basic",
        rect: { x: 0, y: 0, w: 1, h: 1 },
        base: { x: 0, y: 0 },
      },
      durationMs: 200,
    },
  ];
  return normalizeTileDef({
    id,
    name: id,
    height: 4,
    directional: true,
    attributes: {},
    variants: { n: frames, e: frames, s: frames, w: frames },
    ...extra,
  });
}

/** The plainest consumable there is: no verb, no statuses, no health in it. */
const EDIBLE = { type: "consumable", hp: 0 } as const;

/** A tile somebody can pick up, optionally with a clock on it. */
function itemTile(
  id: string,
  item: Record<string, unknown>,
  decay?: { tileId: string; fromMs: number; toMs: number },
): TileDef {
  return tile({
    id,
    height: 0,
    kind: "item",
    intangible: true,
    interactions: { item, ...(decay ? { decay } : {}) },
  });
}

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "wall", height: 4 }),
  // A battler with a kit, because that is now the only way anybody gets a bag
  // — and half this file is about a berry ripening inside one. See
  // `app/lib/kit.ts`.
  directionalTile("player", {
    affectedByGravity: true,
    walkable: false,
    kind: "battler",
    interactions: {
      battler: {
        masteries: { toughness: 8 },
        naturalWeapon: {
          type: "weapon",
          damage: 1,
          def: 0,
          accuracy: 50,
          variance: 0,
          spd: 50,
          mastery: "fist",
        },
        kit: [{ slot: "bag", tileId: BAG_TILE_ID, chance: 100 }],
      },
    },
  }),
  // The motivating pair: blood dries to a stain, the stain fades to nothing.
  tile({
    id: "blood",
    height: 0,
    interactions: {
      decay: { tileId: "stain", fromMs: BLOOD_MS, toMs: BLOOD_MS },
    },
  }),
  tile({
    id: "stain",
    height: 0,
    interactions: { decay: { tileId: "", fromMs: STAIN_MS, toMs: STAIN_MS } },
  }),
  // Draws its lifetime from a spread rather than taking a fixed one.
  tile({
    id: "spatter",
    height: 0,
    interactions: {
      decay: { tileId: "", fromMs: JITTER_FROM_MS, toMs: JITTER_TO_MS },
    },
  }),
  // Rots into something that cannot fit under a load.
  tile({
    id: "swell",
    height: 0,
    interactions: {
      decay: { tileId: "wall", fromMs: BLOOD_MS, toMs: BLOOD_MS },
    },
  }),
  // Names a tile this world does not have.
  tile({
    id: "orphan",
    height: 0,
    interactions: {
      decay: { tileId: "nope", fromMs: BLOOD_MS, toMs: BLOOD_MS },
    },
  }),
  // Zero lifetime is not a decay at all.
  tile({
    id: "inert",
    height: 0,
    interactions: { decay: { tileId: "", fromMs: 0, toMs: 0 } },
  }),
  // Longest shorter than shortest — malformed, so inert.
  tile({
    id: "backwards",
    height: 0,
    interactions: { decay: { tileId: "", fromMs: 5000, toMs: 1000 } },
  }),
  // A body that decays — its runtime must not be stranded.
  directionalTile("ghoul", {
    actor: true,
    affectedByGravity: true,
    walkable: false,
    interactions: { decay: { tileId: "", fromMs: BLOOD_MS, toMs: BLOOD_MS } },
  }),
  // Things somebody can carry, which is the other half of what decays.
  itemTile("basic-bag", { type: "container", size: 4, equippable: true }),
  itemTile("crate", { type: "container", size: 2, equippable: false }),
  itemTile("berry", EDIBLE, {
    tileId: "rotten-berry",
    fromMs: BERRY_MS,
    toMs: BERRY_MS,
  }),
  itemTile("rotten-berry", EDIBLE, {
    tileId: "",
    fromMs: ROTTEN_MS,
    toMs: ROTTEN_MS,
  }),
  // Rots into a container, which no slot and no bag may hold.
  itemTile("seed-pod", EDIBLE, {
    tileId: "crate",
    fromMs: BERRY_MS,
    toMs: BERRY_MS,
  }),
  // Rots into scenery: a thing, and then not a thing at all.
  itemTile("mushroom", EDIBLE, {
    tileId: "stain",
    fromMs: BERRY_MS,
    toMs: BERRY_MS,
  }),
  // A weapon that rots into something nobody can swing.
  itemTile(
    "bone-club",
    {
      type: "weapon",
      damage: 5,
      def: 0,
      accuracy: 100,
      variance: 0,
      spd: 50,
      mastery: "blunt",
    },
    { tileId: "berry", fromMs: BERRY_MS, toMs: BERRY_MS },
  ),
  // A bag that rots away — but only once there is nothing left inside it.
  itemTile(
    "satchel",
    { type: "container", size: 2, equippable: true },
    {
      tileId: "",
      fromMs: BERRY_MS,
      toMs: BERRY_MS,
    },
  ),
  // Long enough to outlive the fight that spills it, which is the whole point
  // of it: a berry would have gone off in the hand that was still holding it.
  itemTile("gourd", EDIBLE, {
    tileId: "rotten-berry",
    fromMs: GOURD_MS,
    toMs: GOURD_MS,
  }),
  // Something to kill: hit points, one thing to its name, and no way to fight
  // back. Toughness 1 rather than 0 — a body with no stats has no hit points
  // and cannot die at all, which is what a statue is.
  tile({
    id: "scarecrow",
    height: 2,
    actor: true,
    walkable: false,
    kind: "battler",
    interactions: {
      battler: {
        masteries: { toughness: 1 },
        naturalWeapon: {
          type: "weapon",
          damage: 0,
          def: 0,
          accuracy: 0,
          variance: 0,
          spd: 50,
          mastery: "fist",
        },
        kit: [{ slot: "weapon", tileId: "gourd", chance: 100 }],
      },
    },
  }),
];

const tilesById = tilesByIdFromList(tiles);

/** Player parked away from the action; every map needs exactly one. */
function withIdlePlayer(map: MapFile): MapFile {
  return replaceStack(map, 9, 9, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "s" },
  ]);
}

function stackIds(map: MapFile, x: number, y: number, z = 0): string[] {
  return getStack(map, x, y, z).map((p) => p.tileId);
}

/**
 * Tick past `ms` of simulated time.
 *
 * One tick further than the arithmetic asks for, because a deadline lands
 * partway through a tick and is only served by the one after it — and because
 * a tick is not a whole millisecond, so summing thirty of them lands a hair
 * either side of a second.
 */
function run(session: GameSession, ms: number) {
  for (let i = 0; i <= Math.ceil(ms / TICK_MS); i++) session.tick(TICK_MS);
}

const ORIGIN = { x: 0, y: 0, z: 0 };

describe("findDecayCells", () => {
  it("finds decaying placements across levels and skips inert ones", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "blood" }]);
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "inert" },
    ]);
    map = replaceStack(map, 2, 0, 0, [{ tileId: "backwards" }]);
    map = replaceStack(map, 4, 2, 3, [{ tileId: "stain" }]);
    expect(findDecayCells(map, tilesById)).toEqual([
      { x: 0, y: 0, z: 0 },
      { x: 4, y: 2, z: 3 },
    ]);
  });
});

describe("DecayIndex", () => {
  const armed = (map: MapFile) => {
    const index = new DecayIndex(new Rng());
    index.armCell(map, ORIGIN, tilesById);
    return index;
  };

  it("holds nothing until something decaying is armed", () => {
    const index = armed(
      replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]),
    );
    expect(index.pending()).toBe(false);
  });

  it("yields an entry only once its lifetime has elapsed", () => {
    const index = armed(
      replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "blood" }]),
    );
    expect(index.pending()).toBe(true);

    index.advance(BLOOD_MS - 1);
    expect(index.takeDue()).toEqual([]);

    index.advance(1);
    expect(index.takeDue()).toEqual([
      { kind: "placement", cell: ORIGIN, tileId: "blood", dueMs: BLOOD_MS },
    ]);
    expect(index.pending()).toBe(false);
  });

  it("keeps the deadline a placement already has when its cell is re-armed", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "blood" }]);
    const index = armed(map);

    // Somebody walks over the blood every tick for most of its life. Re-stamping
    // here is what would make blood in a doorway immortal.
    for (let elapsed = 0; elapsed < BLOOD_MS; elapsed += TICK_MS) {
      index.advance(TICK_MS);
      index.armCell(map, ORIGIN, tilesById);
    }
    expect(index.takeDue()).toHaveLength(1);
  });

  it("serves everything due in one pass", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "blood" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "blood" }]);
    const index = new DecayIndex(new Rng());
    index.armCell(map, ORIGIN, tilesById);
    index.armCell(map, { x: 1, y: 0, z: 0 }, tilesById);

    index.advance(BLOOD_MS);
    expect(index.takeDue()).toHaveLength(2);
  });

  /** Deadlines drawn for `count` placements armed together at time zero. */
  function jitteredDeadlines(count: number, seed?: number): number[] {
    const index = new DecayIndex(new Rng(seed));
    let map = emptyMap();
    for (let x = 0; x < count; x++) {
      map = replaceStack(map, x, 0, 0, [{ tileId: "spatter" }]);
    }
    for (let x = 0; x < count; x++) {
      index.armCell(map, { x, y: 0, z: 0 }, tilesById);
    }
    index.advance(JITTER_TO_MS);
    return index.takeDue().map((e) => e.dueMs);
  }

  it("draws each lifetime from the authored range", () => {
    const deadlines = jitteredDeadlines(50);
    expect(deadlines).toHaveLength(50);
    for (const dueMs of deadlines) {
      expect(dueMs).toBeGreaterThanOrEqual(JITTER_FROM_MS);
      expect(dueMs).toBeLessThanOrEqual(JITTER_TO_MS);
    }
  });

  it("spreads a burst armed on the same tick across the range", () => {
    // The whole point of the range: fifty splashes placed together must not
    // share one deadline and clear the floor on a single frame.
    const distinct = new Set(jitteredDeadlines(50));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it("draws the same lifetimes from the same seed, and different from another", () => {
    expect(jitteredDeadlines(20, 1)).toEqual(jitteredDeadlines(20, 1));
    expect(jitteredDeadlines(20, 1)).not.toEqual(jitteredDeadlines(20, 2));
  });

  it("spends exactly one draw per placement, whatever the range", () => {
    // A draw count that varied with the authored numbers would make widening
    // one tile's range change what every creature after it rolled.
    const rng = new Rng(7);
    const index = new DecayIndex(rng);
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "blood" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "spatter" }]);
    index.armCell(map, ORIGIN, tilesById);
    index.armCell(map, { x: 1, y: 0, z: 0 }, tilesById);

    const spent = new Rng(7);
    spent.next();
    spent.next();
    expect(rng.save()).toBe(spent.save());
  });

  it("neither redraws nor spends a draw when a cell is re-armed", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "spatter" }]);
    const rng = new Rng(3);
    const index = new DecayIndex(rng);
    index.armCell(map, ORIGIN, tilesById);
    const afterFirst = rng.save();

    for (let i = 0; i < 10; i++) index.armCell(map, ORIGIN, tilesById);
    expect(rng.save()).toBe(afterFirst);

    index.advance(JITTER_TO_MS);
    const due = index.takeDue();
    expect(due).toHaveLength(1);
    expect(due[0]!.dueMs).toBe(
      JITTER_FROM_MS + new Rng(3).int(JITTER_TO_MS - JITTER_FROM_MS + 1),
    );
  });
});

describe("applyDecay", () => {
  const due = (tileId: string) =>
    [{ kind: "placement", cell: ORIGIN, tileId, dueMs: 0 }] as const;

  it("swaps in the target and keeps everything else in the stack", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "blood", description: "spattered" },
    ]);
    const result = applyDecay(map, due("blood"), tilesById);
    expect(stackIds(result.map, 0, 0)).toEqual(["grass", "stain"]);
    expect(getStack(result.map, 0, 0, 0)[1]).toEqual({
      tileId: "stain",
      description: "spattered",
    });
    expect(result.changed).toEqual([ORIGIN]);
  });

  it("removes the placement when no target is named", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "stain" },
    ]);
    const result = applyDecay(map, due("stain"), tilesById);
    expect(stackIds(result.map, 0, 0)).toEqual(["grass"]);
  });

  it("clears the cell when the last placement in it goes", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "stain" }]);
    const result = applyDecay(map, due("stain"), tilesById);
    expect(stackIds(result.map, 0, 0)).toEqual([]);
  });

  it("abandons a swap that would not fit under its own load", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "swell" },
      { tileId: "wall" },
    ]);
    const result = applyDecay(map, due("swell"), tilesById);
    expect(result.map).toBe(map);
    expect(result.changed).toEqual([]);
  });

  it("leaves a tile whose target this world does not have", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "orphan" }]);
    const result = applyDecay(map, due("orphan"), tilesById);
    expect(result.map).toBe(map);
  });

  it("leaves a placement somebody is driving", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "ghoul", owner: "someone" },
    ]);
    const result = applyDecay(map, due("ghoul"), tilesById);
    expect(result.map).toBe(map);
  });

  it("does nothing for an entry whose placement has already gone", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    const result = applyDecay(map, due("blood"), tilesById);
    expect(result.map).toBe(map);
  });
});

describe("GameSession decay", () => {
  it("ages authored decay from the moment the world opens", () => {
    const map = withIdlePlayer(
      replaceStack(emptyMap(), 0, 0, 0, [
        { tileId: "grass" },
        { tileId: "blood" },
      ]),
    );
    const session = new GameSession(map, tiles);
    expect(stackIds(session.getMap(), 0, 0)).toEqual(["grass", "blood"]);

    run(session, BLOOD_MS);
    expect(stackIds(session.getMap(), 0, 0)).toEqual(["grass", "stain"]);
  });

  it("chains through a tile that decays in turn", () => {
    const map = withIdlePlayer(
      replaceStack(emptyMap(), 0, 0, 0, [
        { tileId: "grass" },
        { tileId: "blood" },
      ]),
    );
    const session = new GameSession(map, tiles);

    run(session, BLOOD_MS + STAIN_MS);
    expect(stackIds(session.getMap(), 0, 0)).toEqual(["grass"]);
  });

  it("does not rest while anything is counting down", () => {
    const map = withIdlePlayer(
      replaceStack(emptyMap(), 0, 0, 0, [
        { tileId: "grass" },
        { tileId: "stain" },
      ]),
    );
    const session = new GameSession(map, tiles);
    expect(session.isAtRest()).toBe(false);

    run(session, STAIN_MS);
    expect(stackIds(session.getMap(), 0, 0)).toEqual(["grass"]);
    expect(session.isAtRest()).toBe(true);
  });

  it("leaves a world with nothing decaying at rest", () => {
    const session = new GameSession(withIdlePlayer(emptyMap()), tiles);
    expect(session.isAtRest()).toBe(true);
  });

  it("does not offer decay as something the player can click", () => {
    const map = withIdlePlayer(
      replaceStack(emptyMap(), 0, 0, 0, [
        { tileId: "grass" },
        { tileId: "blood" },
      ]),
    );
    const session = new GameSession(map, tiles);
    const ref = { x: 0, y: 0, z: 0, stackIndex: 1 };
    expect(session.canInteract(ref)).toBe(false);
    expect(session.interact(ref)).toBe(false);
  });
});

/** Room beside the idle player for somebody carrying something. */
const BESIDE: Coord = { x: 8, y: 9, z: 0 };

function withCompany(map: MapFile): MapFile {
  return replaceStack(withIdlePlayer(map), BESIDE.x, BESIDE.y, BESIDE.z, [
    { tileId: "grass" },
  ]);
}

/** Grass beside the player with `placed` standing on it. */
function beside(placed: PlacedTile): MapFile {
  return replaceStack(
    withIdlePlayer(emptyMap()),
    BESIDE.x,
    BESIDE.y,
    BESIDE.z,
    [{ tileId: "grass" }, placed],
  );
}

function thing(id: string, tileId: string): ItemInstance {
  return { id, tileId };
}

/** A kit with a bag on its back, and whatever else is asked for. */
function kitWith(
  contents: ItemInstance[],
  slots: Partial<Equipment> = {},
): Equipment {
  return {
    ...emptyEquipment(),
    bag: { id: "itm_bag", tileId: BAG_TILE_ID, contents },
    ...slots,
  };
}

function carried(session: GameSession, id: string): Equipment {
  const kit = session.equipmentOf(id);
  if (!kit) throw new Error(`nobody called "${id}" is carrying anything`);
  return kit;
}

function bagIds(session: GameSession, id: string): string[] {
  return (carried(session, id).bag?.contents ?? []).map((held) => held.tileId);
}

/** Somebody stood beside the idle player, carrying `kit`. */
function bearerOf(session: GameSession, kit: Equipment): string {
  session.spawn("bearer", { at: BESIDE, carrying: kit });
  return "bearer";
}

/** What the cell beside the player is holding. */
function asideStack(session: GameSession): PlacedTile[] {
  return getStack(session.getMap(), BESIDE.x, BESIDE.y, BESIDE.z);
}

describe("things that decay while somebody is holding them", () => {
  it("rots in the bag on somebody's back", () => {
    const session = new GameSession(withCompany(emptyMap()), tiles);
    const who = bearerOf(session, kitWith([thing("itm_berry", "berry")]));

    expect(bagIds(session, who)).toEqual(["berry"]);
    run(session, BERRY_MS);
    expect(bagIds(session, who)).toEqual(["rotten-berry"]);
  });

  it("is still the same thing on the other side of the turn", () => {
    const session = new GameSession(withCompany(emptyMap()), tiles);
    const who = bearerOf(session, kitWith([thing("itm_berry", "berry")]));

    run(session, BERRY_MS);
    expect(carried(session, who).bag?.contents?.[0]?.id).toBe("itm_berry");
  });

  it("chains in a bag exactly as it does on the floor", () => {
    const session = new GameSession(withCompany(emptyMap()), tiles);
    const who = bearerOf(session, kitWith([thing("itm_berry", "berry")]));

    run(session, BERRY_MS + ROTTEN_MS);
    expect(bagIds(session, who)).toEqual([]);
  });

  it("rots in a hand", () => {
    const session = new GameSession(withCompany(emptyMap()), tiles);
    const who = bearerOf(
      session,
      kitWith([], { offhand: thing("itm_berry", "berry") }),
    );

    run(session, BERRY_MS);
    expect(carried(session, who).offhand?.tileId).toBe("rotten-berry");
  });

  it("rots one out of a pile at a time, into a pile beside it", () => {
    const session = new GameSession(withCompany(emptyMap()), tiles);
    const who = bearerOf(
      session,
      kitWith([{ ...thing("itm_berries", "berry"), count: 3 }]),
    );

    run(session, BERRY_MS);
    // Two berries and the one that went off, not three rotten berries: a heap
    // you cannot leave alone for a minute without losing all of it is a heap
    // nobody would gather.
    expect(carried(session, who).bag?.contents).toEqual([
      { id: "itm_berries", tileId: "berry", count: 2 },
      { id: expect.any(String), tileId: "rotten-berry" },
    ]);
  });

  it("keeps the pile counting down, one lifetime at a time", () => {
    const session = new GameSession(withCompany(emptyMap()), tiles);
    const who = bearerOf(
      session,
      kitWith([{ ...thing("itm_berries", "berry"), count: 3 }]),
    );

    run(session, BERRY_MS);
    run(session, BERRY_MS);
    const contents = carried(session, who).bag?.contents ?? [];
    expect(contents[0]).toEqual({ id: "itm_berries", tileId: "berry" });
    // The two that went off are one pile of rot, poured together on arrival.
    expect(contents[1]).toEqual({
      id: expect.any(String),
      tileId: "rotten-berry",
      count: 2,
    });
  });

  it("waits, in a hand, while there is more than one of it", () => {
    const session = new GameSession(withCompany(emptyMap()), tiles);
    const who = bearerOf(session, {
      ...emptyEquipment(),
      offhand: { ...thing("itm_berries", "berry"), count: 2 },
    });

    run(session, BERRY_MS);
    // A square on a body holds one thing, so there is nowhere for the berry that
    // came off to be. It stays a pile of two until something moves it.
    expect(carried(session, who).offhand).toEqual({
      id: "itm_berries",
      tileId: "berry",
      count: 2,
    });
  });

  it("rots one out of a pile on the floor, into the pile of rot already there", () => {
    const session = new GameSession(
      beside({ tileId: "berry", itemId: "itm_berries", count: 3 }),
      tiles,
    );

    run(session, BERRY_MS);
    expect(asideStack(session)).toEqual([
      { tileId: "grass" },
      { tileId: "berry", itemId: "itm_berries", count: 2 },
      { tileId: "rotten-berry", itemId: expect.any(String) },
    ]);
  });

  it("rots inside a chest on the floor", () => {
    const session = new GameSession(
      beside({
        tileId: "crate",
        itemId: "itm_crate",
        contents: [thing("itm_berry", "berry")],
      }),
      tiles,
    );

    run(session, BERRY_MS);
    expect(asideStack(session)[1]?.contents).toEqual([
      { id: "itm_berry", tileId: "rotten-berry" },
    ]);
  });

  it("does not start over when somebody picks it up", () => {
    // The whole point of keying a clock to the thing rather than to the cell:
    // half a berry's life on the floor and half in a bag is one berry's life.
    const session = new GameSession(
      beside({ tileId: "berry", itemId: "itm_berry" }),
      tiles,
    );

    run(session, BERRY_MS / 2);
    expect(session.pickUp({ ...BESIDE, stackIndex: 1 })).toBe(true);
    expect(bagIds(session, LOCAL_ACTOR_ID)).toEqual(["berry"]);

    run(session, BERRY_MS / 2);
    expect(bagIds(session, LOCAL_ACTOR_ID)).toEqual(["rotten-berry"]);
  });

  it("does not rot away with things still inside it", () => {
    const session = new GameSession(withCompany(emptyMap()), tiles);
    const who = bearerOf(
      session,
      kitWith([thing("itm_berry", "berry")], {
        bag: {
          id: "itm_satchel",
          tileId: "satchel",
          contents: [thing("itm_berry", "berry")],
        },
      }),
    );

    // Both are due on the same tick, and only the berry may go: a bag that
    // rotted out from under what it held would destroy it silently.
    run(session, BERRY_MS);
    expect(carried(session, who).bag?.tileId).toBe("satchel");
    expect(bagIds(session, who)).toEqual(["rotten-berry"]);
  });

  it("rots away once there is nothing left inside it", () => {
    const session = new GameSession(withCompany(emptyMap()), tiles);
    const who = bearerOf(
      session,
      kitWith([], {
        bag: { id: "itm_satchel", tileId: "satchel", contents: [] },
      }),
    );

    run(session, BERRY_MS);
    expect(carried(session, who).bag).toBeNull();
  });

  it("refuses a turn the bag it is in could not hold", () => {
    const session = new GameSession(withCompany(emptyMap()), tiles);
    const who = bearerOf(session, kitWith([thing("itm_pod", "seed-pod")]));

    // A container may not go in a container, so the pod waits rather than
    // arriving in the bag as something the nesting rule forbids.
    run(session, BERRY_MS);
    expect(bagIds(session, who)).toEqual(["seed-pod"]);
  });

  it("refuses a turn that would leave scenery in a bag", () => {
    const session = new GameSession(withCompany(emptyMap()), tiles);
    const who = bearerOf(session, kitWith([thing("itm_shroom", "mushroom")]));

    run(session, BERRY_MS);
    expect(bagIds(session, who)).toEqual(["mushroom"]);
  });

  it("turns in a hand, which takes anything you could carry", () => {
    const session = new GameSession(withCompany(emptyMap()), tiles);
    const who = bearerOf(
      session,
      kitWith([], { weapon: thing("itm_club", "bone-club") }),
    );

    // A hand is not a weapon rack — see `handAccepts`. A club that rots into
    // something inedible to swing is still something you can hold.
    run(session, BERRY_MS);
    expect(carried(session, who).weapon?.tileId).toBe("berry");
  });

  it("refuses a turn the hand it is in could not hold", () => {
    const session = new GameSession(withCompany(emptyMap()), tiles);
    const who = bearerOf(
      session,
      kitWith([], { offhand: thing("itm_shroom", "mushroom") }),
    );

    // The one thing a hand refuses is a thing that is not a thing: scenery in
    // a fist is a state nothing else in the game has an answer for.
    run(session, BERRY_MS);
    expect(carried(session, who).offhand?.tileId).toBe("mushroom");
  });

  it("rots inside a pack somebody is holding, not only the one on their back", () => {
    const session = new GameSession(withCompany(emptyMap()), tiles);
    const who = bearerOf(
      session,
      kitWith([], {
        offhand: {
          id: "itm_spare",
          tileId: BAG_TILE_ID,
          contents: [thing("itm_berry", "berry")],
        },
      }),
    );

    run(session, BERRY_MS);
    expect(carried(session, who).offhand?.contents).toEqual([
      { id: "itm_berry", tileId: "rotten-berry" },
    ]);
  });

  it("makes the same turn on the floor that a slot refused", () => {
    const session = new GameSession(
      beside({ tileId: "seed-pod", itemId: "itm_pod" }),
      tiles,
    );

    // The ground holds anything, which is the only rule the floor has.
    run(session, BERRY_MS);
    expect(asideStack(session).map((p) => p.tileId)).toEqual([
      "grass",
      "crate",
    ]);
  });

  it("gives up its identity when it rots into scenery", () => {
    const session = new GameSession(
      beside({ tileId: "mushroom", itemId: "itm_shroom" }),
      tiles,
    );

    run(session, BERRY_MS);
    const [, turned] = asideStack(session);
    expect(turned?.tileId).toBe("stain");
    // An item id on a tile nobody can pick up would keep it counting down under
    // a key nothing can reach. As a stain it decays by cell, like any other.
    expect(turned?.itemId).toBeUndefined();
    run(session, STAIN_MS);
    expect(asideStack(session).map((p) => p.tileId)).toEqual(["grass"]);
  });
});

/**
 * What a body was carrying does not stop ageing because the body stopped.
 *
 * A kit is armed the moment it is assigned — see `GameSession.setEquipment` —
 * and a killing blow puts every piece of it on the floor still wearing the
 * identity it was minted with (`dropKit`, via `placementFromInstance`). Between
 * them the clock never notices the death: the same entry that was counting down
 * in a hand goes on counting down in the pile.
 *
 * Which is worth pinning precisely because the alternative is so plausible. A
 * pile that started fresh where it fell would be the obvious reading of "loot
 * decays", and it is the reading that lets a player farm a camp forever by
 * killing the same body before anything it carries can go off.
 */
describe("what a dead battler leaves on the floor", () => {
  /** The scarecrow standing beside the idle player, holding its one thing. */
  function withScarecrow(): GameSession {
    const map = replaceStack(
      withIdlePlayer(emptyMap()),
      BESIDE.x,
      BESIDE.y,
      BESIDE.z,
      [{ tileId: "grass" }, { tileId: "scarecrow" }],
    );
    return new GameSession(map, tiles);
  }

  /**
   * Swing until the body is gone, and say how long it took.
   *
   * The dice are seeded, so this is reproducible — but it is read rather than
   * hard-coded, because a rebalance that changes how long a fight lasts should
   * not silently change what this test is measuring from.
   */
  function killBeside(session: GameSession): number {
    const victim = session.actorIds().find((id) => id !== LOCAL_ACTOR_ID);
    if (!victim) throw new Error("nobody to kill");
    const held = session.equipmentOf(victim)?.weapon;
    if (!held) throw new Error("the scarecrow rolled no kit to drop");
    session.setTarget(victim);
    session.setAttackMode(true);
    for (let elapsed = 0; elapsed < GOURD_MS; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      if (!session.actorIds().includes(victim)) return elapsed;
    }
    throw new Error("the fight outlasted the thing it was fought over");
  }

  it("is the very thing the body was holding, identity and all", () => {
    const session = withScarecrow();
    const held = session.equipmentOf(
      session.actorIds().find((id) => id !== LOCAL_ACTOR_ID)!,
    )!.weapon!;

    killBeside(session);

    expect(asideStack(session)).toEqual([
      { tileId: "grass" },
      { tileId: "gourd", itemId: held.id },
    ]);
  });

  it("goes off on the clock it started in the kit, not the one it fell on", () => {
    const session = withScarecrow();
    const diedAtMs = killBeside(session);

    // The rest of the lifetime the kit began, and no more. A pile that started
    // over where it landed would still be a gourd here.
    run(session, GOURD_MS - diedAtMs);

    expect(stackIds(session.getMap(), BESIDE.x, BESIDE.y, BESIDE.z)).toEqual([
      "grass",
      "rotten-berry",
    ]);
  });
});
