import { describe, expect, it } from "vitest";
import { appendTile, emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { fitsTile, tilesByIdFromList } from "../lib/validation";
import { FALL_MS_PER_HEIGHT, WALK_DURATION_MS } from "./constants";
import { GameSession } from "./GameSession";
import { findLandingAbs, isSupported } from "./gravity";
import { canWalk, standingAbs } from "./movement";
import { findPlayers, requireSinglePlayer } from "./player";

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
            rect: { x: 0, y: 0, w: 1, h: 1 },
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
    walkable: false,
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
  tile({ id: "tree", height: 2, walkable: false }),
  tile({
    id: "ramp",
    height: 1,
    directional: true,
    // Tall end is opposite facing (south-facing → climb north).
    climbFrom: {
      n: { n: false, e: false, s: true, w: false },
      e: { n: false, e: false, s: false, w: true },
      s: { n: true, e: false, s: false, w: false },
      w: { n: false, e: true, s: false, w: false },
    },
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

  it("allows full-height on a half-height base (overflow)", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "slab" }]);
    expect(fitsTile(map, 0, 0, 0, tilesById.wall!, tilesById).ok).toBe(true);
  });

  it("rejects placing on a stack that already reaches the next level", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "wall" }]);
    expect(fitsTile(map, 0, 0, 0, tilesById.slab!, tilesById).ok).toBe(false);
    expect(fitsTile(map, 0, 0, 0, tilesById.grass!, tilesById).ok).toBe(false);
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

  it("walks onto grass above a full lower level without dropping to that level", () => {
    // Mimics map (2,1): dirt + 2× half-height fillers on z=-1, grass on z=0.
    // Both surfaces share abs 0; the upper level must own the plane.
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = replaceStack(map, 1, 0, -1, [
      { tileId: "dirt" },
      { tileId: "slab" },
      { tileId: "slab" },
    ]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
    const loc = requireSinglePlayer(map);

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

  it("climbs ground → ramp → half+ramp (elev 0 → 1 → 2)", () => {
    // Default south-facing ramp: tall end is north. Staircase climbs north.
    let map = replaceStack(emptyMap(), 0, 1, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "n" },
    ]);
    map = replaceStack(map, 0, 0, 0, [{ tileId: "ramp", direction: "s" }]);
    map = replaceStack(map, 0, -1, 0, [
      { tileId: "slab" },
      { tileId: "ramp", direction: "s" },
    ]);

    const loc = requireSinglePlayer(map);
    expect(standingAbs(map, loc.x, loc.y, loc.z, loc.stackIndex, tilesById)).toBe(
      0,
    );

    const ontoRamp = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "n",
      tilesById.player!,
      tilesById,
    );
    expect(ontoRamp.ok).toBe(true);
    if (!ontoRamp.ok) return;
    expect(ontoRamp.to).toEqual({ x: 0, y: 0, z: 0 });

    // On the first ramp, climb onto half + ramp (abs 1 → 2).
    map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 0, [
      { tileId: "ramp", direction: "s" },
      { tileId: "player", direction: "n" },
    ]);
    const onRamp = requireSinglePlayer(map);
    expect(
      standingAbs(map, onRamp.x, onRamp.y, onRamp.z, onRamp.stackIndex, tilesById),
    ).toBe(1);

    const ontoHalfRamp = canWalk(
      map,
      { x: onRamp.x, y: onRamp.y, z: onRamp.z, stackIndex: onRamp.stackIndex },
      "n",
      tilesById.player!,
      tilesById,
    );
    expect(ontoHalfRamp.ok).toBe(true);
    if (!ontoHalfRamp.ok) return;
    // Full-height stack seals z=0; standing surface is owned by z=1 floor.
    expect(ontoHalfRamp.to).toEqual({ x: 0, y: -1, z: 1 });
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

describe("walkable surfaces", () => {
  it("does not treat a non-walkable top as a standing surface", () => {
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = replaceStack(map, 1, 0, 0, [{ tileId: "tree" }]);
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

  it("does not treat a full-height non-walkable as a floor above", () => {
    // Player on slab (abs 1) next to a tree (h=2) — must not walk onto the
    // fake floor at abs 2 formed by “full level below”.
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "slab" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "tree" }]);
    const loc = requireSinglePlayer(map);
    expect(
      canWalk(
        map,
        { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
        "e",
        tilesById.player!,
        tilesById,
      ).ok,
    ).toBe(false);
  });

  it("rejects stepping down onto a lone tree from above", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "wall" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "player", direction: "s" }]);
    map = replaceStack(map, 0, 1, 0, [{ tileId: "tree" }]);
    const loc = requireSinglePlayer(map);
    expect(
      canWalk(
        map,
        { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
        "s",
        tilesById.player!,
        tilesById,
      ).ok,
    ).toBe(false);
  });
});

