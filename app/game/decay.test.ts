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
import { tile } from "../lib/testTile";

const BAG_TILE_ID = "basic-bag";

const BLOOD_MS = 1000;
const STAIN_MS = 2000;

const JITTER_FROM_MS = 1000;
const JITTER_TO_MS = 5000;

const BERRY_MS = 3000;
const ROTTEN_MS = 4000;

const GOURD_MS = 60_000;

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

const EDIBLE = { type: "consumable", hp: 0 } as const;

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
  directionalTile("player", {
    affectedByGravity: true,
    walkable: false,
    kind: "battler",
    interactions: {
      battler: {
        baseHp: 8,
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
  tile({
    id: "blood",
    height: 0,
    interactions: { decay: { tileId: "stain", fromMs: BLOOD_MS, toMs: BLOOD_MS } },
  }),
  tile({
    id: "stain",
    height: 0,
    interactions: { decay: { tileId: "", fromMs: STAIN_MS, toMs: STAIN_MS } },
  }),
  tile({
    id: "ember",
    height: 0,
    transitions: {
      disappear: {
        durationMs: 700,
        dissolve: { pattern: "noise", edgeColor: "#ff9e40", edgeWidth: 0.2 },
      },
    },
    interactions: { decay: { tileId: "ash", fromMs: BLOOD_MS, toMs: BLOOD_MS } },
  }),
  tile({
    id: "ash",
    height: 0,
    transitions: {
      appear: {
        durationMs: 700,
        dissolve: { pattern: "dither", edgeColor: "#b0a8a0", edgeWidth: 0 },
      },
    },
  }),
  tile({
    id: "spatter",
    height: 0,
    interactions: {
      decay: { tileId: "", fromMs: JITTER_FROM_MS, toMs: JITTER_TO_MS },
    },
  }),
  tile({
    id: "swell",
    height: 0,
    interactions: { decay: { tileId: "wall", fromMs: BLOOD_MS, toMs: BLOOD_MS } },
  }),
  tile({
    id: "orphan",
    height: 0,
    interactions: { decay: { tileId: "nope", fromMs: BLOOD_MS, toMs: BLOOD_MS } },
  }),
  tile({
    id: "inert",
    height: 0,
    interactions: { decay: { tileId: "", fromMs: 0, toMs: 0 } },
  }),
  tile({
    id: "backwards",
    height: 0,
    interactions: { decay: { tileId: "", fromMs: 5000, toMs: 1000 } },
  }),
  directionalTile("ghoul", {
    actor: true,
    affectedByGravity: true,
    walkable: false,
    interactions: { decay: { tileId: "", fromMs: BLOOD_MS, toMs: BLOOD_MS } },
  }),
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
  itemTile("seed-pod", EDIBLE, {
    tileId: "crate",
    fromMs: BERRY_MS,
    toMs: BERRY_MS,
  }),
  itemTile("mushroom", EDIBLE, { tileId: "stain", fromMs: BERRY_MS, toMs: BERRY_MS }),
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
  itemTile(
    "satchel",
    { type: "container", size: 2, equippable: true },
    {
      tileId: "",
      fromMs: BERRY_MS,
      toMs: BERRY_MS,
    },
  ),
  itemTile("gourd", EDIBLE, {
    tileId: "rotten-berry",
    fromMs: GOURD_MS,
    toMs: GOURD_MS,
  }),
  tile({
    id: "scarecrow",
    height: 2,
    actor: true,
    walkable: false,
    kind: "battler",
    interactions: {
      battler: {
        baseHp: 8,
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

function withIdlePlayer(map: MapFile): MapFile {
  return replaceStack(map, 9, 9, 0, [{ tileId: "grass" }, { tileId: "player", direction: "s" }]);
}

function stackIds(map: MapFile, x: number, y: number, z = 0): string[] {
  return getStack(map, x, y, z).map((p) => p.tileId);
}

function run(session: GameSession, ms: number) {
  for (let i = 0; i <= Math.ceil(ms / TICK_MS); i++) session.tick(TICK_MS);
}

const ORIGIN = { x: 0, y: 0, z: 0 };

describe("findDecayCells", () => {
  it("finds decaying placements across levels and skips inert ones", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "blood" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "inert" }]);
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
    const index = armed(replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]));
    expect(index.pending()).toBe(false);
  });

  it("yields an entry only once its lifetime has elapsed", () => {
    const index = armed(replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "blood" }]));
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
    const distinct = new Set(jitteredDeadlines(50));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it("draws the same lifetimes from the same seed, and different from another", () => {
    expect(jitteredDeadlines(20, 1)).toEqual(jitteredDeadlines(20, 1));
    expect(jitteredDeadlines(20, 1)).not.toEqual(jitteredDeadlines(20, 2));
  });

  it("spends exactly one draw per placement, whatever the range", () => {
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
    expect(due[0]!.dueMs).toBe(JITTER_FROM_MS + new Rng(3).int(JITTER_TO_MS - JITTER_FROM_MS + 1));
  });
});

describe("applyDecay", () => {
  const due = (tileId: string) => [{ kind: "placement", cell: ORIGIN, tileId, dueMs: 0 }] as const;

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
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId: "stain" }]);
    const result = applyDecay(map, due("stain"), tilesById);
    expect(stackIds(result.map, 0, 0)).toEqual(["grass"]);
  });

  it("clears the cell when the last placement in it goes", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "stain" }]);
    const result = applyDecay(map, due("stain"), tilesById);
    expect(stackIds(result.map, 0, 0)).toEqual([]);
  });

  it("abandons a swap that would not fit under its own load", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "swell" }, { tileId: "wall" }]);
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
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "ghoul", owner: "someone" }]);
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
      replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId: "blood" }]),
    );
    const session = new GameSession(map, tiles);
    expect(stackIds(session.getMap(), 0, 0)).toEqual(["grass", "blood"]);

    run(session, BLOOD_MS);
    expect(stackIds(session.getMap(), 0, 0)).toEqual(["grass", "stain"]);
  });

  it("chains through a tile that decays in turn", () => {
    const map = withIdlePlayer(
      replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId: "blood" }]),
    );
    const session = new GameSession(map, tiles);

    run(session, BLOOD_MS + STAIN_MS);
    expect(stackIds(session.getMap(), 0, 0)).toEqual(["grass"]);
  });

  it("does not rest while anything is counting down", () => {
    const map = withIdlePlayer(
      replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId: "stain" }]),
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
      replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId: "blood" }]),
    );
    const session = new GameSession(map, tiles);
    const ref = { x: 0, y: 0, z: 0, stackIndex: 1 };
    expect(session.canInteract(ref)).toBe(false);
    expect(session.interact(ref)).toBe(false);
  });
});

