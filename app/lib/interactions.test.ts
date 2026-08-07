import { describe, expect, it } from "vitest";
import type { PlateComparison } from "./interactions";
import {
  hasAnyInteraction,
  interactionsForSave,
  interactionKinds,
  isInteractive,
  plateTriggers,
  resolvePressurePlate,
  resolvePush,
  resolveSwitch,
} from "./interactions";
import type { TileDef } from "./types";
import { normalizeTileDef } from "./types";

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

describe("resolveSwitch", () => {
  it("reads a valid switch block", () => {
    const def = tile({
      id: "door-closed",
      height: 2,
      interactions: { switch: { targetTileId: "door-open" } },
    });
    expect(resolveSwitch(def)).toEqual({ targetTileId: "door-open" });
    expect(interactionKinds(def)).toEqual(["switch"]);
    expect(isInteractive(def)).toBe(true);
  });

  it("treats an empty target as non-switchable", () => {
    const def = tile({
      id: "door-closed",
      height: 2,
      interactions: { switch: { targetTileId: "" } },
    });
    expect(resolveSwitch(def)).toBeNull();
    expect(isInteractive(def)).toBe(false);
  });

  it("coexists with push, and is tried first", () => {
    const def = tile({
      id: "lever",
      height: 1,
      interactions: {
        push: { climb: "half", moveOnTileIds: [] },
        switch: { targetTileId: "lever-pulled" },
      },
    });
    expect(resolvePush(def)).not.toBeNull();
    expect(resolveSwitch(def)).toEqual({ targetTileId: "lever-pulled" });
    expect(interactionKinds(def)).toEqual(["switch", "push"]);
  });
});

describe("resolvePressurePlate", () => {
  it("reads a valid pressure plate block", () => {
    const def = tile({
      id: "plate",
      height: 0,
      interactions: {
        pressurePlate: { tileId: "plate-pressed", type: "gte", height: 1 },
      },
    });
    expect(resolvePressurePlate(def)).toEqual({
      tileId: "plate-pressed",
      type: "gte",
      height: 1,
    });
  });

  it("rejects an empty target, an unknown comparison and a negative height", () => {
    const noTarget = tile({
      id: "a",
      height: 0,
      interactions: { pressurePlate: { tileId: "", type: "gte", height: 1 } },
    });
    const badType = tile({
      id: "b",
      height: 0,
      interactions: { pressurePlate: { tileId: "x", type: "roughly", height: 1 } },
    });
    const negative = tile({
      id: "c",
      height: 0,
      interactions: { pressurePlate: { tileId: "x", type: "gte", height: -1 } },
    });
    expect(resolvePressurePlate(noTarget)).toBeNull();
    expect(resolvePressurePlate(badType)).toBeNull();
    expect(resolvePressurePlate(negative)).toBeNull();
  });

  it("is not something the player can act on", () => {
    const def = tile({
      id: "plate",
      height: 0,
      interactions: {
        pressurePlate: { tileId: "plate-pressed", type: "gte", height: 1 },
      },
    });
    expect(interactionKinds(def)).toEqual([]);
    expect(isInteractive(def)).toBe(false);
    expect(hasAnyInteraction(def.interactions)).toBe(true);
  });
});

describe("plateTriggers", () => {
  const cases: Array<[PlateComparison, number[]]> = [
    ["eq", [1]],
    ["neq", [0, 2]],
    ["gt", [2]],
    ["gte", [1, 2]],
    ["lt", [0]],
    ["lte", [0, 1]],
  ];

  it.each(cases)("%s fires on exactly the right loads", (type, expected) => {
    const plate = { tileId: "x", type, height: 1 };
    const firing = [0, 1, 2].filter((load) => plateTriggers(plate, load));
    expect(firing).toEqual(expected);
  });
});

describe("interactionsForSave", () => {
  it("persists switch alongside push", () => {
    expect(
      interactionsForSave({
        push: { climb: "full", moveOnTileIds: ["b", "a"] },
        switch: { targetTileId: "door-open" },
      }),
    ).toEqual({
      push: { climb: "full", moveOnTileIds: ["a", "b"] },
      switch: { targetTileId: "door-open" },
    });
  });

  it("persists a pressure plate", () => {
    expect(
      interactionsForSave({
        pressurePlate: { tileId: " plate-pressed ", type: "lte", height: 0 },
      }),
    ).toEqual({
      pressurePlate: { tileId: "plate-pressed", type: "lte", height: 0 },
    });
  });

  it("omits a targetless pressure plate", () => {
    expect(
      interactionsForSave({
        pressurePlate: { tileId: "", type: "gte", height: 1 },
      }),
    ).toBeUndefined();
  });

  it("omits an empty switch target", () => {
    expect(
      interactionsForSave({ switch: { targetTileId: "" } }),
    ).toBeUndefined();
  });

  it("omits the field when nothing is enabled", () => {
    expect(interactionsForSave({})).toBeUndefined();
    expect(interactionsForSave(undefined)).toBeUndefined();
  });
});