describe("climb-from", () => {
  it("allows climb up only toward the tall end for that facing", () => {
    // Ramp facing south: tall end is north. Upper floor north of ramp.
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "ramp", direction: "s" },
      { tileId: "player", direction: "n" },
    ]);
    map = replaceStack(map, 0, -1, 0, [{ tileId: "wall" }]);

    const loc = requireSinglePlayer(map);
    const up = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "n",
      tilesById.player!,
      tilesById,
    );
    expect(up.ok).toBe(true);

    map = replaceStack(map, 1, 0, 0, [{ tileId: "wall" }]);
    const blocked = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "e",
      tilesById.player!,
      tilesById,
    );
    expect(blocked.ok).toBe(false);
  });

  it("uses the climb-from set for the placed facing (no rotation)", () => {
    // Facing east: tall end is west — not the same as facing direction.
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "ramp", direction: "e" },
      { tileId: "player", direction: "w" },
    ]);
    map = replaceStack(map, -1, 0, 0, [{ tileId: "wall" }]);

    const loc = requireSinglePlayer(map);
    const up = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "w",
      tilesById.player!,
      tilesById,
    );
    expect(up.ok).toBe(true);

    map = replaceStack(map, 0, -1, 0, [{ tileId: "wall" }]);
    const blocked = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "n",
      tilesById.player!,
      tilesById,
    );
    expect(blocked.ok).toBe(false);
  });

  it("allows step-down from the ramp regardless of climb-from", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "wall" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "player", direction: "s" }]);
    // Ramp south of the upper floor; south-facing tall end is north (back toward floor).
    map = replaceStack(map, 0, 1, 0, [{ tileId: "ramp", direction: "s" }]);

    const loc = requireSinglePlayer(map);
    const down = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "s",
      tilesById.player!,
      tilesById,
    );
    expect(down.ok).toBe(true);
  });
});

describe("preferDescend", () => {
  it("picks the lowest surface in the climb band when set", () => {
    // Player on slab (abs 1). Dest has grass at abs 0 (z=0) and grass at abs 2 (z=1).
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "slab" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 1, 0, 1, [{ tileId: "grass" }]);

    const loc = requireSinglePlayer(map);
    const high = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "e",
      tilesById.player!,
      tilesById,
    );
    expect(high.ok).toBe(true);
    if (high.ok) expect(high.to).toEqual({ x: 1, y: 0, z: 1 });

    const low = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "e",
      tilesById.player!,
      tilesById,
      { preferDescend: true },
    );
    expect(low.ok).toBe(true);
    if (low.ok) expect(low.to).toEqual({ x: 1, y: 0, z: 0 });
  });
});

describe("GameSession faceOnly and slide", () => {
  it("Shift/faceOnly updates facing without walking", () => {
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
    const session = new GameSession(map, tiles);
    session.setInput({ directions: ["e"], faceOnly: true });
    session.tick(1000 / 30);
    const snap = session.getSnapshot();
    expect(snap.walk).toBeNull();
    expect(snap.player.x).toBe(0);
    expect(snap.player.direction).toBe("e");
  });

  it("slides in facing direction when landing on a non-walkable top", () => {
    // Tree at (0,0) abs 2; grass east. Player falls from z=2 facing east.
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "tree" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 2, [{ tileId: "player", direction: "e" }]);
    const session = new GameSession(map, tiles);

    let elapsed = 0;
    const budget = FALL_MS_PER_HEIGHT * 8 + WALK_DURATION_MS + 100;
    while (elapsed < budget) {
      session.tick(1000 / 30);
      elapsed += 1000 / 30;
    }

    const snap = session.getSnapshot();
    expect(snap.fall).toBeNull();
    // Slid onto grass east of the tree.
    expect(snap.player).toMatchObject({ x: 1, y: 0, z: 0 });
  });
});
