import { describe, expect, it } from "vitest";
import { resolveTeleport } from "../lib/interactions";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { Direction, MapFile, PlacedTile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { canTeleportFrom, reachableTeleportAt } from "./affordances";
import { TICK_MS, WALK_DURATION_MS } from "./constants";
import { GameSession } from "./GameSession";

/** Ticks a started walk needs to reach its destination and commit. */
const TICKS_PER_STEP = Math.ceil(WALK_DURATION_MS / TICK_MS) + 1;

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

function directionalTile(id: string, extra: Record<string, unknown> = {}) {
  const frames = [
    {
      sprite: {
        tilesetId: "basic",
        rect: { x: 0, y: 0, w: 1, h: 1 },
        base: { x: 0, y: 0 },
      },
      durationMs: 200,
    },
  ];
  return normalizeTileDef({
    id,
    name: id,
    height: 4,
    directional: true,
    attributes: {},
    variants: { n: frames, e: frames, s: frames, w: frames },
    ...extra,
  });
}

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "wall", height: 4 }),
  tile({ id: "crate", height: 2, affectedByGravity: true }),
  directionalTile("player", { affectedByGravity: true, walkable: false }),
  directionalTile("deer", {
    actor: true,
    affectedByGravity: true,
    walkable: false,
  }),
  // A body somebody else can shove, which is what the authored player tile is.
  directionalTile("shovable", {
    actor: true,
    affectedByGravity: true,
    walkable: false,
    interactions: { push: { climb: "half", moveOnTileIds: [] } },
  }),
  // A pad you walk onto. Flat, so it neither buries what is under it nor stops
  // anybody standing on it.
  tile({
    id: "pad",
    height: 0,
    interactions: {
      teleport: { trigger: "step", destination: { kind: "absolute" } },
    },
  }),
  // The doorway: pressed from the next square over.
  tile({
    id: "portal",
    height: 4,
    interactions: {
      teleport: {
        actionName: "Enter",
        trigger: "interact",
        destination: { kind: "absolute" },
      },
    },
  }),
  // Intangible, like the real one: it marks the top of a climb and holds
  // nobody up, which is the whole point of the case below.
  tile({ id: "ladder-top", height: 2, intangible: true }),
  // A delta that travels nowhere, which reads as unauthored rather than as a
  // rung that takes a press and does nothing.
  tile({
    id: "still",
    height: 0,
    interactions: {
      teleport: {
        trigger: "interactOver",
        destination: { kind: "relative", delta: { x: 0, y: 0, z: 0 } },
      },
    },
  }),
  // The motivating case for `relative` — one rung tile, every ladder in the
  // world, each carrying its own climb on its placement.
  tile({
    id: "ladder",
    height: 0,
    interactions: {
      teleport: {
        actionName: "Climb",
        trigger: "interactOver",
        destination: { kind: "relative", delta: { x: 0, y: 0, z: 1 } },
      },
    },
  }),
];

const tilesById = tilesByIdFromList(tiles);

function stackIds(map: MapFile, x: number, y: number, z = 0): string[] {
  return getStack(map, x, y, z).map((p) => p.tileId);
}

function run(session: GameSession, ticks: number) {
  for (let i = 0; i < ticks; i++) session.tick(TICK_MS);
}

/** Walk exactly one cell, releasing input so the commit does not chain. */
function step(session: GameSession, direction: Direction) {
  session.setInput({ directions: [direction] });
  session.tick(TICK_MS);
  session.setInput({ directions: [] });
  run(session, TICKS_PER_STEP);
}

function whereIs(map: MapFile, tileId: string) {
  for (const [key, stacks] of Object.entries(map.levels)) {
    for (const cells of Object.values(stacks)) {
      for (const [cell, stack] of Object.entries(cells)) {
        const index = stack.findIndex((p) => p.tileId === tileId);
        if (index < 0) continue;
        const [x, y] = cell.split(",").map(Number);
        return { x: x!, y: y!, z: Number(key), stackIndex: index };
      }
    }
  }
  return null;
}

