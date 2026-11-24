import { describe, expect, it } from "vitest";
import type { MapNode } from "../doc";
import { buildTree, frame, land, levelsWalked, node, sketch } from "../testTree";

const SIZE = { w: 40, h: 30 };
const SITE = frame(10, 8, 9, 8);
const STREET = { x: 14, y: 17 };
const FRONT_DOOR = { x: 0, y: 0, pinX: "center", pinY: "bottom" };

const house = (children: MapNode[]) => node("house", {}, { frame: SITE, children });

const inn = () =>
  house([
    node("floor", { use: "pub", rooms: 2, doors: [FRONT_DOOR] }),
    node("floor", { use: "inn", rooms: 3 }),
    node("floor", { use: "storage", reachedBy: "ladder" }),
    node("cellar", { rooms: 2 }),
    node("roof"),
  ]);

describe("a house with floors, a cellar and a roof", () => {
  it("lets a player outside the door walk to every floor and the cellar and back out", () => {
    const built = buildTree(land(SIZE, [inn()]));
    expect(levelsWalked(built, STREET), sketch(built)).toEqual([-1, 0, 1, 2]);
  });

  it("keeps every floor walkable when the house stands on a hill", () => {
    const built = buildTree(
      land(SIZE, [
        node("hill", { levels: 1, roughness: 0 }, { frame: frame(2, 2, 34, 26) }),
        inn(),
      ]),
    );
    expect(levelsWalked(built, STREET), sketch(built)).toEqual([0, 1, 2, 3]);
  });

  it.each(["stone-stairs", "ramp", "snowy-ramp"])(
    "is climbed by a flight of %s when a floor picks it",
    (stairs) => {
      const built = buildTree(
        land(SIZE, [
          house([
            node("floor", { use: "empty", doors: [FRONT_DOOR] }),
            node("floor", { use: "empty", stairs }),
          ]),
        ]),
      );
      expect(levelsWalked(built, STREET), sketch(built)).toEqual([0, 1]);
    },
  );

  it("shuts its floors off from the street when it has no door, which is what the walk is checking", () => {
    const built = buildTree(
      land(SIZE, [house([node("floor", { use: "empty" }), node("floor", { use: "empty" })])]),
    );
    expect(levelsWalked(built, STREET), sketch(built)).toEqual([0]);
  });
});

describe("a floor's stock", () => {
  const stocked = (foodOnly: boolean, stockPercent = 100) => {
    const built = buildTree(
      land(SIZE, [
        house([
          node("floor", { use: "barracks", rooms: 2, foodOnly, stockPercent, doors: [FRONT_DOOR] }),
          node("cellar", { use: "smithy", foodOnly, stockPercent }),
        ]),
      ]),
    );
    const items: string[] = [];
    for (const level of Object.values(built.map.levels)) {
      for (const chunk of Object.values(level)) {
        for (const stack of Object.values(chunk)) {
          for (const placed of stack) {
            for (const item of placed.contents ?? []) {
              items.push(...Array<string>(item.count ?? 1).fill(item.tileId));
            }
          }
        }
      }
    }
    return { built, items };
  };

  it("keeps the weapons, gear and gold of a barracks and a smithy out of their chests", () => {
    const usual = stocked(false);
    expect(usual.items, sketch(usual.built)).toContain("gold");
    const { built, items } = stocked(true);
    expect(items.length, sketch(built)).toBeGreaterThan(0);
    const food = new Set(["bread", "ale", "apple", "berry", "cheese", "cooked-meat"]);
    expect(
      items.filter((id) => !food.has(id)),
      sketch(built),
    ).toEqual([]);
  });

  it("is a tenth of the usual at ten percent, and none at zero", () => {
    const count = (stockPercent: number) => {
      const built = buildTree(
        land(SIZE, [
          house([
            node("floor", { use: "storage", stockPercent, doors: [FRONT_DOOR] }),
            node("cellar", { use: "storage", stockPercent }),
          ]),
        ]),
      );
      let n = 0;
      for (const level of Object.values(built.map.levels)) {
        for (const chunk of Object.values(level)) {
          for (const stack of Object.values(chunk)) {
            for (const placed of stack) {
              for (const item of placed.contents ?? []) n += item.count ?? 1;
            }
          }
        }
      }
      return n;
    };
    const usual = count(100);
    expect(usual).toBeGreaterThan(30);
    expect(count(10)).toBeGreaterThan(0);
    expect(count(10)).toBeLessThan(usual / 5);
    expect(count(0)).toBe(0);
  });
});
