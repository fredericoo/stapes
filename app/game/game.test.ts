import { describe, expect, it } from "vitest";
import {
  appendTile,
  elevationAt,
  emptyMap,
  getStack,
  replaceStack,
  stackHeight,
  terrainHeight,
} from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { HEIGHT_PER_LEVEL } from "../lib/types";
import { canReplaceStack, fitsTile, tilesByIdFromList } from "../lib/validation";
import { FALL_MS_PER_HEIGHT, PUSH_STEP_MS, TICK_MS, WALK_DURATION_MS } from "./constants";
import { resolveStatus } from "../lib/status";
import { GameSession, LOCAL_ACTOR_ID } from "./GameSession";
import { isSupported } from "./gravity";
import { canWalk, findLandingAbs, groundWalkSpeedPercent, standingAbs } from "./movement";
import { findPlayers, requireSinglePlayer } from "./player";
import { tile } from "../lib/testTile";

function advance(session: GameSession, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) session.tick(TICK_MS);
}

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "dirt", height: 0 }),
  tile({ id: "mud", height: 0, walkSpeedPercent: -50 }),
  tile({ id: "slab", height: 2 }),
  tile({ id: "plaster", height: 2 }),
  tile({ id: "wall", height: 4 }),
  tile({ id: "roof", height: 0 }),
  tile({
    id: "player",
    height: 4,
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
  tile({ id: "dwarf", height: 2, affectedByGravity: true }),
  tile({
    id: "deer",
    height: 4,
    walkable: false,
    actor: true,
    affectedByGravity: true,
  }),
  tile({ id: "tree", height: 4, walkable: false }),
  tile({ id: "bush", height: 2, walkable: false }),
  tile({ id: "fence", height: 2, walkable: false }),
  tile({ id: "water", height: 0, walkable: false }),
  tile({ id: "wooden-floor", height: 0 }),
  tile({ id: "berry", height: 0 }),
  tile({
    id: "crate",
    height: 2,
    affectedByGravity: true,
    interactions: { push: { climb: "half", moveOnTileIds: [] } },
  }),
  tile({
    id: "door-closed",
    height: 2,
    walkable: false,
    interactions: { switch: { targetTileId: "door-open" } },
  }),
  tile({
    id: "door-open",
    height: 2,
    walkable: false,
    interactions: { switch: { targetTileId: "door-closed" } },
  }),
  tile({
    id: "door-tall",
    height: 4,
    walkable: false,
  }),
  tile({
    id: "switch-to-tall",
    height: 2,
    walkable: false,
    interactions: { switch: { targetTileId: "door-tall" } },
  }),
  tile({
    id: "door-ajar",
    height: 4,
    intangible: true,
    walkable: false,
  }),
  tile({
    id: "ramp",
    height: 2,
    directional: true,
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

  it("rejects height-adding tiles on a stack that already reaches the next level", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "wall" }]);
    expect(fitsTile(map, 0, 0, 0, tilesById.slab!, tilesById).ok).toBe(false);
    expect(fitsTile(map, 0, 0, 0, tilesById.wall!, tilesById).ok).toBe(false);
  });

  it("allows height-0 tiles on a full or overflowing stack", () => {
    const full = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "wall" }]);
    expect(fitsTile(full, 0, 0, 0, tilesById.grass!, tilesById).ok).toBe(true);
    expect(fitsTile(full, 0, 0, 0, tilesById.roof!, tilesById).ok).toBe(true);

    const overflow = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "slab" }, { tileId: "wall" }]);
    expect(fitsTile(overflow, 0, 0, 0, tilesById.grass!, tilesById).ok).toBe(true);
  });

  it("rejects overflow under an occupied level above", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "slab" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "roof" }]);
    const dwarf = tilesById.dwarf!;
    expect(fitsTile(map, 0, 0, 0, dwarf, tilesById).ok).toBe(true);
    expect(fitsTile(map, 0, 0, 0, tilesById.player!, tilesById).ok).toBe(false);
  });
});