describe("resolveTeleport", () => {
  const at = { x: 4, y: 4, z: 0 };

  it("reads an absolute placement as the cell itself", () => {
    const placed: PlacedTile = {
      tileId: "portal",
      teleportTo: { x: 9, y: 1, z: 2 },
    };
    expect(resolveTeleport(placed, tilesById.portal, at)?.to).toEqual({
      x: 9,
      y: 1,
      z: 2,
    });
  });

  it("counts the tile's delta from the placement, not from the traveller", () => {
    expect(resolveTeleport({ tileId: "ladder" }, tilesById.ladder, at)?.to).toEqual(
      { x: 4, y: 4, z: 1 },
    );
    // The same tile, dropped somewhere else, makes the same journey. This is
    // the whole reason a ladder's delta belongs to the def.
    expect(
      resolveTeleport({ tileId: "ladder" }, tilesById.ladder, { x: -3, y: 8, z: 2 })
        ?.to,
    ).toEqual({ x: -3, y: 8, z: 3 });
  });

  it("ignores a destination written on a relative placement", () => {
    // The arms do not overlap: a ladder reads its tile and nothing else, so a
    // stale cell left on a placement cannot quietly redirect it.
    const placed: PlacedTile = {
      tileId: "ladder",
      teleportTo: { x: 99, y: 99, z: 5 },
    };
    expect(resolveTeleport(placed, tilesById.ladder, at)?.to).toEqual({
      x: 4,
      y: 4,
      z: 1,
    });
  });

  it("is nothing without the half that carries the numbers", () => {
    // A tile that does not teleport, however the placement is written.
    expect(
      resolveTeleport(
        { tileId: "grass", teleportTo: { x: 1, y: 1, z: 0 } },
        tilesById.grass,
        at,
      ),
    ).toBeNull();
    // An absolute tile with nothing written on the slot.
    expect(resolveTeleport({ tileId: "portal" }, tilesById.portal, at)).toBeNull();
  });

  it("refuses a destination off the ends of the world rather than clamping", () => {
    expect(
      resolveTeleport({ tileId: "ladder" }, tilesById.ladder, { x: 4, y: 4, z: 8 }),
    ).toBeNull();
  });

  it("refuses a trip that ends where it started", () => {
    expect(
      resolveTeleport({ tileId: "still" }, tilesById.still, at),
    ).toBeNull();
  });
});

