import { describe, expect, it } from "vitest";
import { cellKey } from "../../../game/pressurePlates";
import { getStack, serializeMap } from "../../../lib/mapData";
import type { BuildResult } from "../build";
import { buildTree, frame, land, node, reach, sketch, walks, type Spot } from "../testTree";

const SIZE = { w: 40, h: 30 };
const SITE = frame(8, 6, 24, 18);
const OUTSIDE = { x: 20, y: 27 };
const COURTYARD = { x: 20, y: 15 };
const SOUTH_GATE = { x: 0, y: 1, pinX: "center", pinY: "bottom" };
const WALKWAY = "flagstone-floor";

const ring = (props: Record<string, unknown> = {}, site = SITE) =>
  node(
    "wall",
    {
      from: { x: 1, y: 1 },
      via: [
        { x: 1, y: 1, pinX: "right" },
        { x: 1, y: 1, pinX: "right", pinY: "bottom" },
      ],
      to: { x: 1, y: 1, pinY: "bottom" },
      closed: true,
      ...props,
    },
    { frame: site },
  );

/** The top cells of a wall that are walked on rather than battlement, on level `z`. */
function walkway(built: BuildResult, z: number): Spot[] {
  const cells: Spot[] = [];
  for (let y = 0; y < SIZE.h; y++) {
    for (let x = 0; x < SIZE.w; x++) {
      const stack = getStack(built.map, x, y, z);
      if (stack.length === 1 && stack[0]!.tileId === WALKWAY) cells.push({ x, y, z });
    }
  }
  return cells;
}

/**
 * How many of `cells` a player starting at `from` walks to, or none of them
 * when the walk from the first one back to `from` fails.
 */
function walkedBothWays(built: BuildResult, from: Spot, cells: readonly Spot[]): number {
  const out = reach(built, from);
  const home = out.keys().next().value!;
  if (cells[0] && !reach(built, cells[0]).has(home)) return 0;
  return cells.filter((cell) => out.has(cellKey({ ...cell, z: cell.z! }))).length;
}

describe("a closed castle wall", () => {
  it("keeps a player outside out of the ground it encloses", () => {
    const built = buildTree(land(SIZE, [ring()]));
    expect(walks(built, OUTSIDE, COURTYARD), sketch(built)).toBe(false);
  });

  it("lets a player in through a gate", () => {
    const built = buildTree(land(SIZE, [ring({ gates: [SOUTH_GATE] })]));
    expect(walks(built, OUTSIDE, COURTYARD), sketch(built)).toBe(true);
  });

  it("opens a gate where a road runs through it", () => {
    const road = node("road", { from: OUTSIDE, to: COURTYARD });
    const built = buildTree(land(SIZE, [ring(), road]));
    expect(walks(built, OUTSIDE, COURTYARD), sketch(built)).toBe(true);
  });

  it("opens a gate as wide as the road, on the cells the road is laid on", () => {
    const road = node("road", { from: { x: 2, y: 15 }, to: COURTYARD, width: 2, wander: 0 });
    const built = buildTree(land(SIZE, [ring(), road]));
    const walled = (y: number) =>
      getStack(built.map, 9, y, 0).some((p) => p.tileId === "brick-wall");
    expect([walled(14), walled(15), walled(16), walled(17)], sketch(built)).toEqual([
      true,
      false,
      false,
      true,
    ]);
  });

  it("opens no second gate for a road that passes beside a gate it names", () => {
    const wallCells = (built: BuildResult) =>
      Array.from({ length: SIZE.w * SIZE.h }).filter((_, i) =>
        getStack(built.map, i % SIZE.w, Math.floor(i / SIZE.w), 0).some(
          (p) => p.tileId === "brick-wall",
        ),
      ).length;
    const gated = ring({ gates: [SOUTH_GATE] });
    const road = node("road", { from: OUTSIDE, to: COURTYARD, wander: 0 });
    expect(wallCells(buildTree(land(SIZE, [gated, road])))).toBe(
      wallCells(buildTree(land(SIZE, [gated]))),
    );
  });

  it("moves a road's gate when the road after it in the tree moves", () => {
    const tree = (x: number) =>
      land(SIZE, [ring(), node("road", { from: { x, y: 27 }, to: { x, y: 15 }, wander: 0 })]);
    const resumed = buildTree(tree(16), { previous: buildTree(tree(24)) });
    expect(serializeMap(resumed.map)).toBe(serializeMap(buildTree(tree(16)).map));
  });

  it("lets a player through a gate that has a door", () => {
    const built = buildTree(land(SIZE, [ring({ gates: [SOUTH_GATE], door: "door-closed" })]));
    expect(walks(built, OUTSIDE, COURTYARD), sketch(built)).toBe(true);
  });

  it("has a walkway nobody reaches without stairs", () => {
    const built = buildTree(land(SIZE, [ring({ gates: [SOUTH_GATE] })]));
    const top = walkway(built, 1);
    expect(top.length).toBeGreaterThan(0);
    expect(walkedBothWays(built, COURTYARD, top), sketch(built)).toBe(0);
  });

  it("is walked all the way round from its stairs, over the gate too", () => {
    const built = buildTree(land(SIZE, [ring({ gates: [SOUTH_GATE], stairs: [{ x: 8, y: 4 }] })]));
    const top = walkway(built, 1);
    const overGate = top.filter((cell) => getStack(built.map, cell.x, cell.y, 0).length === 1);
    expect(overGate.length).toBeGreaterThan(0);
    expect(walkedBothWays(built, OUTSIDE, top), sketch(built)).toBe(top.length);
  });

  it.each([2, 3])("is climbed to a walkway %i levels up by a flight a level", (height) => {
    const built = buildTree(
      land(SIZE, [ring({ height, gates: [SOUTH_GATE], stairs: [{ x: 8, y: 4 }] })]),
    );
    const top = walkway(built, height);
    expect(top.length).toBeGreaterThan(0);
    expect(walkedBothWays(built, OUTSIDE, top), sketch(built)).toBe(top.length);
  });

  it("stands its battlements on the outer face only, so two cells of thickness leave a walkway", () => {
    const built = buildTree(land(SIZE, [ring({ thickness: 2, stairs: [{ x: 8, y: 4 }] })]));
    const top = walkway(built, 1);
    expect(top.length).toBeGreaterThan(0);
    expect(walkedBothWays(built, COURTYARD, top), sketch(built)).toBe(top.length);
  });

  it("stands on a hill as it does on flat ground", () => {
    const built = buildTree(
      land(SIZE, [
        node("hill", { levels: 1, roughness: 0 }, { frame: frame(0, 0, 40, 30) }),
        ring({ gates: [SOUTH_GATE], stairs: [{ x: 8, y: 4 }] }, frame(12, 9, 16, 12)),
      ]),
    );
    const top = walkway(built, 2);
    expect(top.length).toBeGreaterThan(0);
    expect(walkedBothWays(built, COURTYARD, top), sketch(built)).toBe(top.length);
  });
});