describe("a body is not terrain", () => {
  function withBodyAt(x: number, tileId = "player", owner = "a"): MapFile {
    let map = emptyMap();
    for (let i = 0; i < 3; i++) {
      map = replaceStack(map, i, 0, 0, [{ tileId: "grass" }]);
    }
    return replaceStack(map, x, 0, 0, [{ tileId: "grass" }, { tileId, direction: "s", owner }]);
  }

  it("weighs nothing in the stack it stands in", () => {
    const map = withBodyAt(0);
    expect(stackHeight(getStack(map, 0, 0, 0), tilesById)).toBe(0);
  });

  it("still weighs its full height as an authored marker", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "s" },
    ]);
    expect(stackHeight(getStack(map, 0, 0, 0), tilesById)).toBe(4);
  });

  it("does not lift the body standing beside it", () => {
    let map = withBodyAt(0);
    map = appendTile(map, 0, 0, 0, {
      tileId: "player",
      direction: "s",
      owner: "b",
    });
    expect(standingAbs(map, 0, 0, 0, 1, tilesById)).toBe(0);
    expect(standingAbs(map, 0, 0, 0, 2, tilesById)).toBe(0);
  });

  it("does not hold up a body above it in the stack", () => {
    let map = replaceStack(emptyMap(), 0, 0, 1, [{ tileId: "player", direction: "s", owner: "a" }]);
    map = appendTile(map, 0, 0, 1, {
      tileId: "player",
      direction: "s",
      owner: "b",
    });
    expect(isSupported(map, 0, 0, 1, 1, tilesById)).toBe(false);
  });

  it("lets a person walk into the cell it is standing in", () => {
    const map = withBodyAt(1);
    const walk = canWalk(
      map,
      { x: 0, y: 0, z: 0, stackIndex: 1 },
      "e",
      tilesById.player!,
      tilesById,
    );
    expect(walk).toEqual({ ok: true, to: { x: 1, y: 0, z: 0 } });
  });

  it("stops a creature walking into the cell it is standing in", () => {
    const map = withBodyAt(1);
    const walk = canWalk(map, { x: 0, y: 0, z: 0, stackIndex: 1 }, "e", tilesById.deer!, tilesById);
    expect(walk.ok).toBe(false);
  });

  it("stops a person walking into the cell a creature is standing in", () => {
    const map = withBodyAt(1, "deer", "npc:1,0,0,1");
    const walk = canWalk(
      map,
      { x: 0, y: 0, z: 0, stackIndex: 1 },
      "e",
      tilesById.player!,
      tilesById,
    );
    expect(walk.ok).toBe(false);
  });

  it("stops an object being placed in the cell it is standing in", () => {
    const map = withBodyAt(0);
    expect(fitsTile(map, 0, 0, 0, tilesById.crate!, tilesById).ok).toBe(false);
    expect(fitsTile(map, 0, 0, 0, tilesById.wall!, tilesById).ok).toBe(false);
  });

  it("lets a flat tile be laid under it", () => {
    const map = withBodyAt(0);
    expect(fitsTile(map, 0, 0, 0, tilesById.roof!, tilesById).ok).toBe(true);
  });

  it("does not occupy the level it overflows into", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "slab" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "player", direction: "s", owner: "a" }]);
    expect(
      fitsTile(map, 0, 0, 0, tilesById.player!, tilesById, {
        throughPlayers: true,
      }).ok,
    ).toBe(true);
  });

  it("still stops an object being built through its legs", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "slab" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "player", direction: "s", owner: "a" }]);
    expect(fitsTile(map, 0, 0, 0, tilesById.wall!, tilesById).ok).toBe(false);
  });

  it("draws the second body at the first one's feet, not on its head", () => {
    const stack = [
      { tileId: "grass" },
      { tileId: "player", direction: "s" as const, owner: "a" },
      { tileId: "player", direction: "s" as const, owner: "b" },
    ];
    expect(elevationAt(stack, 1, tilesById)).toBe(0);
    expect(elevationAt(stack, 2, tilesById)).toBe(0);
  });

  it("does not lift the scenery drawn above it either", () => {
    const stack = [
      { tileId: "slab" },
      { tileId: "player", direction: "s" as const, owner: "a" },
      { tileId: "roof" },
    ];
    expect(elevationAt(stack, 2, tilesById)).toBe(2);
  });

  it("weighs nothing as a single placement", () => {
    const marker = { tileId: "player", direction: "s" as const };
    const body = { tileId: "player", direction: "s" as const, owner: "a" };
    expect(terrainHeight(marker, tilesById)).toBe(4);
    expect(terrainHeight(body, tilesById)).toBe(0);
  });

  it("is nothing to land on", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "player", direction: "s", owner: "a" }]);
    expect(findLandingAbs(map, 0, 0, 4, tilesById)).toBe(0);
  });
});