describe("reachableTeleportAt", () => {
  /** A portal at (1,0) with the traveller standing at (0,0). */
  function doorway(trigger: "interact" | "interactOver") {
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e" },
    ]);
    // The portal is absolute and carries its target; the ladder is relative and
    // carries nothing, which is the difference under test everywhere else.
    const placed: PlacedTile =
      trigger === "interact"
        ? { tileId: "portal", teleportTo: { x: 5, y: 5, z: 0 } }
        : { tileId: "ladder" };
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, placed]);
    return map;
  }

  it("offers an `interact` portal from the next square over", () => {
    const map = doorway("interact");
    const ref = { x: 1, y: 0, z: 0, stackIndex: 1 };
    expect(
      reachableTeleportAt(map, tilesById, { x: 0, y: 0, z: 0 }, ref)?.to,
    ).toEqual({ x: 5, y: 5, z: 0 });
    // Diagonally is not "squarely beside", exactly as it is not for a switch.
    expect(
      reachableTeleportAt(map, tilesById, { x: 0, y: 1, z: 0 }, ref),
    ).toBeNull();
  });

  it("offers an `interactOver` ladder only from its own cell", () => {
    const map = doorway("interactOver");
    const ref = { x: 1, y: 0, z: 0, stackIndex: 1 };
    expect(
      reachableTeleportAt(map, tilesById, { x: 0, y: 0, z: 0 }, ref),
    ).toBeNull();
    expect(
      reachableTeleportAt(map, tilesById, { x: 1, y: 0, z: 0 }, ref),
    ).not.toBeNull();
  });

  /**
   * The floor of slack a press is allowed (see `INTERACT_LEVEL_SLACK`) is not a
   * licence to press through rock. A doorway in the cellar is a doorway you
   * open from the cellar.
   */
  it("refuses an `interact` portal a floor down under solid ground", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
    map = replaceStack(map, 1, 0, -1, [
      { tileId: "grass" },
      { tileId: "portal", teleportTo: { x: 5, y: 5, z: 0 } },
    ]);
    const ref = { x: 1, y: 0, z: -1, stackIndex: 1 };
    expect(
      reachableTeleportAt(map, tilesById, { x: 0, y: 0, z: 0 }, ref),
    ).toBeNull();
  });

  /** And the same doorway with a hole in the floor above it. */
  it("offers one a floor down where that ground is missing", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, -1, [
      { tileId: "grass" },
      { tileId: "portal", teleportTo: { x: 5, y: 5, z: 0 } },
    ]);
    const ref = { x: 1, y: 0, z: -1, stackIndex: 1 };
    expect(
      reachableTeleportAt(map, tilesById, { x: 0, y: 0, z: 0 }, ref)?.to,
    ).toEqual({ x: 5, y: 5, z: 0 });
  });

  it("never offers a `step` pad, which answers to no press", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "pad", teleportTo: { x: 5, y: 5, z: 0 } },
    ]);
    expect(
      reachableTeleportAt(map, tilesById, { x: 0, y: 0, z: 0 }, {
        x: 1,
        y: 0,
        z: 0,
        stackIndex: 0,
      }),
    ).toBeNull();
  });

  it("refuses a far end with no room for the traveller", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "portal", teleportTo: { x: 5, y: 5, z: 0 } },
    ]);
    map = replaceStack(map, 5, 5, 0, [{ tileId: "wall" }]);
    const ref = { x: 1, y: 0, z: 0, stackIndex: 1 };
    const actor = { x: 0, y: 0, z: 0 };
    // The trip is authored — it is the far end that refuses it.
    expect(reachableTeleportAt(map, tilesById, actor, ref)).not.toBeNull();
    expect(
      canTeleportFrom(map, tilesById, actor, ref, tilesById.player!),
    ).toBe(false);
  });

  /**
   * The whole reason a person passes through a person: one player at the top of
   * a ladder must not be a lid on it, and a rung is the one place in the world
   * where waiting for somebody to move is the only way past.
   */
  it("sends a person to a far end somebody is already standing on", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "portal", teleportTo: { x: 5, y: 5, z: 0 } },
    ]);
    map = replaceStack(map, 5, 5, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "s", owner: "a" },
    ]);
    const ref = { x: 1, y: 0, z: 0, stackIndex: 1 };
    const actor = { x: 0, y: 0, z: 0 };
    expect(
      canTeleportFrom(map, tilesById, actor, ref, tilesById.player!),
    ).toBe(true);
    // A deer that walks onto the same pad is stopped by them, as it is by
    // anything else standing in the way.
    expect(canTeleportFrom(map, tilesById, actor, ref, tilesById.deer!)).toBe(
      false,
    );
  });
});

