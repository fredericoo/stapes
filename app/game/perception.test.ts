import { describe, expect, it } from "vitest";
import { MELEE_REACH } from "../lib/item";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL, normalizeTileDef } from "../lib/types";
import type { RoofCut } from "../lib/levelVisibility";
import { isHiddenFromCamera } from "../render/cameraSight";
import { canReach } from "./combat";
import { levelElevation } from "./distance";
import { hasLineOfSight } from "./sight";

/**
 * The scenarios, as a spec.
 *
 * Perception in this game is **three separate questions**, and every bug worth
 * having had here came from answering them with one rule:
 *
 * - **A — can I read its name and health?** A question about the *camera*. The
 *   sprite is on screen and nothing is drawn over it. Where the viewer is
 *   standing does not enter into it.
 * - **B — can I hit it?** A question about *reach*: inside the sphere, with a
 *   clear line.
 * - **C — does it notice me?** A question about *the creature*: its own floors
 *   of interest, and a clear line from its eye.
 *
 * They are meant to disagree. Reading a rat's health through a doorway it cannot
 * see you through is the normal state of affairs, and every case below pins at
 * least one disagreement. Each `describe` is one scenario from the design, with
 * the board written out so the case can be read without running it.
 */

const frame = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

function tile(
  partial: Record<string, unknown> & Pick<TileDef, "id" | "height">,
): TileDef {
  return normalizeTileDef({
    name: partial.id,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    ...partial,
  });
}

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  /** Height zero and solid: a floor, a ceiling, a platform surface. */
  tile({ id: "floor", height: 0, walkable: true }),
  /** A full level of solid. Stops a look sideways. */
  tile({ id: "wall", height: HEIGHT_PER_LEVEL, walkable: false }),
  /** Half a level. Stands in the way of feet and not of eyes. */
  tile({ id: "box", height: 2, walkable: false }),
  tile({ id: "door", height: HEIGHT_PER_LEVEL, walkable: false }),
];

const tilesById = Object.fromEntries(tiles.map((t) => [t.id, t]));

/** Open ground on one level. */
function ground(z: number, half = 8): MapFile {
  let map = emptyMap();
  for (let x = -half; x <= half; x++) {
    for (let y = -half; y <= half; y++) {
      map = replaceStack(map, x, y, z, [{ tileId: "grass" }]);
    }
  }
  return map;
}

function put(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  ...tileIds: string[]
): MapFile {
  return replaceStack(
    map,
    x,
    y,
    z,
    tileIds.map((tileId) => ({ tileId })),
  );
}

/**
 * A body: where it stands on the plan, and how high its feet are.
 *
 * Elevation is carried rather than derived because that is the distinction the
 * whole reach rule turns on — standing on a box is the same cell and the same
 * floor, and a different answer.
 */
type Body = { x: number; y: number; z: number; elevAbs: number };

function on(x: number, y: number, z: number, standingOn = 0): Body {
  return { x, y, z, elevAbs: levelElevation(z) + standingOn };
}

/** A — is its name and health readable? @see isHiddenFromCamera */
function canRead(
  map: MapFile,
  body: Body,
  viewer: Body,
  roofCut?: RoofCut,
): boolean {
  return !isHiddenFromCamera(map, tilesById, body, viewer.z, roofCut);
}

/** B — can `from` land a blow on `to`? */
function canHit(map: MapFile, from: Body, to: Body): boolean {
  return canReach(map, tilesById, from, to, MELEE_REACH);
}

/**
 * C — does a creature with these floors of interest notice the target?
 *
 * Both halves, in the order the runtime asks them: would it look that far up or
 * down at all, and is anything in the way.
 */
function notices(
  map: MapFile,
  self: Body,
  target: Body,
  sight = { up: 0, down: 0 },
): boolean {
  const dz = target.z - self.z;
  if (dz > sight.up || -dz > sight.down) return false;
  return hasLineOfSight(map, tilesById, self, target);
}

describe("1 — indoors, door shut, rat in the yard", () => {
  /**
   * A wall on x=1 with a shut door in it, me at the origin inside, the rat two
   * cells out. The rat is on open ground, so nothing is drawn over it.
   */
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

  /**
   * The disagreement is the point, and it is one-directional: what I can *read*
   * owes nothing to what stands between us, and what the rat can *see* owes
   * everything to it.
   */
  it("disagrees on purpose about who can see what", () => {
    expect(canRead(board(), rat, me)).not.toBe(notices(board(), rat, me));
  });
});

describe("2 — up on a box, nothing in between", () => {
  const board = () => put(ground(0), 1, 0, 0, "grass", "box");

  const me = on(1, 0, 0, 1); // feet half a level up, on the box
  const rat = on(2, 0, 0);

  it("lets the rat see me", () => {
    expect(notices(board(), rat, me)).toBe(true);
  });

  it("lets it reach me, half a level up", () => {
    expect(canHit(board(), rat, me)).toBe(true);
    expect(canHit(board(), me, rat)).toBe(true);
  });

  /** Half a level is exactly what the melee sphere was sized to include. */
  it("would not reach me a whole level up", () => {
    const upstairs = on(1, 0, 0, HEIGHT_PER_LEVEL);
    expect(canHit(board(), rat, upstairs)).toBe(false);
  });
});

