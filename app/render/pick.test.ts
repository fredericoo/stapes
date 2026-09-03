import { describe, expect, it } from "vitest";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { ObjectRef } from "../game/GameSession";
import type { MapFile, TileDef } from "../lib/types";
import { CELL_SIZE, coordKey, normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import {
  footRect,
  pickBattlerAt,
  pickInteractiveAt,
  pickTileAt,
} from "./pick";

/**
 * Picking is by the tile's foot, not by its art.
 *
 * The fixture leans on that: every tile here is drawn four cells square with its
 * base in the *far* corner, so the sprite sprawls across a wide region of ground
 * it does not stand on. Under the old sprite-quad pick that made these tiles
 * enormous targets that swallowed everything behind them; under a foot pick the
 * art is simply irrelevant, and these tests say so by never mentioning it.
 */
const SPRAWLING_SPRITE_CELLS = 4;

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
            rect: {
              x: 0,
              y: 0,
              w: SPRAWLING_SPRITE_CELLS,
              h: SPRAWLING_SPRITE_CELLS,
            },
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

const tilesById = tilesByIdFromList([
  tile({ id: "grass", height: 0 }),
  tile({ id: "slab", height: 2 }),
  tile({
    id: "crate",
    height: 2,
    interactions: {
      push: { climb: "half", moveOnTileIds: [] },
    },
  }),
  tile({
    id: "door-closed",
    height: 2,
    interactions: { switch: { targetTileId: "door-open" } },
  }),
  tile({
    id: "ladder",
    height: 2,
    intangible: true,
    interactions: {
      teleport: {
        actionName: "Climb up",
        trigger: "interactOver",
        destination: { kind: "relative", delta: { x: 0, y: 0, z: 1 } },
      },
    },
  }),
  tile({
    id: "coin",
    height: 0,
    kind: "item",
    interactions: { item: { type: "artifact" } },
  }),
  tile({
    id: "cat",
    height: 2,
    kind: "battler",
    interactions: {
      battler: {
        masteries: { toughness: 10 },
        naturalWeapon: {
          type: "weapon",
          damage: 1,
          def: 0,
          accuracy: 50,
          variance: 0,
          spd: 0,
          mastery: "fist",
        },
      },
    },
  }),
]);

/** Camera at the origin and zoom 1, so screen coords are world coords. */
function ctx(map: MapFile) {
  return { map, tilesById, camera: { x: 0, y: 0 }, zoom: 1 };
}

/** The middle of a cell's ground square — where a player points to mean "that". */
function onFoot(ref: { x: number; y: number; z: number }) {
  const foot = footRect(ref.x, ref.y, ref.z);
  return { x: foot.x + foot.w / 2, y: foot.y + foot.h / 2 };
}

describe("pickInteractiveAt", () => {
  /** Two crates in neighbouring cells; (1,0) is drawn in front of (0,0). */
  function twoCrates(): MapFile {
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "crate" },
    ]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "crate" }]);
    return map;
  }

  const behind: ObjectRef = { x: 0, y: 0, z: 0, stackIndex: 1 };
  const inFront: ObjectRef = { x: 1, y: 0, z: 0, stackIndex: 1 };
  const sameRef = (a: ObjectRef) => (b: ObjectRef) =>
    a.x === b.x && a.y === b.y && a.z === b.z && a.stackIndex === b.stackIndex;

  /**
   * The headline of the whole change.
   *
   * These two crates have sprites four cells square, so under a sprite-quad pick
   * the front one covered the back one entirely and the back one could not be
   * hit from anywhere at all. Each now answers only over its own cell.
   */
  it("gives every tile its own cell, whatever the art does", () => {
    const map = twoCrates();

    for (const ref of [behind, inFront]) {
      const p = onFoot(ref);
      expect(pickInteractiveAt(ctx(map), p.x, p.y, 0, 0)).toEqual(ref);
    }
  });

  it("finds nothing on a cell with nothing standing on it", () => {
    const map = twoCrates();
    const p = onFoot({ x: 5, y: 5, z: 0 });
    expect(pickInteractiveAt(ctx(map), p.x, p.y, 0, 0)).toBeNull();
  });

  it("finds nothing where the interactive thing is buried under another tile", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "crate" },
      { tileId: "slab" },
    ]);
    const p = onFoot({ x: 0, y: 0, z: 0 });
    expect(pickInteractiveAt(ctx(map), p.x, p.y, 0, 0)).toBeNull();
  });

  /**
   * The gesture you can only make from on top of the thing — a ladder.
   *
   * Standing on it puts your body above it in the stack, which is exactly the
   * arrangement `interactOver` describes, so a pick that stopped at the topmost
   * placement could never offer the one interaction the tile has.
   */
  it("reaches under the body standing on it", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "ladder" },
      { tileId: "cat", owner: "player-1" },
    ]);
    const p = onFoot({ x: 0, y: 0, z: 0 });
    expect(pickInteractiveAt(ctx(map), p.x, p.y, 0, 0)).toEqual({
      x: 0,
      y: 0,
      z: 0,
      stackIndex: 1,
    });
  });

  /**
   * Your own body is an interactive tile — the player tile is pushable — so
   * without the actionable rank it would sit on the rung and hide it.
   */
  it("passes over the body when the body has nothing to offer", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "ladder" },
      { tileId: "crate", owner: "player-1" },
    ]);
    const ladder: ObjectRef = { x: 0, y: 0, z: 0, stackIndex: 1 };
    const p = onFoot(ladder);

    expect(pickInteractiveAt(ctx(map), p.x, p.y, 0, 0, sameRef(ladder))).toEqual(
      ladder,
    );
  });

  /** Flat things are not cover either — the same rule pick-up already takes. */
  it("reaches under something lying flat on it", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "door-closed" },
      { tileId: "coin" },
    ]);
    const door: ObjectRef = { x: 0, y: 0, z: 0, stackIndex: 1 };
    const coin: ObjectRef = { x: 0, y: 0, z: 0, stackIndex: 2 };
    const p = onFoot(door);

    // Both are pickable, so the one on top answers — until only the door has a
    // row, and then the coin is no more of an obstacle than the floor is.
    expect(pickInteractiveAt(ctx(map), p.x, p.y, 0, 0)).toEqual(coin);
    expect(pickInteractiveAt(ctx(map), p.x, p.y, 0, 0, sameRef(door))).toEqual(
      door,
    );
  });

  it("still refuses what a body is standing on under a crate", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "ladder" },
      { tileId: "slab" },
      { tileId: "cat", owner: "player-1" },
    ]);
    const p = onFoot({ x: 0, y: 0, z: 0 });
    expect(pickInteractiveAt(ctx(map), p.x, p.y, 0, 0)).toBeNull();
  });

  it("finds a switch-only tile", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "door-closed" },
    ]);
    const p = onFoot({ x: 0, y: 0, z: 0 });
    expect(pickInteractiveAt(ctx(map), p.x, p.y, 0, 0)).toEqual({
      x: 0,
      y: 0,
      z: 0,
      stackIndex: 1,
    });
  });

  it("ignores a tile that offers nothing to do", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    const p = onFoot({ x: 0, y: 0, z: 0 });
    expect(pickInteractiveAt(ctx(map), p.x, p.y, 0, 0)).toBeNull();
  });

  describe("across levels", () => {
    /** One crate per level, each on its own cell so no two feet overlap. */
    function crateOnEachLevel(): MapFile {
      let map = replaceStack(emptyMap(), 0, 0, 0, [
        { tileId: "grass" },
        { tileId: "crate" },
      ]);
      map = replaceStack(map, 5, 0, 1, [
        { tileId: "grass" },
        { tileId: "crate" },
      ]);
      map = replaceStack(map, 9, 0, 2, [
        { tileId: "grass" },
        { tileId: "crate" },
      ]);
      return map;
    }

    it("reaches the floor above and below when levelSlack is 1", () => {
      const map = crateOnEachLevel();
      const p = onFoot({ x: 5, y: 0, z: 1 });
      expect(pickInteractiveAt(ctx(map), p.x, p.y, 0, 1)).toEqual({
        x: 5,
        y: 0,
        z: 1,
        stackIndex: 1,
      });
    });

    it("does not reach a floor further away than the slack allows", () => {
      const map = crateOnEachLevel();
      const p = onFoot({ x: 9, y: 0, z: 2 });
      expect(pickInteractiveAt(ctx(map), p.x, p.y, 0, 1)).toBeNull();
    });
  });

  /**
   * Feet on different levels still overlap on screen — a floor above projects
   * onto the one below — so the ranking that resolves them has to survive.
   */
  describe("when two feet land on the same point", () => {
    /**
     * A crate one level up sits exactly over the one below: a level is
     * `CELL_SIZE` up-left, so (1,1,1) and (0,0,0) share a foot square.
     */
    function stackedLevels(): MapFile {
      let map = replaceStack(emptyMap(), 0, 0, 0, [
        { tileId: "grass" },
        { tileId: "crate" },
      ]);
      map = replaceStack(map, 1, 1, 1, [
        { tileId: "grass" },
        { tileId: "crate" },
      ]);
      return map;
    }

    const lower: ObjectRef = { x: 0, y: 0, z: 0, stackIndex: 1 };
    const upper: ObjectRef = { x: 1, y: 1, z: 1, stackIndex: 1 };

    function sharedPoint(): { x: number; y: number } {
      const a = footRect(lower.x, lower.y, lower.z);
      const b = footRect(upper.x, upper.y, upper.z);
      expect(a).toEqual(b);
      return { x: a.x + CELL_SIZE / 2, y: a.y + CELL_SIZE / 2 };
    }

    it("takes the frontmost when nothing is actionable", () => {
      const map = stackedLevels();
      const p = sharedPoint();
      expect(pickInteractiveAt(ctx(map), p.x, p.y, 0, 1)).toEqual(upper);
    });

    it("reaches past an inert one to the one that can be acted on", () => {
      const map = stackedLevels();
      const p = sharedPoint();
      expect(
        pickInteractiveAt(ctx(map), p.x, p.y, 0, 1, sameRef(lower)),
      ).toEqual(lower);
    });

    it("still prefers the frontmost when both can be acted on", () => {
      const map = stackedLevels();
      const p = sharedPoint();
      expect(pickInteractiveAt(ctx(map), p.x, p.y, 0, 1, () => true)).toEqual(
        upper,
      );
    });
  });
});