describe("GameSession teleport", () => {
  /** A world with the player beside a portal, and floor at the far end. */
  function world(portal: PlacedTile) {
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, portal]);
    map = replaceStack(map, 5, 5, 0, [{ tileId: "grass" }]);
    return map;
  }

  it("moves the body and leaves the cell it came from", () => {
    const session = new GameSession(
      world({ tileId: "portal", teleportTo: { x: 5, y: 5, z: 0 } }),
      tiles,
    );
    expect(session.activateTeleport({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(
      true,
    );
    expect(stackIds(session.getMap(), 0, 0)).toEqual(["grass"]);
    expect(stackIds(session.getMap(), 5, 5)).toEqual(["grass", "player"]);
  });

  it("keeps the traveller's facing", () => {
    const session = new GameSession(
      world({ tileId: "portal", teleportTo: { x: 5, y: 5, z: 0 } }),
      tiles,
    );
    session.activateTeleport({ x: 1, y: 0, z: 0, stackIndex: 1 });
    const landed = getStack(session.getMap(), 5, 5, 0)[1];
    expect(landed?.direction).toBe("e");
  });

  it("refuses when the far end has no room", () => {
    let map = world({ tileId: "portal", teleportTo: { x: 5, y: 5, z: 0 } });
    map = replaceStack(map, 5, 5, 0, [{ tileId: "wall" }]);
    const session = new GameSession(map, tiles);
    expect(session.activateTeleport({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(
      false,
    );
    expect(stackIds(session.getMap(), 0, 0)).toEqual(["grass", "player"]);
  });

  it("is what a plain tap on a portal runs", () => {
    const session = new GameSession(
      world({ tileId: "portal", teleportTo: { x: 5, y: 5, z: 0 } }),
      tiles,
    );
    expect(session.interact({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(true);
    expect(stackIds(session.getMap(), 5, 5)).toEqual(["grass", "player"]);
  });

  it("reports the trip once, for a client to throw its guess away on", () => {
    const session = new GameSession(
      world({ tileId: "portal", teleportTo: { x: 5, y: 5, z: 0 } }),
      tiles,
    );
    session.activateTeleport({ x: 1, y: 0, z: 0, stackIndex: 1 });
    expect(session.drainTeleports()).toEqual(["local"]);
    expect(session.drainTeleports()).toEqual([]);
  });

  it("climbs a relative ladder from the cell it is authored in", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "ladder" },
      { tileId: "player", direction: "s" },
    ]);
    map = replaceStack(map, 0, 0, 1, [{ tileId: "grass" }]);
    const session = new GameSession(map, tiles);
    expect(session.activateTeleport({ x: 0, y: 0, z: 0, stackIndex: 1 })).toBe(
      true,
    );
    expect(stackIds(session.getMap(), 0, 0, 1)).toEqual(["grass", "player"]);
  });
});

describe("stepping onto a pad", () => {
  /** Pad one cell east of the player, with floor at the far end. */
  function padWorld(to: { x: number; y: number; z: number }, tileId = "player") {
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId, direction: "e" },
    ]);
    // Every map needs exactly one player tile, so a deer's world still parks one.
    if (tileId !== "player") {
      map = replaceStack(map, 9, 9, 0, [
        { tileId: "grass" },
        { tileId: "player", direction: "s" },
      ]);
    }
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "pad", teleportTo: to }]);
    map = replaceStack(map, to.x, to.y, to.z, [{ tileId: "grass" }]);
    return map;
  }

  it("sends whoever lands on it, with nothing pressed", () => {
    const session = new GameSession(padWorld({ x: 5, y: 5, z: 0 }), tiles);
    step(session, "e");
    expect(stackIds(session.getMap(), 1, 0)).toEqual(["grass", "pad"]);
    expect(stackIds(session.getMap(), 5, 5)).toEqual(["grass", "player"]);
  });

  it("sends a creature too — a body is a body", () => {
    const session = new GameSession(padWorld({ x: 5, y: 5, z: 0 }, "deer"), tiles, {
      actorIds: [],
    });
    expect(whereIs(session.getMap(), "deer")).toMatchObject({ x: 0, y: 0 });
    // Driven straight rather than through a brain: what is under test is the
    // pad, and a wandering mind would decide when — or whether — to step on it.
    expect(session.requestStep("npc:0,0,0,1", "e")).toBe("started");
    run(session, TICKS_PER_STEP);
    expect(whereIs(session.getMap(), "deer")).toMatchObject({ x: 5, y: 5 });
  });

  it("does not chain: arriving by teleport is not arriving by step", () => {
    // Two pads pointing at each other. Landing on the first sends you to the
    // second, and there the trip ends — otherwise this ticks for ever.
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "pad", teleportTo: { x: 5, y: 5, z: 0 } },
    ]);
    map = replaceStack(map, 5, 5, 0, [
      { tileId: "grass" },
      { tileId: "pad", teleportTo: { x: 1, y: 0, z: 0 } },
    ]);
    const session = new GameSession(map, tiles);
    step(session, "e");
    expect(whereIs(session.getMap(), "player")).toMatchObject({ x: 5, y: 5 });
    run(session, 20);
    expect(whereIs(session.getMap(), "player")).toMatchObject({ x: 5, y: 5 });
  });

  it("leaves them standing there when the far end is full", () => {
    let map = padWorld({ x: 5, y: 5, z: 0 });
    map = replaceStack(map, 5, 5, 0, [{ tileId: "wall" }]);
    const session = new GameSession(map, tiles);
    step(session, "e");
    expect(whereIs(session.getMap(), "player")).toMatchObject({ x: 1, y: 0 });
  });
});

