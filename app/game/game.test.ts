import { describe, expect, it } from "vitest";
import { appendTile, emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { fitsTile, tilesByIdFromList } from "../lib/validation";
import { FALL_MS_PER_HEIGHT, WALK_DURATION_MS } from "./constants";
import { GameSession } from "./GameSession";
import { findLandingAbs, isSupported } from "./gravity";
import { canWalk, standingAbs } from "./movement";
import { findPlayers, requireSinglePlayer } from "./player";

function tile(
  partial: Partial<TileDef> & Pick<TileDef, "id" | "height">,
): TileDef {
  return {
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
  };
}

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "dirt", height: 0 }),
  tile({ id: "slab", height: 1 }),
  tile({ id: "plaster", height: 1 }),
  tile({ id: "wall", height: 2 }),
  tile({ id: "roof", height: 0 }),
  tile({
    id: "player",
    height: 2,
    directional: true,
    affectedByGravity: true,
    variants: {
      n: [
        {
          sprite: {
            tilesetId: "basic",
            rect: { x: 0, y: 0, w: 1, h: 1 },
            base: { x: 0, y: 0 },
          },
          durationMs: 200,
        },
      ],
      e: [
        {
          sprite: {
            tilesetId: "basic",
            rect: { x: 0, y: 0, w: 1, h: 1 },
            base: { x: 0, y: 0 },
          },
          durationMs: 200,
        },
      ],
      s: [
        {
          sprite: {
            tilesetId: "basic",
            rect: { x: 0, y: 0, w: 1, h: 1 },
            base: { x: 0, y: 0 },
          },
          durationMs: 200,
        },
      ],
      w: [
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
  }),
  tile({ id: "dwarf", height: 1, affectedByGravity: true }),
];

const tilesById = tilesByIdFromList(tiles);

function mapWithPlayer(at: { x: number; y: number; z?: number }): MapFile {
  let map = emptyMap();
  const z = at.z ?? 0;
  map = replaceStack(map, at.x, at.y, z, [
    { tileId: "grass" },
    { tileId: "player", direction: "s" },
  ]);
  return map;
}

describe("requireSinglePlayer", () => {
  it("throws when no player", () => {
    expect(() => requireSinglePlayer(emptyMap())).toThrow(/No tile/);
  });

  it("throws when more than one player", () => {
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = appendTile(map, 1, 0, 0, { tileId: "player", direction: "s" });
    expect(() => requireSinglePlayer(map)).toThrow(/exactly one/);
  });

  it("returns the sole player", () => {
    const map = mapWithPlayer({ x: 2, y: 3 });
    const loc = requireSinglePlayer(map);
    expect(loc).toMatchObject({ x: 2, y: 3, z: 0 });
    expect(findPlayers(map)).toHaveLength(1);
  });
});

describe("fitsTile", () => {
  it("allows flat placement", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    expect(fitsTile(map, 0, 0, 0, tilesById.player!, tilesById).ok).toBe(true);
  });

  it("rejects overflow under an occupied level above", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "slab" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "roof" }]);
    const dwarf = tilesById.dwarf!;
    // slab(1)+dwarf(1)=2 → ok under roof
    expect(fitsTile(map, 0, 0, 0, dwarf, tilesById).ok).toBe(true);
    // player(2)+slab(1)=3 → needs empty above, roof blocks
    expect(fitsTile(map, 0, 0, 0, tilesById.player!, tilesById).ok).toBe(false);
  });
});