describe("pickBattlerAt", () => {
  it("finds a body with hit points", () => {
    const map = replaceStack(emptyMap(), 2, 2, 0, [
      { tileId: "grass" },
      { tileId: "cat" },
    ]);
    const p = onFoot({ x: 2, y: 2, z: 0 });
    expect(pickBattlerAt(ctx(map), p.x, p.y, 0, 1)).toEqual({
      x: 2,
      y: 2,
      z: 0,
      stackIndex: 1,
    });
  });

  it("passes over a thing you can act on but cannot fight", () => {
    const map = replaceStack(emptyMap(), 2, 2, 0, [
      { tileId: "grass" },
      { tileId: "crate" },
    ]);
    const p = onFoot({ x: 2, y: 2, z: 0 });
    expect(pickBattlerAt(ctx(map), p.x, p.y, 0, 1)).toBeNull();
  });
});

describe("pickTileAt", () => {
  it("finds a plain, inert tile — the whole point of looking", () => {
    const map = replaceStack(emptyMap(), 3, 4, 0, [{ tileId: "grass" }]);
    const ref: ObjectRef = { x: 3, y: 4, z: 0, stackIndex: 0 };
    const p = onFoot(ref);

    expect(pickTileAt(ctx(map), p.x, p.y, 0, 1)).toEqual(ref);
  });

  it("names the top of the stack, never what is buried under it", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "crate" },
    ]);
    const top: ObjectRef = { x: 0, y: 0, z: 0, stackIndex: 1 };
    const p = onFoot(top);

    expect(pickTileAt(ctx(map), p.x, p.y, 0, 1)).toEqual(top);
  });

  /**
   * The hole that measuring at each tile's own elevation used to leave.
   *
   * A crate on a slab is drawn one unit up, so a square taken at *its* elevation
   * sits four pixels up-left of the ground — and the strip it vacates belonged to
   * nobody, because the tile that would have claimed it is the one that moved.
   * On screen that was a half-cell dead band below and right of anything raised.
   * Taking the square at the ground instead leaves the whole cell live.
   */
  it("answers everywhere on the cell, however high the stack is", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "slab" },
      { tileId: "crate" },
    ]);
    const crate: ObjectRef = { x: 0, y: 0, z: 0, stackIndex: 1 };
    const foot = footRect(0, 0, 0);

    // Every corner and the middle, inset by a pixel to stay off the boundary.
    for (const [px, py] of [
      [foot.x + 1, foot.y + 1],
      [foot.x + foot.w - 1, foot.y + 1],
      [foot.x + 1, foot.y + foot.h - 1],
      [foot.x + foot.w - 1, foot.y + foot.h - 1],
      [foot.x + foot.w / 2, foot.y + foot.h / 2],
    ]) {
      expect(pickTileAt(ctx(map), px!, py!, 0, 1)).toEqual(crate);
    }
  });

  /**
   * Ground squares tile the plane, so a sweep across a row of cells must never
   * come back empty — a gap anywhere is a place the pointer falls through.
   */
  it("leaves no dead pixels between neighbouring cells", () => {
    let map = emptyMap();
    for (let x = 0; x < 4; x++) {
      map = replaceStack(map, x, 0, 0, [{ tileId: "slab" }, { tileId: "crate" }]);
    }
    const start = footRect(0, 0, 0);
    const y = start.y + CELL_SIZE / 2;

    for (let px = start.x; px < start.x + CELL_SIZE * 4; px++) {
      expect(pickTileAt(ctx(map), px, y, 0, 1)).not.toBeNull();
    }
  });

  it("names the body standing on a thing, not the thing", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "ladder" },
      { tileId: "cat", owner: "player-1" },
    ]);
    const p = onFoot({ x: 0, y: 0, z: 0 });
    expect(pickTileAt(ctx(map), p.x, p.y, 0, 1)).toEqual({
      x: 0,
      y: 0,
      z: 0,
      stackIndex: 2,
    });
  });

  it("takes the frontmost of two tiles whose feet coincide", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 1, 1, 1, [{ tileId: "grass" }]);

    const upper: ObjectRef = { x: 1, y: 1, z: 1, stackIndex: 0 };
    const p = onFoot(upper);

    expect(pickTileAt(ctx(map), p.x, p.y, 0, 1)).toEqual(upper);
  });

  it("reaches the floor above and below when the slack allows", () => {
    let map = replaceStack(emptyMap(), 0, 0, 1, [{ tileId: "grass" }]);
    map = replaceStack(map, 5, 5, -1, [{ tileId: "grass" }]);

    const above: ObjectRef = { x: 0, y: 0, z: 1, stackIndex: 0 };
    const below: ObjectRef = { x: 5, y: 5, z: -1, stackIndex: 0 };
    const pAbove = onFoot(above);
    const pBelow = onFoot(below);

    expect(pickTileAt(ctx(map), pAbove.x, pAbove.y, 0, 1)).toEqual(above);
    expect(pickTileAt(ctx(map), pBelow.x, pBelow.y, 0, 1)).toEqual(below);
    // With no slack neither floor is in reach, and there is nothing on the
    // viewer's own level to find instead.
    expect(pickTileAt(ctx(map), pAbove.x, pAbove.y, 0, 0)).toBeNull();
  });

  it("cannot name a level the roof-cut has taken away", () => {
    const map = replaceStack(emptyMap(), 0, 0, 1, [{ tileId: "grass" }]);
    const roof: ObjectRef = { x: 0, y: 0, z: 1, stackIndex: 0 };
    const p = onFoot(roof);

    // Drawn: looking up at a roof over your head reports "Roof", which is the
    // right answer. Cut away: it is not on screen, so it is not there to name.
    expect(pickTileAt(ctx(map), p.x, p.y, 0, 1)).toEqual(roof);
    expect(
      pickTileAt(ctx(map), p.x, p.y, 0, 1, {
        floor: 0,
        cells: new Map([[1, new Set([coordKey(0, 0)])]]),
      }),
    ).toBeNull();
  });

  it("still names a roof the cut did not take", () => {
    const map = replaceStack(emptyMap(), 0, 0, 1, [{ tileId: "grass" }]);
    const roof: ObjectRef = { x: 0, y: 0, z: 1, stackIndex: 0 };
    const p = onFoot(roof);

    // A cut over somebody else's building leaves this one on screen, and what is
    // on screen can be looked at.
    expect(
      pickTileAt(ctx(map), p.x, p.y, 0, 1, {
        floor: 0,
        cells: new Map([[1, new Set([coordKey(9, 9)])]]),
      }),
    ).toEqual(roof);
  });
});