describe("being shoved onto a pad", () => {
  /**
   * Player at the origin, a shovable body beside them, a pad beyond it. The
   * shove is the whole of the motion here — nobody walks anywhere.
   */
  function shoveWorld(to: { x: number; y: number; z: number }) {
    let map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "e" },
    ]);
    map = replaceStack(map, 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "shovable", direction: "e" },
    ]);
    map = replaceStack(map, 2, 0, 0, [
      { tileId: "grass" },
      { tileId: "pad", teleportTo: to },
    ]);
    return replaceStack(map, to.x, to.y, to.z, [{ tileId: "grass" }]);
  }

  it("sends the body that was pushed onto it", () => {
    const session = new GameSession(shoveWorld({ x: 5, y: 5, z: 0 }), tiles);
    expect(session.push({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(true);
    expect(stackIds(session.getMap(), 2, 0)).toEqual(["grass", "pad"]);
    expect(whereIs(session.getMap(), "shovable")).toMatchObject({ x: 5, y: 5 });
  });
});

/**
 * The shape a ladder has to be authored in: rungs on the floor below, and a
 * floor of its own under the intangible top. The top is scenery hanging in the
 * cell, not a surface — a landing needs something solid, exactly as it does
 * anywhere else, which is what keeps an intangible floor readable as a hole.
 */
describe("climbing onto an intangible ladder top", () => {
  function ladderColumn(top: { tileId: string }[]) {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "ladder" },
      { tileId: "player", direction: "s" },
    ]);
    return replaceStack(map, 0, 0, 1, top);
  }

  const flooredTop = [{ tileId: "grass" }, { tileId: "ladder-top" }];
  const floorlessTop = [{ tileId: "ladder-top" }];

  it("offers the climb", () => {
    const session = new GameSession(ladderColumn(flooredTop), tiles);
    expect(session.canTeleport({ x: 0, y: 0, z: 0, stackIndex: 1 })).toBe(true);
  });

  it("climbs, and stays up there", () => {
    const session = new GameSession(ladderColumn(flooredTop), tiles);
    expect(session.activateTeleport({ x: 0, y: 0, z: 0, stackIndex: 1 })).toBe(
      true,
    );
    run(session, 30);
    expect(whereIs(session.getMap(), "player")).toMatchObject({
      x: 0,
      y: 0,
      z: 1,
    });
  });

  it("drops back down through a top with no floor under it", () => {
    const session = new GameSession(ladderColumn(floorlessTop), tiles);
    expect(session.activateTeleport({ x: 0, y: 0, z: 0, stackIndex: 1 })).toBe(
      true,
    );
    run(session, 30);
    expect(whereIs(session.getMap(), "player")).toMatchObject({ z: 0 });
  });

  /**
   * The case the cell-sharing rule was written for. A ladder has one top, so a
   * body resting on it used to close the only route between two floors for
   * however long its owner felt like standing there.
   */
  it("climbs past somebody already standing on the top", () => {
    const session = new GameSession(ladderColumn(flooredTop), tiles, {
      actorIds: ["up-there", "climber"],
    });
    const rung = { x: 0, y: 0, z: 0, stackIndex: 1 };

    // Both start on the rung — the first thing the rule has to allow.
    expect(session.activateTeleport(rung, "up-there")).toBe(true);
    run(session, 30);

    expect(session.canTeleport(rung, "climber")).toBe(true);
    expect(session.activateTeleport(rung, "climber")).toBe(true);
    run(session, 30);

    const upstairs = getStack(session.getMap(), 0, 0, 1);
    expect(upstairs.map((placed) => placed.owner)).toEqual([
      undefined,
      undefined,
      "up-there",
      "climber",
    ]);
  });
});
