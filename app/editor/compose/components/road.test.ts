import { describe, expect, it } from "vitest";
import { getStack } from "../../../lib/mapData";
import { buildTree, frame, isle, land, node, reach, sketch, stands, walks } from "../testTree";

const SIZE = { w: 48, h: 28 };
const WEST = { x: 11, y: 14 };
const EAST_BANK = { x: 20, y: 14 };
const SUMMIT = { x: 32, y: 14 };

describe("a road over a river and up a hill", () => {
  const crossing = (road: Record<string, unknown> | null, river: Record<string, unknown> = {}) =>
    buildTree(
      isle(SIZE, [
        node("river", { from: { x: 16, y: 0 }, to: { x: 16, y: 27 }, width: 3, ...river }),
        node("hill", { levels: 1, roughness: 0 }, { frame: frame(22, 5, 20, 18) }),
        ...(road ? [node("road", { from: WEST, to: SUMMIT, ...road })] : []),
      ]),
    );

  it("starts from an island nobody can cross with dry feet or climb", () => {
    const built = crossing(null);
    expect(walks(built, WEST, EAST_BANK), sketch(built)).toBe(false);
    expect(walks(built, EAST_BANK, SUMMIT), sketch(built)).toBe(false);
  });

  it.each([
    ["paved", { tile: "cobblestone" }],
    ["with no tile", { tile: null }],
  ])("is walked both ways over its bridge and ramp, %s", (_, road) => {
    const built = crossing(road);
    expect(walks(built, WEST, SUMMIT), sketch(built)).toBe(true);
    expect(walks(built, SUMMIT, WEST), sketch(built)).toBe(true);
  });

  it("stops at the bank of a river that is not bridged", () => {
    const built = crossing({ tile: "cobblestone" }, { bridged: false });
    expect(walks(built, WEST, EAST_BANK), sketch(built)).toBe(false);
    expect(walks(built, EAST_BANK, SUMMIT), sketch(built)).toBe(true);
  });
});

describe("a road that crosses a river at a slant", () => {
  const TALL = { w: 40, h: 40 };
  const FROM = { x: 6, y: 6 };
  const TO = { x: 30, y: 34 };
  const built = () =>
    buildTree(
      land(TALL, [
        node("river", { from: { x: 12, y: 0 }, to: { x: 24, y: 39 }, width: 3 }),
        node("road", { from: FROM, to: TO, wander: 0 }),
      ]),
    );

  it("bridges it once, from bank to bank, and walks round where it only dips into it", () => {
    const map = built();
    const deck = new Set<number>();
    for (let y = 0; y < TALL.h; y++) {
      for (let x = 0; x < TALL.w; x++) {
        if (getStack(map.map, x, y, 0).some((p) => p.tileId === "wooden-floor")) deck.add(y);
      }
    }
    expect(deck.size, sketch(map)).toBeGreaterThan(0);
    expect(deck.size, sketch(map)).toBeLessThanOrEqual(3);
    expect(walks(map, FROM, TO), sketch(map)).toBe(true);
  });
});

describe("a road over what no layer declared a crossing for", () => {
  const FIELD = { w: 30, h: 12 };
  const LEFT = { x: 3, y: 6 };
  const RIGHT = { x: 26, y: 6 };
  const across = (barrier: ReturnType<typeof node>, road: boolean) =>
    buildTree(land(FIELD, [barrier, ...(road ? [node("road", { from: LEFT, to: RIGHT })] : [])]));

  it.each([
    [
      "bridges a lake laid with a fill",
      () => node("fill", { tiles: ["water"], edge: [] }, { frame: frame(12, 0, 5, 12) }),
    ],
    [
      "fells the trees in its way",
      () =>
        node("fill", { tiles: ["tree"], edge: [], mode: "on top" }, { frame: frame(12, 0, 5, 12) }),
    ],
  ])("%s", (_, barrier) => {
    const blocked = across(barrier(), false);
    expect(walks(blocked, LEFT, RIGHT), sketch(blocked)).toBe(false);
    const built = across(barrier(), true);
    expect(walks(built, LEFT, RIGHT), sketch(built)).toBe(true);
  });
});

