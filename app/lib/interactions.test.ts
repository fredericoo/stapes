import { describe, expect, it } from "vitest";
import {
  interactionsForSave,
  interactionKinds,
  isInteractive,
  resolveDrag,
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

  it("coexists with drag", () => {
    const def = tile({
      id: "lever",
      height: 1,
      interactions: {
        drag: { distanceTiles: 1, climb: "half", moveOnTileIds: [] },
        switch: { targetTileId: "lever-pulled" },
      },
    });
    expect(resolveDrag(def)).not.toBeNull();
    expect(resolveSwitch(def)).toEqual({ targetTileId: "lever-pulled" });
    expect(interactionKinds(def)).toEqual(["drag", "switch"]);
  });
});

describe("interactionsForSave", () => {
  it("persists switch alongside drag", () => {
    expect(
      interactionsForSave({
        drag: { distanceTiles: 1.5, climb: "full", moveOnTileIds: ["b", "a"] },
        switch: { targetTileId: "door-open" },
      }),
    ).toEqual({
      drag: {
        distanceTiles: 1.5,
        climb: "full",
        moveOnTileIds: ["a", "b"],
      },
      switch: { targetTileId: "door-open" },
    });
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
