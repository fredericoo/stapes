import { describe, expect, it } from "vitest";
import {
  instanceFromPlacement,
  mintItemId,
  placementFromInstance,
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
  /**
   * The test that catches the next field somebody adds to one side only. An
   * item is a placement without a position, and the moment that stops being true
   * a pickup starts quietly eating whatever was added.
   */
  it("keeps every carried field, both ways", () => {
    const placed: PlacedTile = {
      tileId: "sign",
      itemId: "itm_1",
      direction: "e",
      channel: "gate",
      description: "Beware of the dog",
    };
    const instance = instanceFromPlacement(placed);
    expect(instance).toEqual({
      id: "itm_1",
      tileId: "sign",
      direction: "e",
      channel: "gate",
      description: "Beware of the dog",
    });
    expect(placementFromInstance(instance!)).toEqual(placed);
  });

  it("keeps a container's contents", () => {
    const contents: ItemInstance[] = [
      { id: "itm_b", tileId: "rusty-sword" },
    ];
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
    expect(Object.keys(placementFromInstance(instance)).sort()).toEqual([
      "itemId",
      "tileId",
    ]);
  });

  it("is null for a placement with no identity", () => {
    expect(instanceFromPlacement({ tileId: "grass" })).toBeNull();
  });

  /**
   * `owner` is what marks a placement as somebody's body. An item that carried
   * one back onto the board would read as a person.
   */
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