describe("a road up stacked hills", () => {
  const FIELD = { w: 60, h: 40 };
  const FOOT = { x: 3, y: 20 };
  const TOP = { x: 30, y: 20 };
  const stacked = (road: boolean) =>
    buildTree(
      land(FIELD, [
        node("hill", { levels: 1, roughness: 0 }, { frame: frame(8, 4, 44, 32) }),
        node("hill", { levels: 1, roughness: 0 }, { frame: frame(18, 10, 24, 20) }),
        ...(road ? [node("road", { from: FOOT, to: TOP })] : []),
      ]),
    );

  it("climbs a ramp for each tier, where neither tier is reached without it", () => {
    const bare = stacked(false);
    expect(bare.elevation.get(`${TOP.x},${TOP.y}`)).toBe(2);
    expect(walks(bare, FOOT, TOP), sketch(bare)).toBe(false);
    const built = stacked(true);
    expect(walks(built, FOOT, TOP), sketch(built)).toBe(true);
    expect(stands(built, "hill-cave-mouth"), sketch(built)).toEqual([]);
  });
});

describe("a long road", () => {
  const LONG = { w: 220, h: 80 };
  const ROW = 40;

  it.each([1, 2, 3, 4, 5])(
    "sweeps well off the straight line between its ends by default, seed %i",
    (seed) => {
      const built = buildTree(
        land(LONG, [
          node("road", { from: { x: 5, y: ROW }, to: { x: 214, y: ROW }, tile: "dirt" }),
        ]),
        { seed },
      );
      const off = stands(built, "dirt").map((c) => Math.abs(c.y - ROW));
      expect(Math.max(...off)).toBeGreaterThanOrEqual(10);
    },
  );
});

describe("a road along the top of a cliff", () => {
  it("leaves the brink bare, since a brink stands in for every cover on it", () => {
    const area = { w: 30, h: 20 };
    const built = buildTree(
      land(area, [
        node("hill", { levels: 1, terrace: 0, roughness: 0 }, { frame: frame(0, 0, 30, 20) }),
        node("road", { from: { x: 6, y: 5 }, to: { x: 24, y: 5 }, tile: "dirt", wander: 0 }),
      ]),
    );
    const onBrinks = [];
    const paved = [];
    for (let y = 0; y < area.h; y++) {
      for (let x = 0; x < area.w; x++) {
        const ids = getStack(built.map, x, y, 1).map((p) => p.tileId);
        if (ids.includes("dirt")) paved.push({ x, y });
        if (ids[0] === "grass-brink" && ids.includes("dirt")) onBrinks.push({ x, y });
      }
    }
    expect(paved.length, sketch(built)).toBeGreaterThan(0);
    expect(onBrinks, sketch(built)).toEqual([]);
  });
});

