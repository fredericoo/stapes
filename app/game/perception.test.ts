import { describe, expect, it } from "vitest";
import { MELEE_REACH } from "../lib/item";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL } from "../lib/types";
import type { RoofCut } from "../lib/levelVisibility";
import { isHiddenFromCamera } from "../render/cameraSight";
import { canReach } from "./combat";
import { hasLineOfSight } from "./sight";
import { tile } from "../lib/testTile";

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "floor", height: 0, walkable: true }),
  tile({ id: "wall", height: HEIGHT_PER_LEVEL, walkable: false }),
  tile({ id: "box", height: 2, walkable: false }),
  tile({ id: "door", height: HEIGHT_PER_LEVEL, walkable: false }),
];

const tilesById = Object.fromEntries(tiles.map((t) => [t.id, t]));

function ground(z: number, half = 8): MapFile {
  let map = emptyMap();
  for (let x = -half; x <= half; x++) {
    for (let y = -half; y <= half; y++) {
      map = replaceStack(map, x, y, z, [{ tileId: "grass" }]);
    }
  }
  return map;
}

function put(map: MapFile, x: number, y: number, z: number, ...tileIds: string[]): MapFile {
  return replaceStack(
    map,
    x,
    y,
    z,
    tileIds.map((tileId) => ({ tileId })),
  );
}

type Body = { x: number; y: number; z: number; elevAbs: number };

function on(x: number, y: number, z: number, standingOn = 0): Body {
  return { x, y, z, elevAbs: z * HEIGHT_PER_LEVEL + standingOn };
}

function canRead(map: MapFile, body: Body, viewer: Body, roofCut?: RoofCut): boolean {
  return !isHiddenFromCamera(map, tilesById, body, viewer.z, roofCut);
}

function canHit(map: MapFile, from: Body, to: Body): boolean {
  return canReach(map, tilesById, from, to, MELEE_REACH);
}

function notices(map: MapFile, self: Body, target: Body, sight = { up: 0, down: 0 }): boolean {
  const dz = target.z - self.z;
  if (dz > sight.up || -dz > sight.down) return false;
  return hasLineOfSight(map, tilesById, self, target);
}

describe("1 — indoors, door shut, rat in the yard", () => {
  function board(): MapFile {
    let map = ground(0);
    for (let y = -2; y <= 2; y++) map = put(map, 1, y, 0, "grass", "wall");
    return put(map, 1, 0, 0, "grass", "door");
  }

  const me = on(0, 0, 0);
  const rat = on(3, 0, 0);

  it("reads the rat's name and health through the wall", () => {
    expect(canRead(board(), rat, me)).toBe(true);
  });

  it("but the rat cannot see me", () => {
    expect(notices(board(), rat, me)).toBe(false);
  });

  it("and neither of us can land a blow", () => {
    expect(canHit(board(), me, rat)).toBe(false);
    expect(canHit(board(), rat, me)).toBe(false);
  });

  it("disagrees on purpose about who can see what", () => {
    expect(canRead(board(), rat, me)).not.toBe(notices(board(), rat, me));
  });
});

describe("2 — up on a box, nothing in between", () => {
  const board = () => put(ground(0), 1, 0, 0, "grass", "box");

  const me = on(1, 0, 0, 1);
  const rat = on(2, 0, 0);

  it("lets the rat see me", () => {
    expect(notices(board(), rat, me)).toBe(true);
  });

  it("lets it reach me, half a level up", () => {
    expect(canHit(board(), rat, me)).toBe(true);
    expect(canHit(board(), me, rat)).toBe(true);
  });

  it("would not reach me a whole level up", () => {
    const upstairs = on(1, 0, 0, HEIGHT_PER_LEVEL);
    expect(canHit(board(), rat, upstairs)).toBe(false);
  });
});