describe("canWalk climb", () => {
  it("allows climb of 1", () => {
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = replaceStack(map, 1, 0, 0, [{ tileId: "slab" }]);
    const loc = requireSinglePlayer(map);
    const check = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "e",
      tilesById.player!,
      tilesById,
    );
    expect(check.ok).toBe(true);
  });

  it("rejects climb above 1", () => {
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = replaceStack(map, 1, 0, 0, [{ tileId: "wall" }]);
    const loc = requireSinglePlayer(map);
    const check = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "e",
      tilesById.player!,
      tilesById,
    );
    expect(check.ok).toBe(false);
  });

  it("rejects walking under a roof that does not fit", () => {
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = replaceStack(map, 1, 0, 0, [{ tileId: "slab" }]);
    map = replaceStack(map, 1, 0, 1, [{ tileId: "roof" }]);
    const loc = requireSinglePlayer(map);
    const check = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "e",
      tilesById.player!,
      tilesById,
    );
    expect(check.ok).toBe(false);
  });

  it("steps down a level within climb height without targeting void", () => {
    // Player on z=1 floor (abs 2); dest column has slab top at abs 1 on z=0.
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "wall" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "player", direction: "s" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "slab" }]);
    const loc = requireSinglePlayer(map);
    expect(loc.z).toBe(1);

    const check = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "e",
      tilesById.player!,
      tilesById,
    );
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.to).toEqual({ x: 1, y: 0, z: 0 });
    }
  });

  it("climbs a plaster ladder onto overflowing stacks (height 2 → 3)", () => {
    // Tops at abs 1, 2, 3 with half-height plaster.
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "plaster" },
      { tileId: "plaster" },
    ]);
    map = appendTile(map, 0, 0, 0, { tileId: "player", direction: "e" });
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "dirt" },
      { tileId: "plaster" },
      { tileId: "plaster" },
      { tileId: "plaster" },
    ]);
    const loc = requireSinglePlayer(map);
    expect(standingAbs(map, loc.x, loc.y, loc.z, loc.stackIndex, tilesById)).toBe(
      2,
    );

    const check = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "e",
      tilesById.player!,
      tilesById,
    );
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.to).toEqual({ x: 1, y: 0, z: 0 });
    }

    const session = new GameSession(map, tiles);
    session.setInput({ directions: ["e"] });
    let elapsed = 0;
    while (elapsed < WALK_DURATION_MS + 80) {
      session.tick(1000 / 30);
      elapsed += 1000 / 30;
    }
    const snap = session.getSnapshot();
    expect(snap.player.x).toBe(1);
    expect(
      standingAbs(
        snap.map,
        snap.player.x,
        snap.player.y,
        snap.player.z,
        snap.player.stackIndex,
        tilesById,
      ),
    ).toBe(3);
  });
});

describe("GameSession step-down", () => {
  it("does not fall when walking down ≤ climb height across a level", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "wall" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "player", direction: "s" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "slab" }]);
    const session = new GameSession(map, tiles);
    session.setInput({ directions: ["e"] });

    let elapsed = 0;
    while (elapsed < WALK_DURATION_MS + 80) {
      session.tick(1000 / 30);
      elapsed += 1000 / 30;
      const snap = session.getSnapshot();
      expect(snap.fall).toBeNull();
    }

    const snap = session.getSnapshot();
    expect(snap.player).toMatchObject({ x: 1, y: 0, z: 0 });
    expect(snap.fall).toBeNull();
  });
});

describe("gravity support", () => {
  it("is supported with a tile underfoot", () => {
    const map = mapWithPlayer({ x: 0, y: 0 });
    const loc = requireSinglePlayer(map);
    expect(
      isSupported(map, loc.x, loc.y, loc.z, loc.stackIndex, tilesById),
    ).toBe(true);
  });

  it("is unsupported when alone over void", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "player", direction: "s" },
    ]);
    const loc = requireSinglePlayer(map);
    expect(
      isSupported(map, loc.x, loc.y, loc.z, loc.stackIndex, tilesById),
    ).toBe(false);
  });

  it("finds a landing surface below", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "player", direction: "s" }]);
    const loc = requireSinglePlayer(map);
    const landing = findLandingAbs(map, 0, 0, 2, tilesById, {
      z: loc.z,
      stackIndex: loc.stackIndex,
    });
    expect(landing).toBe(0);
  });
});

describe("GameSession walk", () => {
  it("commits the player one tile after WALK_DURATION_MS", () => {
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
    const session = new GameSession(map, tiles);
    session.setInput({ directions: ["e"] });

    // Start walk
    session.tick(1000 / 30);
    let snap = session.getSnapshot();
    expect(snap.walk).not.toBeNull();
    expect(snap.player.x).toBe(0);

    // Finish walk
    let elapsed = 1000 / 30;
    while (elapsed < WALK_DURATION_MS + 50) {
      session.tick(1000 / 30);
      elapsed += 1000 / 30;
    }
    snap = session.getSnapshot();
    expect(snap.player.x).toBe(1);
    expect(snap.player.y).toBe(0);
    expect(getStack(snap.map, 0, 0, 0).some((p) => p.tileId === "player")).toBe(
      false,
    );
  });
});

describe("GameSession fall", () => {
  it("falls one height unit per FALL_MS_PER_HEIGHT onto grass below", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "player", direction: "s" }]);
    const session = new GameSession(map, tiles);

    // Kick gravity
    session.tick(1000 / 30);
    let snap = session.getSnapshot();
    expect(snap.fall).not.toBeNull();

    let elapsed = 1000 / 30;
    const budget = FALL_MS_PER_HEIGHT * 4;
    while (elapsed < budget) {
      session.tick(1000 / 30);
      elapsed += 1000 / 30;
      snap = session.getSnapshot();
      if (!snap.fall) break;
    }

    expect(snap.fall).toBeNull();
    expect(snap.player.z).toBe(0);
    expect(
      isSupported(
        snap.map,
        snap.player.x,
        snap.player.y,
        snap.player.z,
        snap.player.stackIndex,
        tilesById,
      ),
    ).toBe(true);
  });
});