describe("a road through a hill too high to climb", () => {
  const FIELD = { w: 64, h: 32 };
  const WEST_FOOT = { x: 3, y: 16 };
  const EAST_FOOT = { x: 60, y: 16 };
  /** Taller than the field, so its sides run off the top and bottom and nobody walks round it. */
  const HILL = frame(14, -14, 36, 60);
  const across = (road: Record<string, unknown> | null, inside: ReturnType<typeof node>[] = []) =>
    buildTree(
      land(FIELD, [
        node("hill", { levels: 3, terrace: 0, roughness: 0 }, { frame: HILL }),
        ...inside,
        ...(road
          ? [node("road", { from: WEST_FOOT, to: EAST_FOOT, tile: "dirt", wander: 0, ...road })]
          : []),
      ]),
    );
  const dug = (built: ReturnType<typeof buildTree>) =>
    stands(built, "dirt").filter(
      (c) => c.z === 0 && (built.elevation.get(`${c.x},${c.y}`) ?? 0) > 0,
    );

  it("digs under it from a mouth on one side to a mouth on the other", () => {
    const bare = across(null);
    expect(walks(bare, WEST_FOOT, EAST_FOOT), sketch(bare)).toBe(false);
    const unjoined = across({ tunnels: false });
    expect(walks(unjoined, WEST_FOOT, EAST_FOOT), sketch(unjoined)).toBe(false);

    const built = across({});
    expect(walks(built, WEST_FOOT, EAST_FOOT), sketch(built)).toBe(true);
    expect(walks(built, EAST_FOOT, WEST_FOOT), sketch(built)).toBe(true);
    expect(stands(built, "hill-cave-mouth").length, sketch(built)).toBe(2);
    for (const mouth of stands(built, "hill-cave-mouth")) {
      const ids = getStack(built.map, mouth.x, mouth.y, mouth.z).map((p) => p.tileId);
      expect(ids.at(-2), `the road runs onto the mouth at ${mouth.x},${mouth.y}`).toBe("dirt");
    }
    for (const c of dug(built)) {
      expect(built.elevation.get(`${c.x},${c.y}`), `${c.x},${c.y} has rock over it`).toBe(3);
    }
  });

  it("goes round the foot of a hill it only clips the corner of", () => {
    const corner = buildTree(
      land(FIELD, [
        node("hill", { levels: 3, terrace: 0, roughness: 0 }, { frame: frame(14, 6, 36, 28) }),
        node("road", { from: { x: 3, y: 9 }, to: { x: 60, y: 9 }, tile: "dirt", wander: 0 }),
      ]),
    );
    expect(walks(corner, { x: 3, y: 9 }, { x: 60, y: 9 }), sketch(corner)).toBe(true);
    expect(stands(corner, "hill-cave-mouth"), sketch(corner)).toEqual([]);
  });

  it("runs through a dungeon dug in the hill, doors and all, and digs only to join it", () => {
    const crypt = () =>
      node(
        "dungeon",
        {},
        {
          frame: { ...frame(18, 6, 28, 20), z: 0 },
          children: [node("level", { shape: "crypt", door: "door-closed" })],
        },
      );
    const plain = across({});
    const built = across({}, [crypt()]);
    expect(walks(built, WEST_FOOT, EAST_FOOT), sketch(built)).toBe(true);
    expect(walks(built, EAST_FOOT, WEST_FOOT), sketch(built)).toBe(true);
    const walked = reach(built, WEST_FOOT);
    const halls = stands(built, "flagstone-floor").filter((c) => c.z === 0);
    expect(halls.some((c) => walked.has(`0:${c.x},${c.y}`))).toBe(true);
    expect(dug(built).length).toBeLessThan(dug(plain).length);
  });
});

describe("a road onto a shelf under a crag with a cave in it", () => {
  const FIELD = { w: 72, h: 36 };
  const WEST_FOOT = { x: 3, y: 18 };
  const EAST_FOOT = { x: 68, y: 18 };
  const across = (withCave: boolean) =>
    buildTree(
      land(FIELD, [
        node("hill", { levels: 1, terrace: 6, roughness: 0 }, { frame: frame(8, -14, 56, 64) }),
        node("hill", { levels: 3, terrace: 0, roughness: 0 }, { frame: frame(20, 3, 32, 30) }),
        ...(withCave
          ? [
              node(
                "cave",
                { mouths: [{ x: 0, y: 0, pinX: "center", pinY: "bottom" }] },
                { frame: { ...frame(23, 6, 26, 24), z: 1 } },
              ),
            ]
          : []),
        node("road", { from: WEST_FOOT, to: EAST_FOOT, tile: "dirt", wander: 0 }),
      ]),
    );
  const mouthsOn = (built: ReturnType<typeof buildTree>, z: number) =>
    stands(built, "hill-cave-mouth").filter((c) => c.z === z);

  it("ramps onto the shelf and runs through the cave, opening a mouth on each side", () => {
    const built = across(true);
    expect(walks(built, WEST_FOOT, EAST_FOOT), sketch(built)).toBe(true);
    expect(walks(built, EAST_FOOT, WEST_FOOT), sketch(built)).toBe(true);
    expect(mouthsOn(built, 1).length, sketch(built)).toBe(3);
  });

  it("goes round the crag on the shelf when there is no cave to join", () => {
    const built = across(false);
    expect(walks(built, WEST_FOOT, EAST_FOOT), sketch(built)).toBe(true);
    expect(mouthsOn(built, 1), sketch(built)).toEqual([]);
  });
});
