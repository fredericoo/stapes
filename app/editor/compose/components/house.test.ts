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
