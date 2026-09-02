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
import { HEIGHT_PER_LEVEL, normalizeTileDef } from "../lib/types";
import {
  canReplaceStack,
  fitsTile,
  tilesByIdFromList,
} from "../lib/validation";
import {
  FALL_MS_PER_HEIGHT,
  PUSH_STEP_MS,
  WALK_DURATION_MS,
} from "./constants";
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
  // A body that is not a person. Full height and non-walkable exactly as the
  // player tile is, so a test that distinguishes the two is distinguishing who
  // they are rather than what shape they are.
  tile({
    id: "deer",
    height: 4,
    walkable: false,
    actor: true,
    affectedByGravity: true,
  }),
  tile({ id: "tree", height: 4, walkable: false }),
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

  it("rejects height-adding tiles on a stack that already reaches the next level", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "wall" }]);
    expect(fitsTile(map, 0, 0, 0, tilesById.slab!, tilesById).ok).toBe(false);
    expect(fitsTile(map, 0, 0, 0, tilesById.wall!, tilesById).ok).toBe(false);
  });

  it("allows height-0 tiles on a full or overflowing stack", () => {
    const full = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "wall" }]);
    expect(fitsTile(full, 0, 0, 0, tilesById.grass!, tilesById).ok).toBe(true);
    expect(fitsTile(full, 0, 0, 0, tilesById.roof!, tilesById).ok).toBe(true);

    const overflow = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "slab" },
      { tileId: "wall" },
    ]);
    expect(fitsTile(overflow, 0, 0, 0, tilesById.grass!, tilesById).ok).toBe(
      true,
    );
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

/**
 * The rule in one place: a body is terrain to nobody, and a cell it is in is
 * closed to everything except another person. @see docs/notes.md
 */