function runHearing(session: GameSession, ms: number): string[] {
  const heard: string[] = [];
  for (let i = 0; i <= Math.ceil(ms / TICK_MS); i++) {
    session.tick(TICK_MS);
    for (const note of session.drainTransitions()) {
      heard.push(`${note.side} ${note.tileId} @${note.x},${note.y},${note.z}#${note.stackIndex}`);
    }
  }
  return heard;
}

describe("GameSession transitions", () => {
  it("announces nothing for a decay nobody authored a way out of", () => {
    const map = withIdlePlayer(
      replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId: "blood" }]),
    );
    const session = new GameSession(map, tiles);

    expect(runHearing(session, BLOOD_MS)).toEqual([]);
    expect(stackIds(session.getMap(), 0, 0)).toEqual(["grass", "stain"]);
  });

  it("plays an ember out and the ash it leaves in, at the slot it sat in", () => {
    const map = withIdlePlayer(
      replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId: "ember" }]),
    );
    const session = new GameSession(map, tiles);

    expect(runHearing(session, BLOOD_MS)).toEqual([
      "disappear ember @0,0,0#1",
      "appear ash @0,0,0#1",
    ]);
    expect(stackIds(session.getMap(), 0, 0)).toEqual(["grass", "ash"]);
  });

  it("announces every copy in the cell, each at its own slot", () => {
    const map = withIdlePlayer(
      replaceStack(emptyMap(), 0, 0, 0, [
        { tileId: "grass" },
        { tileId: "ember" },
        { tileId: "ember" },
      ]),
    );
    const session = new GameSession(map, tiles);

    expect(runHearing(session, BLOOD_MS).sort()).toEqual([
      "appear ash @0,0,0#1",
      "appear ash @0,0,0#2",
      "disappear ember @0,0,0#1",
      "disappear ember @0,0,0#2",
    ]);
  });

  it("announces nothing when an authored thing is merely picked up", () => {
    const glowcap = tile({
      id: "glowcap",
      height: 0,
      kind: "item",
      intangible: true,
      interactions: { item: EDIBLE },
      transitions: {
        appear: {
          durationMs: 700,
          dissolve: { pattern: "noise", edgeColor: "#8ce6ff", edgeWidth: 0.2 },
        },
        disappear: {
          durationMs: 700,
          dissolve: { pattern: "noise", edgeColor: "#8ce6ff", edgeWidth: 0.2 },
        },
      },
    });
    const map = replaceStack(withIdlePlayer(emptyMap()), 9, 10, 0, [
      { tileId: "grass" },
      { tileId: "glowcap", itemId: "cap-1" },
    ]);
    const session = new GameSession(map, [...tiles, glowcap]);

    expect(session.pickUp({ x: 9, y: 10, z: 0, stackIndex: 1 })).toBe(true);
    expect(session.drainTransitions()).toEqual([]);
    expect(runHearing(session, TICK_MS)).toEqual([]);

    expect(session.drop({ kind: "contents", index: 0 }, { x: 9, y: 10, z: 0 })).toBe(true);
    expect(session.drainTransitions()).toEqual([]);
    expect(session.takeTransitions()).toEqual([]);
  });

  it("plays each one out of the slot a viewer last saw it in", () => {
    const puddle = tile({
      id: "puddle",
      height: 0,
      interactions: { decay: { tileId: "", fromMs: BLOOD_MS, toMs: BLOOD_MS } },
    });
    const map = withIdlePlayer(
      replaceStack(emptyMap(), 0, 0, 0, [
        { tileId: "grass" },
        { tileId: "puddle" },
        { tileId: "ember" },
      ]),
    );
    const session = new GameSession(map, [...tiles, puddle]);

    expect(runHearing(session, BLOOD_MS)).toEqual([
      "disappear ember @0,0,0#2",
      "appear ash @0,0,0#1",
    ]);
    expect(stackIds(session.getMap(), 0, 0)).toEqual(["grass", "ash"]);
  });
});