describe("an open castle wall", () => {
  const line = (props: Record<string, unknown> = {}) =>
    node("wall", { from: { x: 6, y: 14 }, to: { x: 33, y: 14 }, ...props });
  const NORTH = { x: 20, y: 6 };
  const SOUTH = { x: 20, y: 24 };

  it("is walked round at its ends and through its gate", () => {
    const built = buildTree(land(SIZE, [line({ gates: [{ x: 20, y: 14 }] })]));
    expect(reach(built, NORTH).has(cellKey({ x: 20, y: 14, z: 0 })), sketch(built)).toBe(true);
    expect(walks(built, NORTH, SOUTH)).toBe(true);
  });

  it("has battlements on both faces and a walkway between them, three cells thick", () => {
    const built = buildTree(land(SIZE, [line({ stairs: [{ x: 14, y: 17 }] })]));
    const top = walkway(built, 1);
    expect(top.filter((cell) => cell.y === 14).length).toBe(28);
    expect(top.filter((cell) => cell.y === 13)).toEqual([]);
    expect(walkedBothWays(built, SOUTH, top), sketch(built)).toBe(top.length);
  });

  it("is all battlement when it is one cell thick", () => {
    const built = buildTree(land(SIZE, [line({ thickness: 1 })]));
    expect(walkway(built, 1)).toEqual([]);
    expect(getStack(built.map, 20, 14, 1).length).toBeGreaterThan(1);
  });
});

describe("a castle wall that cannot be built", () => {
  const refused = (
    wall: ReturnType<typeof ring>,
    before: ReturnType<typeof node>[] = [],
    ground?: string,
  ) =>
    buildTree(land(SIZE, [...before, wall], ground), { problems: "returned" }).problems.map(
      (p) => p.reason,
    );

  it("refuses a gate on a corner", () => {
    expect(refused(ring({ gates: [{ x: 1, y: 1 }] }))[0]).toMatch(/straight stretch/);
  });

  it("refuses a road that meets it on a corner", () => {
    const road = node("road", { from: { x: 2, y: 2 }, to: { x: 12, y: 10 } });
    expect(refused(ring(), [road])[0]).toMatch(/A road meets this wall/);
  });

  it("refuses stairs with nowhere to stand", () => {
    expect(refused(ring({ stairs: [{ x: 8, y: 4 }] }), [], "water")[0]).toMatch(
      /no room for stairs/,
    );
  });

  it("refuses ground on more than one level", () => {
    const hill = node("hill", { levels: 1, roughness: 0 }, { frame: frame(16, 2, 22, 26) });
    expect(refused(ring(), [hill])[0]).toMatch(/more than one level/);
  });
});