describe("3 — ringed by boxes, rat outside the ring", () => {
  /** Half-height boxes all round me: in the way of feet, not of eyes. */
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

  /**
   * And it still cannot touch me from outside the ring — which is what leaves it
   * pressing at the boxes. That it *jitters* rather than giving up is a
   * behaviour question for the brain, not a reach question.
   */
  it("but leaves it out of reach from outside", () => {
    expect(canHit(board(), rat, me)).toBe(false);
  });

  /** A full-height ring would take its sight too. That is the contrast. */
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
  /** A platform at z=1 over the left half, me on it, rat out on open ground. */
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

  /**
   * **The rule that is about the creature and not the world.** Nothing is in the
   * way — it is standing in the open looking at a ledge — so geometry alone
   * would have it notice me. A rat is authored not to look up.
   */
  it("leaves the rat oblivious, though the air between us is clear", () => {
    expect(hasLineOfSight(board(), tilesById, rat, me)).toBe(true);
    expect(notices(board(), rat, me)).toBe(false);
  });

  it("and lets something authored to look up notice me", () => {
    expect(notices(board(), rat, me, { up: 2, down: 2 })).toBe(true);
  });

  /**
   * A hawk indoors still sees nothing through a ceiling: both halves apply.
   *
   * The roof goes over the *hawk*, which is what "indoors" means and what the
   * vertical rule reads — the ground over whichever end is lower. It used to be
   * laid over the far cell instead and this passed anyway, because a climbing
   * look was being stopped by the slab its own target was standing on. That is
   * a body on a ledge, in the open, one cell away: plainly visible.
   */
  it("but not through a floor, however far it looks", () => {
    const roofed = put(board(), 3, 0, 1, "floor");
    const under = on(3, 0, 0);
    const above = on(4, 1, 1);
    expect(notices(roofed, under, above, { up: 2, down: 2 })).toBe(false);
  });
});

describe("5 — me at ground level, rat in a cave below", () => {
  /**
   * A sealed cave at z=-1 with one hole in its ceiling, far from the rat. The
   * hole is what makes this a test of the ray rather than of the roof.
   */
  function board(): MapFile {
    let map = ground(-1);
    for (let x = -3; x <= 3; x++) {
      for (let y = -3; y <= 3; y++) {
        if (x === 3 && y === 3) continue; // the hole
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
    // Close enough by every measure — and through a floor, which is the case
    // range alone gets wrong.
    expect(canHit(board(), me, rat)).toBe(false);
  });

  /** A body standing under the hole is read; the roof is identical elsewhere. */
  it("reads a body standing under the hole, and only that one", () => {
    expect(canRead(board(), on(3, 3, -1), me)).toBe(true);
    expect(canRead(board(), on(1, 2, -1), me)).toBe(false);
  });

  /**
   * **Being under the roof beats being screen-aligned with the hole.** A body at
   * (2,2,-1) is drawn at the same pixel as the gap at (3,3,0), so its sprite is
   * genuinely on screen — and it is still not named, because there is a floor
   * between the viewer's level and it.
   *
   * That is a decision rather than a fallout, and it is the one that makes the
   * rule sayable: *if there is a floor between you and it, you get no readout*.
   * The alternative — read anything whose pixels survive — is the rule that let
   * a deer be targeted through the boards somebody was standing on.
   */
  it("stays quiet about a body under solid roof beside the hole", () => {
    const beside = on(2, 2, -1);
    expect(canRead(board(), beside, me)).toBe(false);
    // Its pixels are not covered; only the roof over it hides it.
    expect(
      isHiddenFromCamera(board(), tilesById, beside, beside.z, undefined),
    ).toBe(false);
  });
});

describe("6 — a deer directly beneath the floor I am standing on", () => {
  /**
   * The narrowest possible roof: one floor tile, with open sky either side of
   * it. Nothing but that tile stands between the two bodies.
   *
   * This is the case the screen-occlusion rule alone gets wrong, and the reason
   * the column test exists beside it — see {@link isHiddenFromCamera}. The floor
   * overhead is drawn one cell up-left of the deer, so it is not on the diagonal
   * the camera ray walks, and the deer's feet really are still painted. A wide
   * ceiling hides its own diagonal by accident and made the gap invisible; one
   * tile does not.
   */
  function board(): MapFile {
    return put(ground(-1), 0, 0, 0, "floor");
  }

  const me = on(0, 0, 0);
  const deer = on(0, 0, -1);

  it("does not name or measure it", () => {
    expect(canRead(board(), deer, me)).toBe(false);
  });

  it("and the diagonal alone would have missed it", () => {
    // Nothing on the screen ray from the deer: proof the column is load-bearing
    // rather than a second way of saying the same thing.
    expect(isHiddenFromCamera(board(), tilesById, deer, deer.z, undefined)).toBe(
      false,
    );
  });

  it("keeps it unhittable through the floor", () => {
    expect(canHit(board(), me, deer)).toBe(false);
  });

  it("and stops it noticing me", () => {
    expect(notices(board(), deer, me, { up: 2, down: 2 })).toBe(false);
  });

  /** Step off the tile and the same deer is in plain view again. */
  it("shows the deer again from beside the hole", () => {
    expect(canRead(board(), on(1, 0, -1), me)).toBe(true);
  });
});