const BESIDE: Coord = { x: 8, y: 9, z: 0 };

function withCompany(map: MapFile): MapFile {
  return replaceStack(withIdlePlayer(map), BESIDE.x, BESIDE.y, BESIDE.z, [{ tileId: "grass" }]);
}

function beside(placed: PlacedTile): MapFile {
  return replaceStack(withIdlePlayer(emptyMap()), BESIDE.x, BESIDE.y, BESIDE.z, [
    { tileId: "grass" },
    placed,
  ]);
}

function thing(id: string, tileId: string): ItemInstance {
  return { id, tileId };
}

function kitWith(contents: ItemInstance[], slots: Partial<Equipment> = {}): Equipment {
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

function bearerOf(session: GameSession, kit: Equipment): string {
  session.spawn("bearer", { at: BESIDE, carrying: kit });
  return "bearer";
}

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
    const who = bearerOf(session, kitWith([], { offhand: thing("itm_berry", "berry") }));

    run(session, BERRY_MS);
    expect(carried(session, who).offhand?.tileId).toBe("rotten-berry");
  });

  it("rots one out of a pile at a time, into a pile beside it", () => {
    const session = new GameSession(withCompany(emptyMap()), tiles);
    const who = bearerOf(session, kitWith([{ ...thing("itm_berries", "berry"), count: 3 }]));

    run(session, BERRY_MS);
    expect(carried(session, who).bag?.contents).toEqual([
      { id: "itm_berries", tileId: "berry", count: 2 },
      { id: expect.any(String), tileId: "rotten-berry" },
    ]);
  });

  it("keeps the pile counting down, one lifetime at a time", () => {
    const session = new GameSession(withCompany(emptyMap()), tiles);
    const who = bearerOf(session, kitWith([{ ...thing("itm_berries", "berry"), count: 3 }]));

    run(session, BERRY_MS);
    run(session, BERRY_MS);
    const contents = carried(session, who).bag?.contents ?? [];
    expect(contents[0]).toEqual({ id: "itm_berries", tileId: "berry" });
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
    expect(asideStack(session)[1]?.contents).toEqual([{ id: "itm_berry", tileId: "rotten-berry" }]);
  });

  it("does not start over when somebody picks it up", () => {
    const session = new GameSession(beside({ tileId: "berry", itemId: "itm_berry" }), tiles);

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
    const who = bearerOf(session, kitWith([], { weapon: thing("itm_club", "bone-club") }));

    run(session, BERRY_MS);
    expect(carried(session, who).weapon?.tileId).toBe("berry");
  });

  it("refuses a turn the hand it is in could not hold", () => {
    const session = new GameSession(withCompany(emptyMap()), tiles);
    const who = bearerOf(session, kitWith([], { offhand: thing("itm_shroom", "mushroom") }));

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
    const session = new GameSession(beside({ tileId: "seed-pod", itemId: "itm_pod" }), tiles);

    run(session, BERRY_MS);
    expect(asideStack(session).map((p) => p.tileId)).toEqual(["grass", "crate"]);
  });

  it("gives up its identity when it rots into scenery", () => {
    const session = new GameSession(beside({ tileId: "mushroom", itemId: "itm_shroom" }), tiles);

    run(session, BERRY_MS);
    const [, turned] = asideStack(session);
    expect(turned?.tileId).toBe("stain");
    expect(turned?.itemId).toBeUndefined();
    run(session, STAIN_MS);
    expect(asideStack(session).map((p) => p.tileId)).toEqual(["grass"]);
  });
});

describe("what a dead battler leaves on the floor", () => {
  function withScarecrow(): GameSession {
    const map = replaceStack(withIdlePlayer(emptyMap()), BESIDE.x, BESIDE.y, BESIDE.z, [
      { tileId: "grass" },
      { tileId: "scarecrow" },
    ]);
    return new GameSession(map, tiles);
  }

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

    run(session, GOURD_MS - diedAtMs);

    expect(stackIds(session.getMap(), BESIDE.x, BESIDE.y, BESIDE.z)).toEqual([
      "grass",
      "rotten-berry",
    ]);
  });
});