describe("canReplaceStack", () => {
  it("allows trailing height-0 tiles on a full stack", () => {
    const map = emptyMap();
    expect(
      canReplaceStack(
        map,
        0,
        0,
        0,
        [{ tileId: "wall" }, { tileId: "grass" }, { tileId: "roof" }],
        tilesById,
      ).ok,
    ).toBe(true);
  });

  it("rejects a height-adding tile after the stack is already full", () => {
    const map = emptyMap();
    expect(
      canReplaceStack(map, 0, 0, 0, [{ tileId: "wall" }, { tileId: "slab" }], tilesById).ok,
    ).toBe(false);
  });

  describe("with bodies in the stack", () => {
    const body = (owner: string) => ({
      tileId: "player",
      direction: "s" as const,
      owner,
    });

    it("refuses to close a door through the person standing in it", () => {
      const map = replaceStack(emptyMap(), 0, 0, 0, [
        { tileId: "grass" },
        { tileId: "door-ajar" },
        body("a"),
      ]);
      expect(
        canReplaceStack(
          map,
          0,
          0,
          0,
          [{ tileId: "grass" }, { tileId: "door-tall" }, body("a")],
          tilesById,
        ).ok,
      ).toBe(false);
    });

    it("refuses it through two of them just as firmly", () => {
      const map = replaceStack(emptyMap(), 0, 0, 0, [
        { tileId: "grass" },
        { tileId: "door-ajar" },
        body("a"),
        body("b"),
      ]);
      expect(
        canReplaceStack(
          map,
          0,
          0,
          0,
          [{ tileId: "grass" }, { tileId: "door-tall" }, body("a"), body("b")],
          tilesById,
        ).ok,
      ).toBe(false);
    });

    it("lets a flat tile swap under a crowd", () => {
      const map = replaceStack(emptyMap(), 0, 0, 0, [
        { tileId: "grass" },
        body("a"),
        body("b"),
        body("c"),
      ]);
      expect(
        canReplaceStack(
          map,
          0,
          0,
          0,
          [{ tileId: "dirt" }, body("a"), body("b"), body("c")],
          tilesById,
        ).ok,
      ).toBe(true);
    });

    it("still measures the one body against the scenery under it", () => {
      let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, body("a")]);
      map = replaceStack(map, 0, 0, 1, [{ tileId: "roof" }]);
      expect(canReplaceStack(map, 0, 0, 0, [{ tileId: "slab" }, body("a")], tilesById).ok).toBe(
        false,
      );
    });
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

  it("walks through a full-height intangible door", () => {
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "door-ajar" }]);
    const loc = requireSinglePlayer(map);
    const check = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "e",
      tilesById.player!,
      tilesById,
    );
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.to).toMatchObject({ x: 1, y: 0, z: 0 });
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

  it("stands on a seat under a roof, but not on a half-level crate", () => {
    expect(HEIGHT_PER_LEVEL).toBe(4);
    const person = tile({ id: "person", height: 3 });
    const seat = tile({ id: "seat", height: 1 });
    const crate = tile({ id: "crate", height: 2 });
    const indoors = tilesByIdFromList([...tiles, person, seat, crate]);

    const room = (furniture: string): MapFile => {
      let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
      map = appendTile(map, 0, 0, 0, { tileId: "person" });
      map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: furniture }]);
      map = replaceStack(map, 0, 0, 1, [{ tileId: "roof" }]);
      return replaceStack(map, 1, 0, 1, [{ tileId: "roof" }]);
    };

    const stepEast = (map: MapFile) =>
      canWalk(
        map,
        { x: 0, y: 0, z: 0, stackIndex: getStack(map, 0, 0, 0).length - 1 },
        "e",
        person,
        indoors,
      );

    expect(stepEast(room("seat")).ok).toBe(true);
    expect(stepEast(room("crate"))).toMatchObject({ ok: false });

    const giant = tile({ id: "giant", height: HEIGHT_PER_LEVEL });
    expect(
      canWalk(
        room("seat"),
        { x: 0, y: 0, z: 0, stackIndex: 1 },
        "e",
        giant,
        tilesByIdFromList([...tiles, giant, seat]),
      ),
    ).toMatchObject({ ok: false });
  });

  it("steps down a level within climb height without targeting void", () => {
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
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = replaceStack(map, 1, 0, -1, [{ tileId: "dirt" }, { tileId: "slab" }, { tileId: "slab" }]);
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
    let map = replaceStack(emptyMap(), 0, 1, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "n" },
    ]);
    map = replaceStack(map, 0, 0, 0, [{ tileId: "ramp", direction: "s" }]);
    map = replaceStack(map, 0, -1, 0, [{ tileId: "slab" }, { tileId: "ramp", direction: "s" }]);

    const loc = requireSinglePlayer(map);
    expect(standingAbs(map, loc.x, loc.y, loc.z, loc.stackIndex, tilesById)).toBe(0);

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

    map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 0, [
      { tileId: "ramp", direction: "s" },
      { tileId: "player", direction: "n" },
    ]);
    const onRamp = requireSinglePlayer(map);
    expect(standingAbs(map, onRamp.x, onRamp.y, onRamp.z, onRamp.stackIndex, tilesById)).toBe(2);

    const ontoHalfRamp = canWalk(
      map,
      { x: onRamp.x, y: onRamp.y, z: onRamp.z, stackIndex: onRamp.stackIndex },
      "n",
      tilesById.player!,
      tilesById,
    );
    expect(ontoHalfRamp.ok).toBe(true);
    if (!ontoHalfRamp.ok) return;
    expect(ontoHalfRamp.to).toEqual({ x: 0, y: -1, z: 1 });
  });

  it("climbs a plaster ladder onto overflowing stacks (height 4 → 6)", () => {
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
    expect(standingAbs(map, loc.x, loc.y, loc.z, loc.stackIndex, tilesById)).toBe(4);

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
    expect(snap.self.x).toBe(1);
    expect(
      standingAbs(snap.map, snap.self.x, snap.self.y, snap.self.z, snap.self.stackIndex, tilesById),
    ).toBe(6);
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
      expect(snap.self.fall).toBeNull();
    }

    const snap = session.getSnapshot();
    expect(snap.self).toMatchObject({ x: 1, y: 0, z: 0 });
    expect(snap.self.fall).toBeNull();
  });
});

describe("gravity support", () => {
  it("is supported with a tile underfoot", () => {
    const map = mapWithPlayer({ x: 0, y: 0 });
    const loc = requireSinglePlayer(map);
    expect(isSupported(map, loc.x, loc.y, loc.z, loc.stackIndex, tilesById)).toBe(true);
  });

  it("is unsupported when alone over void", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "player", direction: "s" }]);
    const loc = requireSinglePlayer(map);
    expect(isSupported(map, loc.x, loc.y, loc.z, loc.stackIndex, tilesById)).toBe(false);
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

    session.tick(1000 / 30);
    let snap = session.getSnapshot();
    expect(snap.self.walk).not.toBeNull();
    expect(snap.self.x).toBe(0);

    let elapsed = 1000 / 30;
    while (elapsed < WALK_DURATION_MS + 50) {
      session.tick(1000 / 30);
      elapsed += 1000 / 30;
    }
    snap = session.getSnapshot();
    expect(snap.self.x).toBe(1);
    expect(snap.self.y).toBe(0);
    expect(getStack(snap.map, 0, 0, 0).some((p) => p.tileId === "player")).toBe(false);
  });

  it("walks a slowed body at the slowed pace", () => {
    const mired = resolveStatus({
      id: "mired",
      name: "Mired",
      description: "Wading.",
      tone: "bad",
      fromMs: 60_000,
      toMs: 60_000,
      walkSpeedPercent: -50,
    })!;
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
    const session = new GameSession(map, tiles, {
      statuses: { mired: mired },
    });
    session.runCommand("/status mired");
    session.setInput({ directions: ["e"] });

    session.tick(TICK_MS);
    advance(session, WALK_DURATION_MS);
    expect(session.getSnapshot().self.x).toBe(0);

    advance(session, WALK_DURATION_MS + TICK_MS * 2);
    expect(session.getSnapshot().self.x).toBe(1);
  });

  it("walks a body out of slow ground at the slow pace", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "mud" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
    const session = new GameSession(map, tiles);
    session.setInput({ directions: ["e"] });

    session.tick(TICK_MS);
    advance(session, WALK_DURATION_MS);
    expect(session.getSnapshot().self.x).toBe(0);

    advance(session, WALK_DURATION_MS + TICK_MS * 2);
    expect(session.getSnapshot().self.x).toBe(1);
  });

  it("adds what a body is under to what it is standing on", () => {
    const mired = resolveStatus({
      id: "mired",
      name: "Mired",
      description: "Wading.",
      tone: "bad",
      fromMs: 60_000,
      toMs: 60_000,
      walkSpeedPercent: -25,
    })!;
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "mud" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
    const session = new GameSession(map, tiles, { statuses: { mired } });
    session.runCommand("/status mired");
    session.setInput({ directions: ["e"] });

    session.tick(TICK_MS);
    advance(session, WALK_DURATION_MS * 3);
    expect(session.getSnapshot().self.x).toBe(0);

    advance(session, WALK_DURATION_MS + TICK_MS * 2);
    expect(session.getSnapshot().self.x).toBe(1);
  });
});

