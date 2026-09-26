import { describe, expect, it } from "vitest";
import {
  instanceFromPlacement,
  mintItemId,
  placementFromInstance,
  sameInstance,
  type ItemInstance,
} from "./itemInstance";
import type { PlacedTile } from "./types";

describe("mintItemId", () => {
  it("is distinct every time", () => {
    const ids = new Set(Array.from({ length: 100 }, mintItemId));
    expect(ids.size).toBe(100);
  });
});

describe("the placement ↔ instance round trip", () => {
  it("keeps every carried field, both ways", () => {
    const placed: PlacedTile = {
      tileId: "sign",
      itemId: "itm_1",
      direction: "e",
      channel: "gate",
      inscription: "Beware of the dog",
      description: "Scratched, and very old",
      engraved: "Green Fox",
    };
    const instance = instanceFromPlacement(placed);
    expect(instance).toEqual({
      id: "itm_1",
      tileId: "sign",
      direction: "e",
      channel: "gate",
      inscription: "Beware of the dog",
      description: "Scratched, and very old",
      engraved: "Green Fox",
    });
    expect(placementFromInstance(instance!)).toEqual(placed);
  });

  it("keeps a container's contents", () => {
    const contents: ItemInstance[] = [{ id: "itm_b", tileId: "rusty-sword" }];
    const placed: PlacedTile = {
      tileId: "basic-bag",
      itemId: "itm_a",
      contents,
    };
    const instance = instanceFromPlacement(placed)!;
    expect(instance.contents).toEqual(contents);
    expect(placementFromInstance(instance)).toEqual(placed);
  });

  it("omits absent fields rather than setting them undefined", () => {
    const instance = instanceFromPlacement({ tileId: "t", itemId: "itm_1" })!;
    expect(Object.keys(instance).sort()).toEqual(["id", "tileId"]);
    expect(Object.keys(placementFromInstance(instance)).sort()).toEqual(["itemId", "tileId"]);
  });

  it("is null for a placement with no identity", () => {
    expect(instanceFromPlacement({ tileId: "grass" })).toBeNull();
  });

  it("never carries an owner back onto the board", () => {
    const placed: PlacedTile = {
      tileId: "basic-bag",
      itemId: "itm_1",
      owner: "somebody",
    };
    const instance = instanceFromPlacement(placed)!;
    expect(instance).not.toHaveProperty("owner");
    expect(placementFromInstance(instance)).not.toHaveProperty("owner");
  });
});

describe("sameInstance", () => {
  const lever: ItemInstance = { id: "itm_a", tileId: "lever" };

  it("takes one thing for itself", () => {
    expect(sameInstance(lever, lever)).toBe(true);
  });

  it("takes two copies of the same fields for the same thing", () => {
    expect(sameInstance(lever, { id: "itm_a", tileId: "lever" })).toBe(true);
  });

  it("sees a field the tile and the count do not", () => {
    expect(sameInstance(lever, { id: "itm_a", tileId: "lever", channel: "gate" })).toBe(false);
  });

  it("sees a different identity", () => {
    expect(sameInstance(lever, { id: "itm_b", tileId: "lever" })).toBe(false);
  });

  it("sees a count", () => {
    const bread: ItemInstance = { id: "itm_a", tileId: "bread", count: 2 };
    expect(sameInstance(bread, { ...bread, count: 3 })).toBe(false);
  });
});