describe("a body is not terrain", () => {
  /** The grass strip with `owner`'s body standing on the cell at `x`. */
  function withBodyAt(x: number, tileId = "player", owner = "a"): MapFile {
    let map = emptyMap();
    for (let i = 0; i < 3; i++) {
      map = replaceStack(map, i, 0, 0, [{ tileId: "grass" }]);
    }
    return replaceStack(map, x, 0, 0, [
      { tileId: "grass" },
      { tileId, direction: "s", owner },
    ]);
  }

  it("weighs nothing in the stack it stands in", () => {
    const map = withBodyAt(0);
    expect(stackHeight(getStack(map, 0, 0, 0), tilesById)).toBe(0);
  });

  it("still weighs its full height as an authored marker", () => {
    // No owner: the `player` tile in a map an author saved is a spawn marker,
    // and an editor that let things stack through it would be lying.
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
    // Both feet on the grass, not one pair on the other's head.
    expect(standingAbs(map, 0, 0, 0, 1, tilesById)).toBe(0);
    expect(standingAbs(map, 0, 0, 0, 2, tilesById)).toBe(0);
  });

  it("does not hold up a body above it in the stack", () => {
    let map = replaceStack(emptyMap(), 0, 0, 1, [
      { tileId: "player", direction: "s", owner: "a" },
    ]);
    map = appendTile(map, 0, 0, 1, {
      tileId: "player",
      direction: "s",
      owner: "b",
    });
    // Nothing under either of them: the second must fall with the first rather
    // than treating the first as a floor.
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
    const walk = canWalk(
      map,
      { x: 0, y: 0, z: 0, stackIndex: 1 },
      "e",
      tilesById.deer!,
      tilesById,
    );
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
    // The editor's brush, a shoved crate and a dropped item all ask this.
    expect(fitsTile(map, 0, 0, 0, tilesById.crate!, tilesById).ok).toBe(false);
    expect(fitsTile(map, 0, 0, 0, tilesById.wall!, tilesById).ok).toBe(false);
  });

  it("lets a flat tile be laid under it", () => {
    // No volume, nothing to clash with — a rug still goes down under a person.
    const map = withBodyAt(0);
    expect(fitsTile(map, 0, 0, 0, tilesById.roof!, tilesById).ok).toBe(true);
  });

  it("does not occupy the level it overflows into", () => {
    // A body standing head-and-shoulders into the level above used to read as
    // "level above is occupied", which refused the person joining them on the
    // slab below for a reason nothing on screen could explain.
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "slab" }]);
    map = replaceStack(map, 0, 0, 1, [
      { tileId: "player", direction: "s", owner: "a" },
    ]);
    // slab(1) + player(2) = 3, which needs the level above to be free of
    // anything an author put there — and a body is not that.
    expect(
      fitsTile(map, 0, 0, 0, tilesById.player!, tilesById, {
        throughPlayers: true,
      }).ok,
    ).toBe(true);
  });

  it("still stops an object being built through its legs", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "slab" }]);
    map = replaceStack(map, 0, 0, 1, [
      { tileId: "player", direction: "s", owner: "a" },
    ]);
    // The same overflow, asked by something that is not a person.
    expect(fitsTile(map, 0, 0, 0, tilesById.wall!, tilesById).ok).toBe(false);
  });

  it("draws the second body at the first one's feet, not on its head", () => {
    // The symptom this rule exists to prevent, at the number every renderer
    // reads: `elevationAt` is what decides where a placement's sprite sits, and
    // a body that counted would put the second person's feet one whole level up.
    const stack = [
      { tileId: "grass" },
      { tileId: "player", direction: "s" as const, owner: "a" },
      { tileId: "player", direction: "s" as const, owner: "b" },
    ];
    expect(elevationAt(stack, 1, tilesById)).toBe(0);
    expect(elevationAt(stack, 2, tilesById)).toBe(0);
  });

  it("does not lift the scenery drawn above it either", () => {
    // A running total that stopped at a body would raise everything after it.
    const stack = [
      { tileId: "slab" },
      { tileId: "player", direction: "s" as const, owner: "a" },
      { tileId: "roof" },
    ];
    expect(elevationAt(stack, 2, tilesById)).toBe(2);
  });

  it("weighs nothing as a single placement", () => {
    // The one definition every elevation walk in the codebase now goes through.
    const marker = { tileId: "player", direction: "s" as const };
    const body = { tileId: "player", direction: "s" as const, owner: "a" };
    expect(terrainHeight(marker, tilesById)).toBe(4);
    expect(terrainHeight(body, tilesById)).toBe(0);
  });

  it("is nothing to land on", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 1, [
      { tileId: "player", direction: "s", owner: "a" },
    ]);
    // Falling from level 2, the only floor is the grass — not the head of the
    // person standing a level below it.
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
      canReplaceStack(
        map,
        0,
        0,
        0,
        [{ tileId: "wall" }, { tileId: "slab" }],
        tilesById,
      ).ok,
    ).toBe(false);
  });

  /**
   * The one measurement a body is part of: this asks what a tile may *become*
   * under whoever is standing on it, not what may walk in. @see the doc on
   * `canReplaceStack` itself.
   */
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
          [
            { tileId: "grass" },
            { tileId: "door-tall" },
            body("a"),
            body("b"),
          ],
          tilesById,
        ).ok,
      ).toBe(false);
    });

    it("lets a flat tile swap under a crowd", () => {
      // A plate pressing, a signal firing, something decaying: the scenery is
      // the same height afterwards, and two people standing on it are side by
      // side rather than one on the other's shoulders. Summing them would put
      // four units of person in a two-unit level and jam the plate.
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
      // slab(1) + player(2) = 3, which overflows and needs the level above
      // free — the same answer a lone body has always got here.
      let map = replaceStack(emptyMap(), 0, 0, 0, [
        { tileId: "grass" },
        body("a"),
      ]);
      map = replaceStack(map, 0, 0, 1, [{ tileId: "roof" }]);
      expect(
        canReplaceStack(
          map,
          0,
          0,
          0,
          [{ tileId: "slab" }, body("a")],
          tilesById,
        ).ok,
      ).toBe(false);
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
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "door-ajar" },
    ]);
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

  /**
   * Why a level is four units rather than two.
   *
   * An interior is exactly one storey tall, so a body as tall as a storey has
   * its head in the floor above the moment anything raises it — which is what
   * made every chair and stool in every building unclimbable. A person shorter
   * than the storey has room for one unit under their feet, and exactly one:
   * the seat is the whole indoor vocabulary, and a half-level crate is still
   * something you walk around.
   */
  it("stands on a seat under a roof, but not on a half-level crate", () => {
    // The numbers are the point, so they are written out: a storey is four, a
    // body is one short of it, and a seat is what fits in the difference.
    expect(HEIGHT_PER_LEVEL).toBe(4);
    const person = tile({ id: "person", height: 3 });
    const seat = tile({ id: "seat", height: 1 });
    const crate = tile({ id: "crate", height: 2 });
    const indoors = tilesByIdFromList([...tiles, person, seat, crate]);

    const room = (furniture: string): MapFile => {
      let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
      map = appendTile(map, 0, 0, 0, { tileId: "person" });
      map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: furniture }]);
      // The floor of the storey above — the ceiling of this one.
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

    // And the mechanism, rather than the outcome: a body as tall as the storey
    // cannot stand on the seat either. That was every body in the game.
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
    // Player on z=1 floor (abs 4); dest column has slab top at abs 2 on z=0.
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

    // On the first ramp, climb onto half + ramp (abs 2 → 4).
    map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 0, 0, 0, [
      { tileId: "ramp", direction: "s" },
      { tileId: "player", direction: "n" },
    ]);
    const onRamp = requireSinglePlayer(map);
    expect(
      standingAbs(map, onRamp.x, onRamp.y, onRamp.z, onRamp.stackIndex, tilesById),
    ).toBe(2);

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

  it("climbs a plaster ladder onto overflowing stacks (height 4 → 6)", () => {
    // Tops at abs 2, 4, 6 with half-height plaster.
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
      4,
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
    expect(snap.self.x).toBe(1);
    expect(
      standingAbs(
        snap.map,
        snap.self.x,
        snap.self.y,
        snap.self.z,
        snap.self.stackIndex,
        tilesById,
      ),
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
    expect(snap.self.walk).not.toBeNull();
    expect(snap.self.x).toBe(0);

    // Finish walk
    let elapsed = 1000 / 30;
    while (elapsed < WALK_DURATION_MS + 50) {
      session.tick(1000 / 30);
      elapsed += 1000 / 30;
    }
    snap = session.getSnapshot();
    expect(snap.self.x).toBe(1);
    expect(snap.self.y).toBe(0);
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
      isSupported(
        snap.map,
        snap.self.x,
        snap.self.y,
        snap.self.z,
        snap.self.stackIndex,
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
    expect(snap.self.walk).toBeNull();
    expect(snap.self.x).toBe(0);
    expect(snap.self.direction).toBe("e");
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
    expect(snap.self.fall).toBeNull();
    // Slid onto grass east of the tree.
    expect(snap.self).toMatchObject({ x: 1, y: 0, z: 0 });
  });
});

