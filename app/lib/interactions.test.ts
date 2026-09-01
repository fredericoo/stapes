import { describe, expect, it } from "vitest";
import { DEFAULT_BATTLER, type BattlerDef } from "./battler";
import type { PlateComparison } from "./interactions";
import {
  hasAnyInteraction,
  interactionsForSave,
  interactionKinds,
  isInteractive,
  plateTriggers,
  receiveTriggers,
  resolveEmit,
  resolvePressurePlate,
  resolvePush,
  resolveReceive,
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
      height: 4,
      interactions: { switch: { targetTileId: "door-open" } },
    });
    expect(resolveSwitch(def)).toEqual({ targetTileId: "door-open" });
    expect(interactionKinds(def)).toEqual(["switch"]);
    expect(isInteractive(def)).toBe(true);
  });

  it("treats an empty target as non-switchable", () => {
    const def = tile({
      id: "door-closed",
      height: 4,
      interactions: { switch: { targetTileId: "" } },
    });
    expect(resolveSwitch(def)).toBeNull();
    expect(isInteractive(def)).toBe(false);
  });

  it("coexists with push, and is tried first", () => {
    const def = tile({
      id: "lever",
      height: 2,
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

describe("resolveEmit", () => {
  it("reads a valid emit block", () => {
    const def = tile({
      id: "torch-lit",
      height: 0,
      interactions: { emit: { value: "on" } },
    });
    expect(resolveEmit(def)).toEqual({ value: "on" });
  });

  it("rejects an unknown value", () => {
    const def = tile({
      id: "torch-lit",
      height: 0,
      interactions: { emit: { value: "maybe" } },
    });
    expect(resolveEmit(def)).toBeNull();
  });

  it("is not something the player can act on", () => {
    const def = tile({
      id: "torch-lit",
      height: 0,
      interactions: { emit: { value: "on" } },
    });
    expect(isInteractive(def)).toBe(false);
    expect(hasAnyInteraction(def.interactions)).toBe(true);
  });
});

describe("resolveReceive", () => {
  it("reads a valid receive block", () => {
    const def = tile({
      id: "door",
      height: 4,
      interactions: {
        receive: { tileId: "door-open", when: "on", mode: "any" },
      },
    });
    expect(resolveReceive(def)).toEqual({
      tileId: "door-open",
      when: "on",
      mode: "any",
    });
  });

  it("rejects an empty target, an unknown reading and an unknown mode", () => {
    const noTarget = tile({
      id: "a",
      height: 4,
      interactions: { receive: { tileId: "", when: "on", mode: "any" } },
    });
    const badWhen = tile({
      id: "b",
      height: 4,
      interactions: { receive: { tileId: "x", when: "maybe", mode: "any" } },
    });
    const badMode = tile({
      id: "c",
      height: 4,
      interactions: { receive: { tileId: "x", when: "on", mode: "some" } },
    });
    expect(resolveReceive(noTarget)).toBeNull();
    expect(resolveReceive(badWhen)).toBeNull();
    expect(resolveReceive(badMode)).toBeNull();
  });

  it("is not something the player can act on", () => {
    const def = tile({
      id: "door",
      height: 4,
      interactions: {
        receive: { tileId: "door-open", when: "on", mode: "any" },
      },
    });
    expect(isInteractive(def)).toBe(false);
    expect(hasAnyInteraction(def.interactions)).toBe(true);
  });
});

describe("receiveTriggers", () => {
  it("fires on the reading it was authored for", () => {
    const onOpen = { tileId: "x", when: "on", mode: "any" } as const;
    const offClose = { tileId: "y", when: "off", mode: "any" } as const;
    expect(receiveTriggers(onOpen, true)).toBe(true);
    expect(receiveTriggers(onOpen, false)).toBe(false);
    expect(receiveTriggers(offClose, false)).toBe(true);
    expect(receiveTriggers(offClose, true)).toBe(false);
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

  it("persists emit and receive", () => {
    expect(
      interactionsForSave({
        emit: { value: "off" },
        receive: { tileId: " door-open ", when: "on", mode: "all" },
      }),
    ).toEqual({
      emit: { value: "off" },
      receive: { tileId: "door-open", when: "on", mode: "all" },
    });
  });

  it("omits a targetless receive but keeps a bare emit", () => {
    expect(
      interactionsForSave({
        emit: { value: "on" },
        receive: { tileId: "", when: "on", mode: "any" },
      }),
    ).toEqual({ emit: { value: "on" } });
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

  it("fills range and sight when a battler predates those fields", () => {
    expect(
      interactionsForSave({
        battler: {
          masteries: { fist: 9, toughness: 14 },
          naturalWeapon: DEFAULT_BATTLER.naturalWeapon,
        } as BattlerDef,
      }),
    ).toEqual({
      battler: {
        masteries: { fist: 9, toughness: 14 },
        naturalWeapon: DEFAULT_BATTLER.naturalWeapon,
        sight: { up: 0, down: 0 },
      },
    });
  });

  /**
   * The standing cost of rebuilding the block field by field is that a field
   * forgotten here is silently dropped the next time anybody saves the tile —
   * which for a kit would mean opening the tile dialog on a rat disarmed it.
   */
  it("carries a kit through a save, blank rows and all dropped", () => {
    expect(
      interactionsForSave({
        battler: {
          ...DEFAULT_BATTLER,
          kit: [
            { slot: "bag", tileId: " basic-bag ", chance: 100, contents: [] },
            { slot: "weapon", tileId: "", chance: 25 },
          ],
        },
      })?.battler?.kit,
    ).toEqual([{ slot: "bag", tileId: "basic-bag", chance: 100 }]);
  });

  /**
   * Unlike `range` and `sight`, which have a default worth writing down: an
   * empty kit on every creature in the file would be a line saying nothing.
   */
  it("omits an empty kit rather than writing it out", () => {
    expect(
      interactionsForSave({ battler: { ...DEFAULT_BATTLER, kit: [] } })?.battler,
    ).not.toHaveProperty("kit");
  });

  /**
   * A mastery nobody has trained reads the same as one nobody wrote, so writing
   * it would grow every creature's block by five lines saying nothing — and it
   * would claim the author considered a question they did not.
   */
  it("drops masteries left at zero rather than writing them out", () => {
    expect(
      interactionsForSave({
        battler: {
          masteries: { fist: 3, blade: 0, arcane: 0, toughness: 5 },
          naturalWeapon: DEFAULT_BATTLER.naturalWeapon,
        } as BattlerDef,
      })?.battler?.masteries,
    ).toEqual({ fist: 3, toughness: 5 });
  });
});
