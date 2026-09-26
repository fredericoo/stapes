import { describe, expect, it } from "vitest";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { ObjectRef } from "../game/GameSession";
import type { MapFile, TileDef } from "../lib/types";
import { CELL_SIZE, coordKey, normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { footRect, pickBodyAt, pickInteractiveAt, pickTileAt } from "./pick";

const SPRAWLING_SPRITE_CELLS = 4;

function tile(partial: Record<string, unknown> & Pick<TileDef, "id" | "height">): TileDef {
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
        baseHp: 8,
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
  tile({
    id: "salesman",
    height: 4,
    kind: "prop",
    interactions: { dialog: { script: [{ kind: "say", text: "Hello." }] } },
  }),
]);

function ctx(map: MapFile) {
  return { map, tilesById, camera: { x: 0, y: 0 }, zoom: 1 };
}

function onFoot(ref: { x: number; y: number; z: number }) {
  const foot = footRect(ref.x, ref.y, ref.z);
  return { x: foot.x + foot.w / 2, y: foot.y + foot.h / 2 };
}

describe("pickInteractiveAt", () => {
  function twoCrates(): MapFile {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId: "crate" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "crate" }]);
    return map;
  }

  const behind: ObjectRef = { x: 0, y: 0, z: 0, stackIndex: 1 };
  const inFront: ObjectRef = { x: 1, y: 0, z: 0, stackIndex: 1 };
  const sameRef = (a: ObjectRef) => (b: ObjectRef) =>
    a.x === b.x && a.y === b.y && a.z === b.z && a.stackIndex === b.stackIndex;

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

  it("passes over the body when the body has nothing to offer", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "ladder" },
      { tileId: "crate", owner: "player-1" },
    ]);
    const ladder: ObjectRef = { x: 0, y: 0, z: 0, stackIndex: 1 };
    const p = onFoot(ladder);

    expect(pickInteractiveAt(ctx(map), p.x, p.y, 0, 0, sameRef(ladder))).toEqual(ladder);
  });

  it("reaches under something lying flat on it", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "door-closed" },
      { tileId: "coin" },
    ]);
    const door: ObjectRef = { x: 0, y: 0, z: 0, stackIndex: 1 };
    const coin: ObjectRef = { x: 0, y: 0, z: 0, stackIndex: 2 };
    const p = onFoot(door);

    expect(pickInteractiveAt(ctx(map), p.x, p.y, 0, 0)).toEqual(coin);
    expect(pickInteractiveAt(ctx(map), p.x, p.y, 0, 0, sameRef(door))).toEqual(door);
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
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId: "door-closed" }]);
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
    function crateOnEachLevel(): MapFile {
      let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId: "crate" }]);
      map = replaceStack(map, 5, 0, 1, [{ tileId: "grass" }, { tileId: "crate" }]);
      map = replaceStack(map, 9, 0, 2, [{ tileId: "grass" }, { tileId: "crate" }]);
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

  describe("when two feet land on the same point", () => {
    function stackedLevels(): MapFile {
      let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId: "crate" }]);
      map = replaceStack(map, 1, 1, 1, [{ tileId: "grass" }, { tileId: "crate" }]);
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
      expect(pickInteractiveAt(ctx(map), p.x, p.y, 0, 1, sameRef(lower))).toEqual(lower);
    });

    it("still prefers the frontmost when both can be acted on", () => {
      const map = stackedLevels();
      const p = sharedPoint();
      expect(pickInteractiveAt(ctx(map), p.x, p.y, 0, 1, () => true)).toEqual(upper);
    });
  });
});

describe("pickBodyAt", () => {
  it("finds a body with hit points", () => {
    const map = replaceStack(emptyMap(), 2, 2, 0, [{ tileId: "grass" }, { tileId: "cat" }]);
    const p = onFoot({ x: 2, y: 2, z: 0 });
    expect(pickBodyAt(ctx(map), p.x, p.y, 0, 1)).toEqual({
      x: 2,
      y: 2,
      z: 0,
      stackIndex: 1,
    });
  });

  it("finds a body with only a dialog", () => {
    const map = replaceStack(emptyMap(), 2, 2, 0, [{ tileId: "grass" }, { tileId: "salesman" }]);
    const p = onFoot({ x: 2, y: 2, z: 0 });
    expect(pickBodyAt(ctx(map), p.x, p.y, 0, 1)).toEqual({
      x: 2,
      y: 2,
      z: 0,
      stackIndex: 1,
    });
  });

  it("passes over a thing you can act on but cannot fight", () => {
    const map = replaceStack(emptyMap(), 2, 2, 0, [{ tileId: "grass" }, { tileId: "crate" }]);
    const p = onFoot({ x: 2, y: 2, z: 0 });
    expect(pickBodyAt(ctx(map), p.x, p.y, 0, 1)).toBeNull();
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
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId: "crate" }]);
    const top: ObjectRef = { x: 0, y: 0, z: 0, stackIndex: 1 };
    const p = onFoot(top);

    expect(pickTileAt(ctx(map), p.x, p.y, 0, 1)).toEqual(top);
  });

  it("answers everywhere on the cell, however high the stack is", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "slab" }, { tileId: "crate" }]);
    const crate: ObjectRef = { x: 0, y: 0, z: 0, stackIndex: 1 };
    const foot = footRect(0, 0, 0);

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
    expect(pickTileAt(ctx(map), pAbove.x, pAbove.y, 0, 0)).toBeNull();
  });

  it("cannot name a level the roof-cut has taken away", () => {
    const map = replaceStack(emptyMap(), 0, 0, 1, [{ tileId: "grass" }]);
    const roof: ObjectRef = { x: 0, y: 0, z: 1, stackIndex: 0 };
    const p = onFoot(roof);

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

    expect(
      pickTileAt(ctx(map), p.x, p.y, 0, 1, {
        floor: 0,
        cells: new Map([[1, new Set([coordKey(9, 9)])]]),
      }),
    ).toEqual(roof);
  });
});