describe("the ground's say in a pace", () => {
  const at = (x: number, y: number, z: number, stackIndex: number) => ({
    x,
    y,
    z,
    stackIndex,
  });
  const by = tilesByIdFromList(tiles);

  it("reads the surface the body is standing on", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "mud" },
      { tileId: "player", direction: "e" },
    ]);
    expect(groundWalkSpeedPercent(map, at(0, 0, 0, 1), by)).toBe(-50);
  });

  it("is nothing on ground nobody authored a figure onto", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e" },
    ]);
    expect(groundWalkSpeedPercent(map, at(0, 0, 0, 1), by)).toBe(0);
  });

  it("is nothing in open air", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "player", direction: "e" }]);
    expect(groundWalkSpeedPercent(map, at(0, 0, 0, 0), by)).toBe(0);
  });

  it("never reads the walking body's own tile", () => {
    const boggy = [...tiles, tile({ id: "slug", height: 2, actor: true, walkSpeedPercent: -90 })];
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId: "slug" }]);
    expect(groundWalkSpeedPercent(map, at(0, 0, 0, 1), tilesByIdFromList(boggy))).toBe(0);
  });
});

describe("GameSession fall", () => {
  it("falls one height unit per FALL_MS_PER_HEIGHT onto grass below", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "player", direction: "s" }]);
    const session = new GameSession(map, tiles);

    session.tick(1000 / 30);
    let snap = session.getSnapshot();
    expect(snap.self.fall).not.toBeNull();

    let elapsed = 1000 / 30;
    const budget = FALL_MS_PER_HEIGHT * 4;
    while (elapsed < budget) {
      session.tick(1000 / 30);
      elapsed += 1000 / 30;
      snap = session.getSnapshot();
      if (!snap.self.fall) break;
    }

    expect(snap.self.fall).toBeNull();
    expect(snap.self.z).toBe(0);
    expect(
      isSupported(snap.map, snap.self.x, snap.self.y, snap.self.z, snap.self.stackIndex, tilesById),
    ).toBe(true);
  });

  it("lands on a floor sealed over a full-height non-walkable tile", () => {
    let map = replaceStack(emptyMap(), 0, 0, -1, [{ tileId: "dirt" }, { tileId: "tree" }]);
    map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 1, 0, [{ tileId: "wall" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "player", direction: "s" }]);
    const session = new GameSession(map, tiles);

    const budgetMs = FALL_MS_PER_HEIGHT * 16;
    for (let elapsed = 0; elapsed < budgetMs; elapsed += 1000 / 30) {
      session.tick(1000 / 30);
    }

    const snap = session.getSnapshot();
    expect(snap.self.fall).toBeNull();
    expect({ x: snap.self.x, y: snap.self.y, z: snap.self.z }).toEqual({
      x: 0,
      y: 0,
      z: 0,
    });
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

  it("walks onto a floored cell sealed over a full-height non-walkable tile", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, -1, [{ tileId: "dirt" }, { tileId: "tree" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
    const loc = requireSinglePlayer(map);
    const check = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "e",
      tilesById.player!,
      tilesById,
    );
    expect(check).toEqual({ ok: true, to: { x: 1, y: 0, z: 0 } });
  });

  it("walks onto the floor a full walkable level below forms", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, -1, [{ tileId: "slab" }, { tileId: "slab" }]);
    const loc = requireSinglePlayer(map);
    const check = canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "e",
      tilesById.player!,
      tilesById,
    );
    expect(check).toEqual({ ok: true, to: { x: 1, y: 0, z: 0 } });
  });

  it("does not let walkable ground under water make the water walkable", () => {
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "water" }]);
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

  it("does not let a full level below make water over it walkable", () => {
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = replaceStack(map, 1, 0, -1, [{ tileId: "slab" }, { tileId: "slab" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "water" }]);
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

  it("walks onto a bridge deck laid over something non-walkable", () => {
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "water" },
      { tileId: "fence" },
      { tileId: "wooden-floor" },
    ]);
    const loc = requireSinglePlayer(map);
    expect(
      canWalk(
        map,
        { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
        "e",
        tilesById.player!,
        tilesById,
      ),
    ).toEqual({ ok: true, to: { x: 1, y: 0, z: 0 } });
  });

  it("refuses that same deck once a railing is stacked on it", () => {
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "water" },
      { tileId: "fence" },
      { tileId: "wooden-floor" },
      { tileId: "fence" },
    ]);
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

  it("still walks onto a dropped item lying on ordinary ground", () => {
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "berry" }]);
    const loc = requireSinglePlayer(map);
    expect(
      canWalk(
        map,
        { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
        "e",
        tilesById.player!,
        tilesById,
      ),
    ).toEqual({ ok: true, to: { x: 1, y: 0, z: 0 } });
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

describe("GameSession faceOnly", () => {
  it("Shift/faceOnly updates facing without walking", () => {
    let map = mapWithPlayer({ x: 0, y: 0 });
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
    const session = new GameSession(map, tiles);
    session.setInput({ directions: ["e"], faceOnly: true });
    session.tick(1000 / 30);
    const snap = session.getSnapshot();
    expect(snap.self.walk).toBeNull();
    expect(snap.self.x).toBe(0);
    expect(snap.self.direction).toBe("e");
  });
});

describe("canWalk onto a fall", () => {
  function ledge(east: { z: number; stack: string[] }): MapFile {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId: "wall" }]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "player", direction: "e" }]);
    return replaceStack(
      map,
      1,
      0,
      east.z,
      east.stack.map((tileId) => ({ tileId })),
    );
  }

  function stepEast(map: MapFile) {
    const loc = requireSinglePlayer(map);
    return canWalk(
      map,
      { x: loc.x, y: loc.y, z: loc.z, stackIndex: loc.stackIndex },
      "e",
      tilesById.player!,
      tilesById,
    );
  }

  it("refuses a step down onto a fence", () => {
    expect(stepEast(ledge({ z: 0, stack: ["grass", "fence"] })).ok).toBe(false);
  });

  it("refuses a fall that ends on a fence several levels down", () => {
    expect(stepEast(ledge({ z: -2, stack: ["grass", "fence"] })).ok).toBe(false);
  });

  it("refuses a fall into water", () => {
    expect(stepEast(ledge({ z: -1, stack: ["water"] })).ok).toBe(false);
  });

  it("allows a fall that ends on ground", () => {
    const check = stepEast(ledge({ z: -2, stack: ["grass"] }));
    expect(check).toEqual({ ok: true, to: { x: 1, y: 0, z: 1 } });
  });

  it("allows a step over a column with nothing under it", () => {
    expect(stepEast(ledge({ z: 0, stack: [] })).ok).toBe(true);
  });

  it("refuses the same step on the server, so the body never leaves the wall", () => {
    const session = new GameSession(ledge({ z: 0, stack: ["grass", "fence"] }), tiles);
    expect(session.requestStep(LOCAL_ACTOR_ID, "e")).toBe("refused");
    expect(session.getSnapshot().self).toMatchObject({ x: 0, y: 0, z: 1 });
  });
});