/** Grass rows y=0 and y=1, player at (0,0) facing east, crate at (crateX,0). */
function mapWithCrate(crateX: number, width = 5): MapFile {
  let map = emptyMap();
  for (let x = 0; x < width; x++) {
    map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, x, 1, 0, [{ tileId: "grass" }]);
  }
  map = replaceStack(map, 0, 0, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "e" },
  ]);
  map = replaceStack(map, crateX, 0, 0, [
    { tileId: "grass" },
    { tileId: "crate" },
  ]);
  return map;
}

/**
 * Whether a tap on an object would do anything, and what "reachable" means.
 *
 * These used to go through a hover the session held: the renderer reported what
 * the pointer was over and this re-validated it on read. The hover moved into
 * the renderer — where the pointer is — and what was always being tested here is
 * the rule underneath it, so they ask it directly now.
 */
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

  /**
   * The floor of slack is not a hole in the floor. Asked of the session rather
   * than of the list because this is the half that has to hold: a client that
   * offered the row anyway must still be refused when it acts on it.
   */
  it("ignores a switch a floor below the ground it is standing on", () => {
    let map = mapWithCrate(3);
    map = replaceStack(map, 1, 0, -1, [
      { tileId: "grass" },
      { tileId: "door-closed" },
    ]);
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
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "door-closed" },
    ]);
    const session = new GameSession(map, tiles);
    expect(session.canInteract(crateRef(1))).toBe(true);
  });

  /**
   * Asked afresh every time rather than answered once. The pointer does not
   * move when the player walks, so an answer cached on the way in would keep an
   * outline alive around something now out of reach.
   */
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

  /** Drive fixed ticks until a pushed object has finished travelling. */
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
    expect(getStack(map, 2, 0, 0).map((p) => p.tileId)).toEqual([
      "grass",
      "crate",
    ]);
  });

  it("pushes away from the player, whichever side they stand on", () => {
    // Player east of the crate this time — it should travel west, not east.
    let map = mapWithCrate(1);
    map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 2, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "w" },
    ]);
    const session = new GameSession(map, tiles);
    expect(session.push(crateRef(1))).toBe(true);
    runSlide(session);

    expect(
      getStack(session.getSnapshot().map, 0, 0, 0).map((p) => p.tileId),
    ).toEqual(["grass", "crate"]);
  });

  it("turns the player toward the object they shove", () => {
    let map = mapWithCrate(3);
    // Crate south of the player, who starts facing east.
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
    expect(
      getStack(session.getSnapshot().map, 2, 0, -1).map((p) => p.tileId),
    ).toEqual(["grass", "crate"]);
  });

  it("refuses an object two floors away", () => {
    let map = mapWithCrate(3);
    map = replaceStack(map, 1, 0, 2, [{ tileId: "grass" }, { tileId: "crate" }]);
    const session = new GameSession(map, tiles);
    expect(session.push({ x: 1, y: 0, z: 2, stackIndex: 1 })).toBe(false);
  });

  /**
   * A shove moves the column, so the thing riding the crate arrives with it
   * rather than being left hanging where the crate used to be.
   */
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
    expect(getStack(snap.map, 2, 0, 0).map((p) => p.tileId)).toEqual([
      "grass",
      "crate",
      "slab",
    ]);
    // Both travelling tiles are named, so the sprite for the rider slides with
    // the crate rather than snapping to the new cell.
    expect(snap.self.slide?.object).toEqual({ x: 2, y: 0, z: 0, stackIndex: 1 });
    expect(snap.self.slide?.count).toBe(2);
  });

  /**
   * The room asked for is the whole column's, not the crate's: a crate alone
   * clears the gap under the floor above, and the same crate with a wall on it
   * does not.
   */
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
    expect(
      getStack(session.getSnapshot().map, 1, 0, 0).map((p) => p.tileId),
    ).toEqual(["grass", "crate"]);
  });

  it("pushes an object over a ledge down to the floor below", () => {
    let map = mapWithCrate(1);
    // Remove the ground east of the crate; leave a floor two levels down.
    map = replaceStack(map, 2, 0, 0, []);
    map = replaceStack(map, 2, 0, -1, [{ tileId: "grass" }]);
    const session = new GameSession(map, tiles);
    expect(session.push(crateRef(1))).toBe(true);
    runSlide(session);
    expect(
      getStack(session.getSnapshot().map, 2, 0, -1).map((p) => p.tileId),
    ).toEqual(["grass", "crate"]);
  });

  it("commits the move up front and slides only the sprite", () => {
    const session = new GameSession(mapWithCrate(1), tiles);
    session.push(crateRef(1));

    // The board is already settled on the frame the push starts; only the
    // animation is outstanding.
    const snap = session.getSnapshot();
    expect(getStack(snap.map, 1, 0, 0).map((p) => p.tileId)).toEqual(["grass"]);
    expect(getStack(snap.map, 2, 0, 0).map((p) => p.tileId)).toEqual([
      "grass",
      "crate",
    ]);
    expect(snap.self.slide).not.toBeNull();
    expect(snap.self.slide?.from).toEqual({ x: 1, y: 0, z: 0 });
    expect(snap.self.slide?.object).toEqual({ x: 2, y: 0, z: 0, stackIndex: 1 });
    expect(snap.self.slide?.count).toBe(1);
    expect(snap.self.slideProgress).toBe(0);

    runSlide(session);
    expect(session.getSnapshot().self.slide).toBeNull();
  });

  /**
   * The game server tells a continuing shove from a fresh one by identity, the
   * same way it does for a walk and a fall — so a slide rebuilt on every read
   * reads as a new push every tick, and every client redraws it from the start.
   * Progress lives beside the slide rather than inside it for exactly this
   * reason; putting it back is what this catches.
   */
  it("hands back the same slide while it runs", () => {
    const session = new GameSession(mapWithCrate(1), tiles);
    session.push(crateRef(1));

    const first = session.getSnapshot().self.slide;
    session.tick(1000 / 30);
    const second = session.getSnapshot().self.slide;

    expect(second).toBe(first);
    // And it is still advancing, so this is one live slide rather than a frozen
    // object that happens to compare equal.
    expect(session.getSnapshot().self.slideProgress).toBeGreaterThan(0);
  });

  it("lets the player follow straight into the cell the object left", () => {
    // Two stacked crates put the top of (1,0) out of climbing range; shoving
    // the upper one off drops it back within reach. A deferred commit swallows
    // the follow-up step for the whole slide even though the crate has visibly
    // gone, which is the stickiness this guards against.
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

    // Two cells away now — nothing a tap could do to it from here.
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
  /** Grass row, player at (0,0), switchable tile at (1,0). */
  function mapWithSwitchable(tileId: string): MapFile {
    let map = emptyMap();
    for (let x = 0; x < 3; x++) {
      map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
    }
    map = replaceStack(map, 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId }]);
    return map;
  }

  const doorRef = { x: 1, y: 0, z: 0, stackIndex: 1 };

  it("replaces the tile with its switch target", () => {
    const session = new GameSession(mapWithSwitchable("door-closed"), tiles);
    expect(session.activateSwitch(doorRef)).toBe(true);
    expect(
      getStack(session.getSnapshot().map, 1, 0, 0).map((p) => p.tileId),
    ).toEqual(["grass", "door-open"]);
  });

  it("toggles back when the target also has switch", () => {
    const session = new GameSession(mapWithSwitchable("door-closed"), tiles);
    expect(session.activateSwitch(doorRef)).toBe(true);
    expect(session.activateSwitch(doorRef)).toBe(true);
    expect(
      getStack(session.getSnapshot().map, 1, 0, 0).map((p) => p.tileId),
    ).toEqual(["grass", "door-closed"]);
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
    // slab(1)+switch(1)=2 → swapping in door-tall(2) overflows (3); roof above blocks.
    let map = mapWithSwitchable("switch-to-tall");
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "slab" },
      { tileId: "switch-to-tall" },
    ]);
    map = replaceStack(map, 1, 0, 1, [{ tileId: "roof" }]);
    const session = new GameSession(map, tiles);
    expect(session.activateSwitch(doorRef)).toBe(false);
    expect(
      getStack(session.getSnapshot().map, 1, 0, 0).map((p) => p.tileId),
    ).toEqual(["slab", "switch-to-tall"]);
  });

  it("allows a taller target when overflow headroom is free", () => {
    let map = mapWithSwitchable("switch-to-tall");
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "slab" },
      { tileId: "switch-to-tall" },
    ]);
    const session = new GameSession(map, tiles);
    expect(session.activateSwitch(doorRef)).toBe(true);
    expect(
      getStack(session.getSnapshot().map, 1, 0, 0).map((p) => p.tileId),
    ).toEqual(["slab", "door-tall"]);
  });

  it("refuses out of reach", () => {
    let map = mapWithSwitchable("door-closed");
    map = replaceStack(map, 2, 0, 0, [
      { tileId: "grass" },
      { tileId: "door-closed" },
    ]);
    // Move the adjacent door away — only the far one remains switchable.
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
    const session = new GameSession(map, tiles);
    expect(
      session.activateSwitch({ x: 2, y: 0, z: 0, stackIndex: 1 }),
    ).toBe(false);
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
    expect(
      session.activateSwitch({ x: 1, y: 0, z: 0, stackIndex: 1 }),
    ).toBe(false);
  });
});
