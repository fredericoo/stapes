import { describe, expect, it } from "vitest";
import { emptyEquipment } from "../game/equipment";
import type { ItemInstance } from "../lib/itemInstance";
import { xpForLevel } from "../lib/mastery";
import type { ActiveStatus, StatusTone } from "../lib/status";
import { bagGained, newlyEquipped, statsMood } from "./panelNotice";

const item = (id: string, count?: number): ItemInstance => ({ id, tileId: "thing", count });

const bag = (id: string, contents: ItemInstance[]): ItemInstance => ({
  id,
  tileId: "bag",
  contents,
});

const status = (defId: string, tone: StatusTone): ActiveStatus => ({
  defId,
  name: defId,
  description: "",
  tone,
  icon: null,
  remainingMs: 1,
  fullDurationMs: 1,
});

describe("bagGained", () => {
  it("notices a new item and a grown stack", () => {
    expect(bagGained(bag("b", [item("a")]), bag("b", [item("a"), item("c")]))).toBe(true);
    expect(bagGained(bag("b", [item("a", 2)]), bag("b", [item("a", 3)]))).toBe(true);
  });

  it("ignores taking things out and swapping to another bag", () => {
    expect(bagGained(bag("b", [item("a"), item("c")]), bag("b", [item("a")]))).toBe(false);
    expect(bagGained(bag("b", []), bag("other", [item("a")]))).toBe(false);
  });
});

describe("newlyEquipped", () => {
  it("notices a slot gaining a different item, not one emptying", () => {
    const sword = { ...emptyEquipment(), weapon: item("sword") };
    expect(newlyEquipped(emptyEquipment(), sword)).toBe(true);
    expect(newlyEquipped(sword, { ...sword, weapon: item("axe") })).toBe(true);
    expect(newlyEquipped(sword, emptyEquipment())).toBe(false);
  });
});

describe("statsMood", () => {
  const calm = { statuses: [], masteryXp: {} };

  it("is bad when a bad status arrives, even beside good news", () => {
    expect(
      statsMood(calm, {
        statuses: [status("haste", "good"), status("burn", "bad")],
        masteryXp: {},
      }),
    ).toBe("bad");
  });

  it("is good for a new good status or a mastery level", () => {
    expect(statsMood(calm, { statuses: [status("haste", "good")], masteryXp: {} })).toBe("good");
    expect(statsMood(calm, { statuses: [], masteryXp: { sharp: xpForLevel(3) } })).toBe("good");
  });

  it("stays quiet for xp within a level and statuses already held", () => {
    const held = { statuses: [status("burn", "bad")], masteryXp: { sharp: xpForLevel(3) } };
    expect(statsMood(held, { ...held, masteryXp: { sharp: xpForLevel(3) + 1 } })).toBeNull();
  });
});