describe("GameSession landing", () => {
  it("lands on a non-walkable top when the board drops a body onto one", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "tree" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 2, [{ tileId: "player", direction: "e" }]);
    const session = new GameSession(map, tiles);

    advance(session, FALL_MS_PER_HEIGHT * 8 + WALK_DURATION_MS + 100);

    const snap = session.getSnapshot();
    expect(snap.self.fall).toBeNull();
    expect(snap.self.walk).toBeNull();
    expect(snap.self).toMatchObject({ x: 0, y: 0 });
    const self = snap.self;
    expect(standingAbs(snap.map, self.x, self.y, self.z, self.stackIndex, tilesById)).toBe(4);
  });
});

function mapWithCrate(crateX: number, width = 5): MapFile {
  let map = emptyMap();
  for (let x = 0; x < width; x++) {
    map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, x, 1, 0, [{ tileId: "grass" }]);
  }
  map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "e" }]);
  map = replaceStack(map, crateX, 0, 0, [{ tileId: "grass" }, { tileId: "crate" }]);
  return map;
}

describe("GameSession canInteract", () => {
  const crateRef = (x: number) => ({ x, y: 0, z: 0, stackIndex: 1 });

  it("hovers an object the player can push", () => {
    const session = new GameSession(mapWithCrate(1), tiles);
    expect(session.canInteract(crateRef(1))).toBe(true);
  });

  it("says no to a tile with nothing to do", () => {
    const session = new GameSession(mapWithCrate(1), tiles);
    expect(session.canInteract({ x: 2, y: 0, z: 0, stackIndex: 0 })).toBe(false);
  });

  it("hovers an object with something stacked on top of it", () => {
    let map = mapWithCrate(1);
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "crate" },
      { tileId: "slab" },
    ]);
    const session = new GameSession(map, tiles);
    expect(session.canInteract({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(true);
  });

  it("ignores a hover on a switch buried under something", () => {
    let map = mapWithCrate(3);
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "door-closed" },
      { tileId: "slab" },
    ]);
    const session = new GameSession(map, tiles);
    expect(session.canInteract({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(false);
  });

  it("hovers an interactive object one floor above", () => {
    let map = mapWithCrate(3);
    map = replaceStack(map, 1, 0, 1, [{ tileId: "grass" }, { tileId: "crate" }]);
    const session = new GameSession(map, tiles);
    expect(session.canInteract({ x: 1, y: 0, z: 1, stackIndex: 1 })).toBe(true);
  });

  it("ignores a switch a floor below the ground it is standing on", () => {
    let map = mapWithCrate(3);
    map = replaceStack(map, 1, 0, -1, [{ tileId: "grass" }, { tileId: "door-closed" }]);
    const session = new GameSession(map, tiles);
    const ref = { x: 1, y: 0, z: -1, stackIndex: 1 };

    expect(session.canInteract(ref)).toBe(false);
    expect(session.activateSwitch(ref)).toBe(false);
  });

  it("ignores a hover two floors away", () => {
    let map = mapWithCrate(3);
    map = replaceStack(map, 1, 0, 2, [{ tileId: "grass" }, { tileId: "crate" }]);
    const session = new GameSession(map, tiles);
    expect(session.canInteract({ x: 1, y: 0, z: 2, stackIndex: 1 })).toBe(false);
  });

  it("ignores an object that is out of push range", () => {
    const session = new GameSession(mapWithCrate(2), tiles);
    expect(session.canInteract(crateRef(2))).toBe(false);
  });

  it("ignores an object on the diagonal", () => {
    let map = mapWithCrate(3);
    map = replaceStack(map, 1, 1, 0, [{ tileId: "grass" }, { tileId: "crate" }]);
    const session = new GameSession(map, tiles);
    expect(session.canInteract({ x: 1, y: 1, z: 0, stackIndex: 1 })).toBe(false);
  });

  it("ignores an adjacent object that has nowhere to go", () => {
    let map = mapWithCrate(1);
    map = replaceStack(map, 2, 0, 0, [{ tileId: "grass" }, { tileId: "tree" }]);
    const session = new GameSession(map, tiles);
    expect(session.canInteract(crateRef(1))).toBe(false);
  });

  it("hovers an adjacent switch", () => {
    let map = mapWithCrate(3);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "door-closed" }]);
    const session = new GameSession(map, tiles);
    expect(session.canInteract(crateRef(1))).toBe(true);
  });

  it("says no once the player has walked away", () => {
    const session = new GameSession(mapWithCrate(1), tiles);
    expect(session.canInteract(crateRef(1))).toBe(true);

    session.setInput({ directions: ["s"] });
    let elapsed = 0;
    while (elapsed < WALK_DURATION_MS + 80) {
      session.tick(1000 / 30);
      elapsed += 1000 / 30;
    }
    expect(session.getSnapshot().self).toMatchObject({ x: 0, y: 1 });
    expect(session.canInteract(crateRef(1))).toBe(false);
  });

  it("says no while the object is still travelling", () => {
    const session = new GameSession(mapWithCrate(1), tiles);
    session.push(crateRef(1));
    expect(session.canInteract(crateRef(1))).toBe(false);
  });
});