describe("3 — ringed by boxes, rat outside the ring", () => {
  function board(): MapFile {
    let map = ground(0);
    for (let x = -1; x <= 1; x++) {
      for (let y = -1; y <= 1; y++) {
        if (x === 0 && y === 0) continue;
        map = put(map, x, y, 0, "grass", "box");
      }
    }
    return map;
  }

  const me = on(0, 0, 0);
  const rat = on(3, 0, 0);

  it("still shows the rat's name and health", () => {
    expect(canRead(board(), rat, me)).toBe(true);
  });

  it("still lets it see me over the boxes", () => {
    expect(notices(board(), rat, me)).toBe(true);
  });

  it("but leaves it out of reach from outside", () => {
    expect(canHit(board(), rat, me)).toBe(false);
  });

  it("would blind it if the ring were full height", () => {
    let walled = ground(0);
    for (let x = -1; x <= 1; x++) {
      for (let y = -1; y <= 1; y++) {
        if (x === 0 && y === 0) continue;
        walled = put(walled, x, y, 0, "grass", "wall");
      }
    }
    expect(notices(walled, rat, me)).toBe(false);
  });
});

describe("4 — me on a platform, rat on the ground below", () => {
  function board(): MapFile {
    let map = ground(0);
    for (let x = -2; x <= 0; x++) {
      for (let y = -2; y <= 2; y++) map = put(map, x, y, 1, "floor");
    }
    return map;
  }

  const me = on(0, 0, 1);
  const rat = on(3, 0, 0);

  it("shows me its health", () => {
    expect(canRead(board(), rat, me)).toBe(true);
  });

  it("keeps it out of reach", () => {
    expect(canHit(board(), me, rat)).toBe(false);
  });

  it("leaves the rat oblivious, though the air between us is clear", () => {
    expect(hasLineOfSight(board(), tilesById, rat, me)).toBe(true);
    expect(notices(board(), rat, me)).toBe(false);
  });

  it("and lets something authored to look up notice me", () => {
    expect(notices(board(), rat, me, { up: 2, down: 2 })).toBe(true);
  });

  it("but not through a floor, however far it looks", () => {
    const roofed = put(board(), 3, 0, 1, "floor");
    const under = on(3, 0, 0);
    const above = on(4, 1, 1);
    expect(notices(roofed, under, above, { up: 2, down: 2 })).toBe(false);
  });
});

describe("5 — me at ground level, rat in a cave below", () => {
  function board(): MapFile {
    let map = ground(-1);
    for (let x = -3; x <= 3; x++) {
      for (let y = -3; y <= 3; y++) {
        if (x === 3 && y === 3) continue;
        map = put(map, x, y, 0, "floor");
      }
    }
    return map;
  }

  const me = on(0, 0, 0);
  const rat = on(0, 0, -1);

  it("hides its name and health", () => {
    expect(canRead(board(), rat, me)).toBe(false);
  });

  it("keeps it from seeing me through the rock", () => {
    expect(notices(board(), rat, me, { up: 2, down: 2 })).toBe(false);
  });

  it("keeps it unhittable, though it is a cell under my feet", () => {
    expect(canHit(board(), me, rat)).toBe(false);
  });

  it("reads a body standing under the hole, and only that one", () => {
    expect(canRead(board(), on(3, 3, -1), me)).toBe(true);
    expect(canRead(board(), on(1, 2, -1), me)).toBe(false);
  });

  it("stays quiet about a body under solid roof beside the hole", () => {
    const beside = on(2, 2, -1);
    expect(canRead(board(), beside, me)).toBe(false);
    expect(isHiddenFromCamera(board(), tilesById, beside, beside.z, undefined)).toBe(false);
  });
});

describe("6 — a deer directly beneath the floor I am standing on", () => {
  function board(): MapFile {
    return put(ground(-1), 0, 0, 0, "floor");
  }

  const me = on(0, 0, 0);
  const deer = on(0, 0, -1);

  it("does not name or measure it", () => {
    expect(canRead(board(), deer, me)).toBe(false);
  });

  it("and the diagonal alone would have missed it", () => {
    expect(isHiddenFromCamera(board(), tilesById, deer, deer.z, undefined)).toBe(false);
  });

  it("keeps it unhittable through the floor", () => {
    expect(canHit(board(), me, deer)).toBe(false);
  });

  it("and stops it noticing me", () => {
    expect(notices(board(), deer, me, { up: 2, down: 2 })).toBe(false);
  });

  it("shows the deer again from beside the hole", () => {
    expect(canRead(board(), on(1, 0, -1), me)).toBe(true);
  });
});
