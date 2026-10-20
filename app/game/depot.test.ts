import { describe, expect, it } from "vitest";
import { DEFAULT_CONSUMABLE, DEFAULT_CONTAINER, DEFAULT_WEAPON } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import type { ObjectRef } from "./affordances";
import { applyDepotMove, DepotLedger, NO_DEPOTS, restoredDepots, type Depots } from "./depot";
import { emptyEquipment, type Equipment } from "./equipment";
import type { SlotRef } from "./itemMoves";

function tile(partial: Record<string, unknown>): TileDef {
  return normalizeTileDef({
    name: partial.id,
    height: 0,
    type: "simple",
    kind: "prop",
    attributes: {},
    sprite: { frames: [] },
    ...partial,
  });
}

const DEPOT_SIZE = 2;

const tiles = [
  tile({ id: "grass" }),
  tile({ id: "crate", height: 2 }),
  tile({ id: "safe", height: 2, interactions: { depot: { size: DEPOT_SIZE } } }),
  tile({ id: "sword", kind: "item", interactions: { item: DEFAULT_WEAPON } }),
  tile({ id: "apple", kind: "item", interactions: { item: DEFAULT_CONSUMABLE } }),
  tile({ id: "bag", kind: "item", interactions: { item: DEFAULT_CONTAINER } }),
];
const tilesById = tilesByIdFromList(tiles);

const ME = { x: 0, y: 0, z: 0, stackIndex: 0 };
const SAFE: ObjectRef = { x: 1, y: 0, z: 0, stackIndex: 1 };
const OTHER_SAFE: ObjectRef = { x: -1, y: 0, z: 0, stackIndex: 1 };

function safeAt(map: MapFile, at: ObjectRef, placed: Partial<PlacedTile> = {}): MapFile {
  return replaceStack(map, at.x, at.y, at.z, [
    { tileId: "grass" },
    { tileId: "safe", depotTag: "town", ...placed },
  ]);
}

function item(id: string, tileId = "sword", count?: number): ItemInstance {
  return { id, tileId, ...(count ? { count } : {}) };
}

function carrying(...contents: ItemInstance[]): Equipment {
  return { ...emptyEquipment(), bag: { id: "itm_bag", tileId: "bag", contents } };
}

const BAG_0: SlotRef = { kind: "contents", index: 0 };
const INTO_SAFE: SlotRef = { kind: "depot", ref: SAFE, index: 0 };

function move(
  map: MapFile,
  equipment: Equipment,
  depots: Depots,
  from: SlotRef,
  to: SlotRef,
  actor = ME,
) {
  return applyDepotMove(map, tilesById, actor, equipment, depots, from, to);
}

describe("putting something in a depot", () => {
  const map = safeAt(emptyMap(), SAFE);

  it("takes it out of the bag and files it under the placement's tag", () => {
    const moved = move(map, carrying(item("itm_a")), NO_DEPOTS, BAG_0, INTO_SAFE);

    expect(moved?.equipment.bag?.contents).toEqual([]);
    expect(moved?.depots).toEqual({ town: [item("itm_a")] });
    expect(moved?.map).toBe(map);
  });

  it("pours a pile onto the pile already there instead of taking a slot", () => {
    const depots = { town: [item("itm_old", "apple", 2), item("itm_b")] };
    const moved = move(map, carrying(item("itm_new", "apple", 3)), depots, BAG_0, INTO_SAFE);

    expect(moved?.depots.town).toEqual([item("itm_old", "apple", 5), item("itm_b")]);
  });

  it("refuses when every slot is taken", () => {
    const full = { town: [item("itm_a"), item("itm_b")] };
    expect(move(map, carrying(item("itm_c")), full, BAG_0, INTO_SAFE)).toBeNull();
  });

  it("refuses a container, as every container does", () => {
    const equipment = { ...emptyEquipment(), weapon: { id: "itm_sack", tileId: "bag" } };
    expect(move(map, equipment, NO_DEPOTS, { kind: "weapon" }, INTO_SAFE)).toBeNull();
  });

  it("refuses from out of reach", () => {
    const far = { x: 5, y: 0, z: 0, stackIndex: 0 };
    expect(move(map, carrying(item("itm_a")), NO_DEPOTS, BAG_0, INTO_SAFE, far)).toBeNull();
  });

  it("refuses at a depot placed with no tag", () => {
    const untagged = safeAt(emptyMap(), SAFE, { depotTag: undefined });
    expect(move(untagged, carrying(item("itm_a")), NO_DEPOTS, BAG_0, INTO_SAFE)).toBeNull();
  });

  it("refuses at a depot something has been stacked on", () => {
    const buried = replaceStack(emptyMap(), SAFE.x, SAFE.y, SAFE.z, [
      { tileId: "grass" },
      { tileId: "safe", depotTag: "town" },
      { tileId: "crate" },
    ]);
    expect(move(buried, carrying(item("itm_a")), NO_DEPOTS, BAG_0, INTO_SAFE)).toBeNull();
  });
});