describe("GameSession push", () => {
  const crateRef = (x: number) => ({ x, y: 0, z: 0, stackIndex: 1 });

  function runSlide(session: GameSession) {
    let elapsed = 0;
    const budget = PUSH_STEP_MS + 80;
    while (elapsed < budget) {
      session.tick(1000 / 30);
      elapsed += 1000 / 30;
    }
  }

  it("shoves the object one cell straight away from the player", () => {
    const session = new GameSession(mapWithCrate(1), tiles);
    expect(session.push(crateRef(1))).toBe(true);
    runSlide(session);

    const map = session.getSnapshot().map;
    expect(getStack(map, 1, 0, 0).map((p) => p.tileId)).toEqual(["grass"]);
    expect(getStack(map, 2, 0, 0).map((p) => p.tileId)).toEqual(["grass", "crate"]);
  });

  it("pushes away from the player, whichever side they stand on", () => {
    let map = mapWithCrate(1);
    map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 2, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "w" }]);
    const session = new GameSession(map, tiles);
    expect(session.push(crateRef(1))).toBe(true);
    runSlide(session);

    expect(getStack(session.getSnapshot().map, 0, 0, 0).map((p) => p.tileId)).toEqual([
      "grass",
      "crate",
    ]);
  });

  it("turns the player toward the object they shove", () => {
    let map = mapWithCrate(3);
    map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }, { tileId: "crate" }]);
    map = replaceStack(map, 0, 2, 0, [{ tileId: "grass" }]);
    const session = new GameSession(map, tiles);
    expect(session.push({ x: 0, y: 1, z: 0, stackIndex: 1 })).toBe(true);
    expect(session.getSnapshot().self.direction).toBe("s");
  });

  it("refuses an object two cells away", () => {
    const session = new GameSession(mapWithCrate(2), tiles);
    expect(session.push(crateRef(2))).toBe(false);
    expect(session.getSnapshot().self.slide).toBeNull();
  });

  it("refuses an object on the diagonal", () => {
    let map = mapWithCrate(3);
    map = replaceStack(map, 1, 1, 0, [{ tileId: "grass" }, { tileId: "crate" }]);
    const session = new GameSession(map, tiles);
    expect(session.push({ x: 1, y: 1, z: 0, stackIndex: 1 })).toBe(false);
  });

  it("pushes an object standing one floor below", () => {
    let map = mapWithCrate(3);
    map = replaceStack(map, 1, 0, 0, []);
    map = replaceStack(map, 1, 0, -1, [{ tileId: "grass" }, { tileId: "crate" }]);
    map = replaceStack(map, 2, 0, -1, [{ tileId: "grass" }]);
    map = replaceStack(map, 2, 0, 0, []);
    const session = new GameSession(map, tiles);
    expect(session.push({ x: 1, y: 0, z: -1, stackIndex: 1 })).toBe(true);
    runSlide(session);
    expect(getStack(session.getSnapshot().map, 2, 0, -1).map((p) => p.tileId)).toEqual([
      "grass",
      "crate",
    ]);
  });

  it("refuses an object two floors away", () => {
    let map = mapWithCrate(3);
    map = replaceStack(map, 1, 0, 2, [{ tileId: "grass" }, { tileId: "crate" }]);
    const session = new GameSession(map, tiles);
    expect(session.push({ x: 1, y: 0, z: 2, stackIndex: 1 })).toBe(false);
  });

  it("carries whatever is stacked on the object it shoves", () => {
    let map = mapWithCrate(1);
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "crate" },
      { tileId: "slab" },
    ]);
    const session = new GameSession(map, tiles);

    expect(session.push({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(true);
    const snap = session.getSnapshot();
    expect(getStack(snap.map, 1, 0, 0).map((p) => p.tileId)).toEqual(["grass"]);
    expect(getStack(snap.map, 2, 0, 0).map((p) => p.tileId)).toEqual(["grass", "crate", "slab"]);
    expect(snap.self.slide?.object).toEqual({ x: 2, y: 0, z: 0, stackIndex: 1 });
    expect(snap.self.slide?.count).toBe(2);
  });

  it("refuses a column too tall for where it is going", () => {
    let map = mapWithCrate(1);
    map = replaceStack(map, 2, 0, 1, [{ tileId: "grass" }]);
    expect(new GameSession(map, tiles).push(crateRef(1))).toBe(true);

    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "crate" },
      { tileId: "wall" },
    ]);
    const session = new GameSession(map, tiles);
    expect(session.push({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(false);
  });

  it("does nothing when the cell behind the object is blocked", () => {
    let map = mapWithCrate(1);
    map = replaceStack(map, 2, 0, 0, [{ tileId: "grass" }, { tileId: "tree" }]);
    const session = new GameSession(map, tiles);
    expect(session.push(crateRef(1))).toBe(false);
    expect(getStack(session.getSnapshot().map, 1, 0, 0).map((p) => p.tileId)).toEqual([
      "grass",
      "crate",
    ]);
  });

  it("pushes an object over a ledge down to the floor below", () => {
    let map = mapWithCrate(1);
    map = replaceStack(map, 2, 0, 0, []);
    map = replaceStack(map, 2, 0, -1, [{ tileId: "grass" }]);
    const session = new GameSession(map, tiles);
    expect(session.push(crateRef(1))).toBe(true);
    runSlide(session);
    expect(getStack(session.getSnapshot().map, 2, 0, -1).map((p) => p.tileId)).toEqual([
      "grass",
      "crate",
    ]);
  });

  it("commits the move up front and slides only the sprite", () => {
    const session = new GameSession(mapWithCrate(1), tiles);
    session.push(crateRef(1));

    const snap = session.getSnapshot();
    expect(getStack(snap.map, 1, 0, 0).map((p) => p.tileId)).toEqual(["grass"]);
    expect(getStack(snap.map, 2, 0, 0).map((p) => p.tileId)).toEqual(["grass", "crate"]);
    expect(snap.self.slide).not.toBeNull();
    expect(snap.self.slide?.from).toEqual({ x: 1, y: 0, z: 0 });
    expect(snap.self.slide?.object).toEqual({ x: 2, y: 0, z: 0, stackIndex: 1 });
    expect(snap.self.slide?.count).toBe(1);
    expect(snap.self.slideProgress).toBe(0);

    runSlide(session);
    expect(session.getSnapshot().self.slide).toBeNull();
  });

  it("hands back the same slide while it runs", () => {
    const session = new GameSession(mapWithCrate(1), tiles);
    session.push(crateRef(1));

    const first = session.getSnapshot().self.slide;
    session.tick(1000 / 30);
    const second = session.getSnapshot().self.slide;

    expect(second).toBe(first);
    expect(session.getSnapshot().self.slideProgress).toBeGreaterThan(0);
  });

  it("lets the player follow straight into the cell the object left", () => {
    let map = mapWithCrate(1);
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "crate" },
      { tileId: "crate" },
    ]);
    const session = new GameSession(map, tiles);
    expect(session.push({ x: 1, y: 0, z: 0, stackIndex: 2 })).toBe(true);

    session.setInput({ directions: ["e"] });
    session.tick(1000 / 30);

    const snap = session.getSnapshot();
    expect(snap.self.slide).not.toBeNull();
    expect(snap.self.walk?.to).toEqual({ x: 1, y: 0, z: 0 });
  });

  it("cannot be pushed again while still travelling", () => {
    const session = new GameSession(mapWithCrate(1), tiles);
    session.push(crateRef(1));
    expect(session.push(crateRef(1))).toBe(false);
  });

  it("leaves the object beyond reach once it lands out of range", () => {
    const session = new GameSession(mapWithCrate(1), tiles);
    session.push(crateRef(1));
    runSlide(session);

    expect(session.canInteract(crateRef(1))).toBe(false);
  });

  it("lets the player walk while the object is still travelling", () => {
    const session = new GameSession(mapWithCrate(1), tiles);
    session.push(crateRef(1));
    session.setInput({ directions: ["s"] });
    session.tick(1000 / 30);

    const snap = session.getSnapshot();
    expect(snap.self.slide).not.toBeNull();
    expect(snap.self.walk).not.toBeNull();
  });
});

