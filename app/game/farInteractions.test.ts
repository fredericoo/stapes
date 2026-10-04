import { describe, expect, it } from "vitest";
import { emptyEquipment } from "./equipment";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { tile } from "../lib/testTile";
import type { ActorSnapshot } from "./GameSession";
import { FAR_MAX_STEPS, FAR_SUBJECT_LIMIT, listFarOptions, type FarScan } from "./farInteractions";
import { listInteractionOptions, type RefContext } from "./interactionOptions";

const BATTLER = { baseHp: 8, maxHp: 10, atk: 2, def: 0, acc: 50, flee: 0, spd: 50 };

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "wall", height: 8, walkable: false }),
  tile({
    id: "door_shut",
    name: "Shut door",
    height: 4,
    walkable: false,
    interactions: { switch: { targetTileId: "door_open", actionName: "Open" } },
  }),
  tile({ id: "door_open", name: "Open door", height: 4 }),
  tile({
    id: "salesman",
    name: "Salesman",
    height: 4,
    actor: true,
    interactions: { battler: BATTLER, dialog: { script: [{ kind: "say", text: "Hello." }] } },
  }),
  tile({
    id: "player",
    name: "Player",
    height: 4,
    actor: true,
    interactions: { battler: BATTLER },
  }),
];

const tilesById = tilesByIdFromList(tiles);

const FIELD_HALF_SPAN = FAR_MAX_STEPS + 3;

function place(map: MapFile, x: number, y: number, tileIds: string[]): MapFile {
  return replaceStack(
    map,
    x,
    y,
    0,
    tileIds.map((tileId) => ({ tileId })),
  );
}

function field(): MapFile {
  let map = emptyMap();
  for (let x = -FIELD_HALF_SPAN; x <= FIELD_HALF_SPAN; x++) {
    for (let y = -FIELD_HALF_SPAN; y <= FIELD_HALF_SPAN; y++) map = place(map, x, y, ["grass"]);
  }
  return map;
}

function body(id: string, tileId: string, x: number, y: number, map: MapFile): ActorSnapshot {
  return {
    id,
    name: null,
    tileId,
    x,
    y,
    z: 0,
    stackIndex: getStack(map, x, y, 0).length - 1,
    direction: "s",
    walk: null,
    fall: null,
    walkProgress: 0,
    fallProgress: 0,
    slide: null,
    slideProgress: 0,
    strike: null,
    strikeProgress: 0,
    hp: 10,
    maxHp: 10,
    rating: 10,
    statuses: [],
    carriedLights: [],
    extracting: null,
    casting: null,
    pvp: true,
    hidden: false,
  };
}

const CONTEXT: RefContext = {
  equipment: emptyEquipment(),
  openedRef: null,
  tags: [],
  spawnAt: null,
  extracting: null,
  conversation: null,
  craftingRef: null,
};

function scan(map: MapFile, others: ActorSnapshot[] = [], overrides: Partial<FarScan> = {}) {
  const withMe = place(map, 0, 0, ["grass", "player"]);
  const me = body("me", "player", 0, 0, withMe);
  const actors = [me, ...others];
  const near = listInteractionOptions(withMe, tilesById, me, actors, null, CONTEXT.equipment);
  return listFarOptions({
    map: withMe,
    tilesById,
    statusDefs: {},
    self: me,
    from: { x: 0, y: 0, z: 0 },
    def: tilesById.player!,
    actors,
    context: CONTEXT,
    near,
    shown: () => true,
    ...overrides,
  });
}

describe("listFarOptions", () => {
  it("lists a door a few steps away, marked far", () => {
    const map = place(field(), 4, 0, ["grass", "door_shut"]);

    const far = scan(map);

    expect(far.map((o) => [o.label, o.name, o.far])).toEqual([["Open", "Shut door", true]]);
  });

  it("leaves out a door with no way to it", () => {
    let map = place(field(), 4, 0, ["grass", "door_shut"]);
    for (let y = -FIELD_HALF_SPAN; y <= FIELD_HALF_SPAN; y++) {
      map = place(map, 2, y, ["grass", "wall"]);
    }

    expect(scan(map)).toEqual([]);
  });

  it("leaves out a door further than a short walk", () => {
    const map = place(field(), FAR_MAX_STEPS + 2, 0, ["grass", "door_shut"]);

    expect(scan(map)).toEqual([]);
  });

  it("leaves out what is already in reach", () => {
    const map = place(field(), 1, 0, ["grass", "door_shut"]);

    expect(scan(map)).toEqual([]);
  });

  it("offers a body across the field only Talk", () => {
    const map = place(field(), 5, 0, ["grass", "salesman"]);
    const salesman = body("npc", "salesman", 5, 0, map);

    const far = scan(map, [salesman]);

    expect(far.map((o) => o.action)).toEqual(["talk"]);
  });

  it("puts the shorter walk first", () => {
    let map = place(field(), 5, 0, ["grass", "door_shut"]);
    map = place(map, -3, 0, ["grass", "door_shut"]);

    expect(scan(map).map((o) => o.ref.x)).toEqual([-3, 5]);
  });

  it("keeps the nearest few when there are more", () => {
    let map = field();
    for (let x = -FAR_MAX_STEPS + 1; x <= FAR_MAX_STEPS - 1; x += 2) {
      map = place(map, x, 3, ["grass", "door_shut"]);
      map = place(map, x, -3, ["grass", "door_shut"]);
    }

    expect(scan(map)).toHaveLength(FAR_SUBJECT_LIMIT);
  });

  it("leaves out what the screen does not show", () => {
    const map = place(field(), 4, 0, ["grass", "door_shut"]);

    expect(scan(map, [], { shown: () => false })).toEqual([]);
  });
});