describe("taking something out of a depot", () => {
  const map = safeAt(safeAt(emptyMap(), SAFE), OTHER_SAFE);

  it("hands it to the slot it was dragged to", () => {
    const depots = { town: [item("itm_a"), item("itm_b")] };
    const moved = move(map, carrying(), depots, { kind: "depot", ref: SAFE, index: 1 }, BAG_0);

    expect(moved?.equipment.bag?.contents).toEqual([item("itm_b")]);
    expect(moved?.depots.town).toEqual([item("itm_a")]);
  });

  it("opens the same stash from any placement with the same tag", () => {
    const depots = { town: [item("itm_a")] };
    const from: SlotRef = { kind: "depot", ref: OTHER_SAFE, index: 0 };
    expect(move(map, carrying(), depots, from, BAG_0)?.depots.town).toEqual([]);
  });

  it("leaves another tag's stash alone", () => {
    const depots = { town: [item("itm_a")], harbour: [item("itm_h")] };
    const moved = move(map, carrying(), depots, { kind: "depot", ref: SAFE, index: 0 }, BAG_0);
    expect(moved?.depots.harbour).toEqual([item("itm_h")]);
  });

  it("refuses when the bag has no room", () => {
    const fullBag = carrying(
      ...Array.from({ length: DEFAULT_CONTAINER.size }, (_, i) => item(`itm_${i}`)),
    );
    const depots = { town: [item("itm_a")] };
    const from: SlotRef = { kind: "depot", ref: SAFE, index: 0 };
    expect(move(map, fullBag, depots, from, BAG_0)).toBeNull();
  });

  it("refuses a move from one depot slot to another", () => {
    const depots = { town: [item("itm_a")] };
    const from: SlotRef = { kind: "depot", ref: SAFE, index: 0 };
    const to: SlotRef = { kind: "depot", ref: OTHER_SAFE, index: 0 };
    expect(move(map, carrying(), depots, from, to)).toBeNull();
  });
});

describe("the ledger", () => {
  it("gives two characters of one account the same stash", () => {
    const ledger = new DepotLedger();
    ledger.seat("alice", "account-1");
    ledger.seat("alfred", "account-1");
    ledger.seat("bob", "account-2");

    ledger.write("alice", { town: [item("itm_a")] });

    expect(ledger.of("alfred")).toEqual({ town: [item("itm_a")] });
    expect(ledger.of("bob")).toEqual(NO_DEPOTS);
    expect(ledger.drainChangedActors().sort()).toEqual(["alfred", "alice"]);
  });

  it("holds a stash back from a save that leaves out one of its owner's characters", () => {
    const ledger = new DepotLedger();
    ledger.seat("alice", "account-1");
    ledger.seat("alfred", "account-1");
    ledger.write("alice", { town: [item("itm_a")] });

    expect(ledger.drainUnsaved(new Set(["alice"]))).toEqual([]);
    expect(ledger.drainUnsaved(new Set(["alice", "alfred"]))).toEqual([
      ["account-1", { town: [item("itm_a")] }],
    ]);
  });

  it("keeps a stash that has not been saved after its last character leaves", () => {
    const ledger = new DepotLedger();
    ledger.seat("alice", "account-1");
    ledger.write("alice", { town: [item("itm_a")] });
    ledger.unseat("alice");

    expect(ledger.holds("account-1")).toBe(true);
    ledger.drainUnsaved(new Set());
    expect(ledger.holds("account-1")).toBe(false);
  });
});

describe("restoring a saved stash", () => {
  it("drops what is no longer a storable item and gives the rest an id", () => {
    const restored = restoredDepots(
      { town: [{ tileId: "sword" }, { tileId: "gone" }, { tileId: "bag" }] },
      tilesById,
    );

    expect(restored.town).toHaveLength(1);
    expect(restored.town?.[0]?.tileId).toBe("sword");
    expect(restored.town?.[0]?.id).toBeTruthy();
  });

  it("reads anything unrecognisable as an empty depot", () => {
    expect(restoredDepots("garbage", tilesById)).toEqual(NO_DEPOTS);
  });
});