describe("GameSession switch", () => {
  function mapWithSwitchable(tileId: string): MapFile {
    let map = emptyMap();
    for (let x = 0; x < 3; x++) {
      map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
    }
    map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "e" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId }]);
    return map;
  }

  const doorRef = { x: 1, y: 0, z: 0, stackIndex: 1 };

  it("replaces the tile with its switch target", () => {
    const session = new GameSession(mapWithSwitchable("door-closed"), tiles);
    expect(session.activateSwitch(doorRef)).toBe(true);
    expect(getStack(session.getSnapshot().map, 1, 0, 0).map((p) => p.tileId)).toEqual([
      "grass",
      "door-open",
    ]);
  });

  it("toggles back when the target also has switch", () => {
    const session = new GameSession(mapWithSwitchable("door-closed"), tiles);
    expect(session.activateSwitch(doorRef)).toBe(true);
    expect(session.activateSwitch(doorRef)).toBe(true);
    expect(getStack(session.getSnapshot().map, 1, 0, 0).map((p) => p.tileId)).toEqual([
      "grass",
      "door-closed",
    ]);
  });

  it("preserves placement direction", () => {
    let map = mapWithSwitchable("door-closed");
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "door-closed", direction: "s" },
    ]);
    const session = new GameSession(map, tiles);
    expect(session.activateSwitch(doorRef)).toBe(true);
    expect(getStack(session.getSnapshot().map, 1, 0, 0)[1]).toEqual({
      tileId: "door-open",
      direction: "s",
    });
  });

  it("refuses when the taller target would not fit", () => {
    let map = mapWithSwitchable("switch-to-tall");
    map = replaceStack(map, 1, 0, 0, [{ tileId: "slab" }, { tileId: "switch-to-tall" }]);
    map = replaceStack(map, 1, 0, 1, [{ tileId: "roof" }]);
    const session = new GameSession(map, tiles);
    expect(session.activateSwitch(doorRef)).toBe(false);
    expect(getStack(session.getSnapshot().map, 1, 0, 0).map((p) => p.tileId)).toEqual([
      "slab",
      "switch-to-tall",
    ]);
  });

  it("allows a taller target when overflow headroom is free", () => {
    let map = mapWithSwitchable("switch-to-tall");
    map = replaceStack(map, 1, 0, 0, [{ tileId: "slab" }, { tileId: "switch-to-tall" }]);
    const session = new GameSession(map, tiles);
    expect(session.activateSwitch(doorRef)).toBe(true);
    expect(getStack(session.getSnapshot().map, 1, 0, 0).map((p) => p.tileId)).toEqual([
      "slab",
      "door-tall",
    ]);
  });

  it("refuses out of reach", () => {
    let map = mapWithSwitchable("door-closed");
    map = replaceStack(map, 2, 0, 0, [{ tileId: "grass" }, { tileId: "door-closed" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
    const session = new GameSession(map, tiles);
    expect(session.activateSwitch({ x: 2, y: 0, z: 0, stackIndex: 1 })).toBe(false);
  });

  it("refuses while a pushed object is still travelling", () => {
    let map = mapWithSwitchable("door-closed");
    map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }, { tileId: "crate" }]);
    map = replaceStack(map, 0, 2, 0, [{ tileId: "grass" }]);
    const session = new GameSession(map, tiles);
    expect(session.push({ x: 0, y: 1, z: 0, stackIndex: 1 })).toBe(true);
    expect(session.activateSwitch(doorRef)).toBe(false);
  });

  it("refuses a buried switchable object", () => {
    let map = mapWithSwitchable("door-closed");
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "door-closed" },
      { tileId: "slab" },
    ]);
    const session = new GameSession(map, tiles);
    expect(session.activateSwitch({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(false);
  });
});

describe("a step never crosses a sealed floor plane", () => {
  const body = tilesById.dwarf!;
  const person = tilesById.player!;
  const halfBlockUnderFloor = (): MapFile => {
    let map = emptyMap();
    map = replaceStack(map, 0, 0, -1, [{ tileId: "slab" }, { tileId: "dwarf" }]);
    map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 1, 0, -1, [{ tileId: "grass" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
    return map;
  };
  const from = { x: 0, y: 0, z: -1, stackIndex: 1 };

  it("keeps a body on a half-block under the floor from stepping up onto it", () => {
    const check = canWalk(halfBlockUnderFloor(), from, "e", body, tilesById);
    expect(check).toEqual({ ok: true, to: { x: 1, y: 0, z: -1 } });
  });

  it("keeps a person under it too", () => {
    let map = halfBlockUnderFloor();
    map = replaceStack(map, 0, 0, -1, [{ tileId: "slab" }, { tileId: "player" }]);
    const check = canWalk(map, from, "e", person, tilesById);
    expect(check).toEqual({ ok: true, to: { x: 1, y: 0, z: -1 } });
  });

  it("climbs out of a hole whose column is open above", () => {
    let map = halfBlockUnderFloor();
    map = replaceStack(map, 0, 0, 0, []);
    const check = canWalk(map, from, "e", body, tilesById);
    expect(check).toEqual({ ok: true, to: { x: 1, y: 0, z: 0 } });
  });

  it("refuses to step down through a floor onto a half-block under it", () => {
    let map = emptyMap();
    map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "dwarf" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "wall" }]);
    map = replaceStack(map, 1, 0, -1, [{ tileId: "slab" }]);
    const at = { x: 0, y: 0, z: 0, stackIndex: 1 };
    expect(canWalk(map, at, "e", body, tilesById).ok).toBe(false);

    map = replaceStack(map, 1, 0, 0, []);
    expect(canWalk(map, at, "e", body, tilesById)).toEqual({
      ok: true,
      to: { x: 1, y: 0, z: -1 },
    });
  });

  it("refuses to drop through an upper floor onto what stands under it", () => {
    let map = emptyMap();
    map = replaceStack(map, 0, 0, 1, [{ tileId: "roof" }, { tileId: "dwarf" }]);
    map = replaceStack(map, 1, 0, 1, [{ tileId: "roof" }, { tileId: "wall" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "slab" }]);
    const at = { x: 0, y: 0, z: 1, stackIndex: 1 };
    expect(canWalk(map, at, "e", body, tilesById).ok).toBe(false);

    map = replaceStack(map, 1, 0, 1, []);
    expect(canWalk(map, at, "e", body, tilesById)).toEqual({
      ok: true,
      to: { x: 1, y: 0, z: 0 },
    });
  });
});

describe("the snapshots of the actors a filter keeps", () => {
  it("are the ones actorSnapshots would have kept, in the same order", () => {
    let map = mapWithPlayer({ x: 0, y: 0 });
    for (let x = -6; x <= 6; x++) {
      for (let y = -6; y <= 6; y++) {
        if (x !== 0 || y !== 0) map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
      }
    }
    const session = new GameSession(map, tiles);
    ["a", "b", "c", "d", "e"].forEach((id, i) => {
      session.spawn(id, { at: { x: i - 2, y: 3, z: 0 } });
    });
    const keep = (id: string, at: { x: number; y: number }) => id === "c" || at.x > 0;

    const everybody = session.actorSnapshots();
    const kept = session.actorSnapshotsWhere(keep);
    expect(kept).toEqual(everybody.filter((snapshot) => keep(snapshot.id, snapshot)));
    expect(kept.map((snapshot) => snapshot.id)).toEqual(["c", "d", "e"]);
  });
});
