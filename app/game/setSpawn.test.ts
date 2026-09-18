import { describe, expect, it } from "vitest";
import { resolveSetSpawn } from "../lib/interactions";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { Direction, MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { canSetSpawnFrom, reachableSetSpawnAt } from "./affordances";
import { TICK_MS, WALK_DURATION_MS } from "./constants";
import { GameSession } from "./GameSession";

/**
 * A tile that moves where somebody comes back to.
 *
 * The reach rules are the status block's and are tested as such. What is its
 * own here is the *cell*: the one recorded is the presser's, not the tile's,
 * which is the whole reason a bed can be a solid thing you stand beside. And
 * the refusal to move a mark that is already where it is asked to go — without
 * it, a `step` block is a durable write and a sentence per stride.
 */

/** Ticks a started walk needs to reach its destination and commit. */
const TICKS_PER_STEP = Math.ceil(WALK_DURATION_MS / TICK_MS) + 1;

const frame = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

function tile(partial: Record<string, unknown>): TileDef {
  return normalizeTileDef({
    name: partial.id,
    height: 0,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    kind: "prop",
    ...partial,
  });
}

function body(id: string, extra: Record<string, unknown> = {}): TileDef {
  return tile({
    id,
    height: 4,
    kind: "battler",
    directional: true,
    walkable: false,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
    interactions: {
      battler: {
        baseHp: 8,
        masteries: { toughness: 92 },
        naturalWeapon: {
          type: "weapon",
          damage: 5,
          def: 0,
          accuracy: 100,
          variance: 0,
          spd: 100,
          mastery: "fist",
        },
      },
    },
    ...extra,
  });
}

const tiles: TileDef[] = [
  tile({ id: "grass" }),
  body("player", { affectedByGravity: true }),
  body("deer", { actor: true, affectedByGravity: true }),
  // The motivating tile: a solid thing you walk up to and press. Nobody is ever
  // reborn inside it, which is what makes the presser's own cell the answer.
  tile({
    id: "bed",
    height: 2,
    interactions: {
      setSpawn: { actionName: "Sleep", trigger: "interact" },
    },
  }),
  // Pressed from on top of it — a prayer mat rather than a bed.
  tile({
    id: "mat",
    interactions: { setSpawn: { trigger: "interactOver" } },
  }),
  // The silent half: a temple doorway that claims whoever walks through it.
  // Flat, so it neither buries what is under it nor stops anybody standing in
  // it.
  tile({ id: "threshold", interactions: { setSpawn: { trigger: "step" } } }),
];

const tilesById = tilesByIdFromList(tiles);

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

/** The player at the origin facing east, with one cell of interest beside them. */
function world(beside: string, tileId = "player"): MapFile {
  let map = replaceStack(emptyMap(), 0, 0, 0, [
    { tileId: "grass" },
    { tileId, direction: "e" },
  ]);
  // Every map needs exactly one player tile, so a creature's world still parks
  // one somewhere out of the way.
  if (tileId !== "player") {
    map = replaceStack(map, 9, 9, 0, [
      { tileId: "grass" },
      { tileId: "player", direction: "s" },
    ]);
  }
  return replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: beside }]);
}

function session(map: MapFile, opts: Record<string, unknown> = {}): GameSession {
  return new GameSession(map, tiles, opts);
}

const BED = { x: 1, y: 0, z: 0, stackIndex: 1 };

describe("resolveSetSpawn", () => {
  it("reads an authored block", () => {
    expect(resolveSetSpawn(tilesById.bed!)).toEqual({
      actionName: "Sleep",
      trigger: "interact",
    });
  });

  it("takes a trigger on its own as complete, there being nothing else", () => {
    expect(resolveSetSpawn(tilesById.threshold!)).toEqual({ trigger: "step" });
  });

  it("is nothing on a tile with no block at all", () => {
    expect(resolveSetSpawn(tilesById.grass!)).toBeNull();
  });
});

describe("reachableSetSpawnAt", () => {
  const actor = { x: 0, y: 0, z: 0 };

  it("offers a bed from the next square over", () => {
    expect(reachableSetSpawnAt(world("bed"), tilesById, actor, BED)).toMatchObject(
      { trigger: "interact" },
    );
  });

  it("offers a mat only from its own cell", () => {
    const map = world("mat");
    expect(reachableSetSpawnAt(map, tilesById, actor, BED)).toBeNull();
    expect(
      reachableSetSpawnAt(map, tilesById, { x: 1, y: 0, z: 0 }, BED),
    ).toMatchObject({ trigger: "interactOver" });
  });

  it("never offers a threshold you walk over, which answers to no press", () => {
    const map = world("threshold");
    expect(canSetSpawnFrom(map, tilesById, actor, BED)).toBe(false);
    expect(canSetSpawnFrom(map, tilesById, { x: 1, y: 0, z: 0 }, BED)).toBe(
      false,
    );
  });
});

describe("pressing something that moves where you come back", () => {
  it("records the cell the presser is standing in, not the tile's", () => {
    const play = session(world("bed"));
    expect(play.activateSetSpawn(BED)).toBe(true);
    // The bed is at 1,0. The player pressed it from 0,0 and that is the cell
    // that comes back — nobody is reborn inside the furniture.
    expect(play.drainSpawnMarks()).toEqual([
      { actorId: "local", at: { x: 0, y: 0, z: 0 } },
    ]);
  });

  it("says so, there being nothing in the view to show it", () => {
    const play = session(world("bed"));
    play.activateSetSpawn(BED);
    expect(play.drainNotices()).toEqual(["You will come back here."]);
  });

  it("is what a plain tap on a bed runs", () => {
    const play = session(world("bed"));
    expect(play.interact(BED)).toBe(true);
    expect(play.drainSpawnMarks()).toHaveLength(1);
  });

  it("moves the mark again from somewhere else", () => {
    // A second bed to the north of the first, so the same body can press one
    // from two different cells without the first mark being where it lands.
    let map = world("bed");
    map = replaceStack(map, 1, 1, 0, [{ tileId: "grass" }, { tileId: "bed" }]);
    map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }]);
    const play = session(map);

    expect(play.activateSetSpawn(BED)).toBe(true);
    step(play, "s");
    expect(play.activateSetSpawn({ x: 1, y: 1, z: 0, stackIndex: 1 })).toBe(true);

    expect(play.drainSpawnMarks()).toEqual([
      { actorId: "local", at: { x: 0, y: 0, z: 0 } },
      { actorId: "local", at: { x: 0, y: 1, z: 0 } },
    ]);
  });

  it("spends the tap on a second press but moves nothing", () => {
    const play = session(world("bed"));
    play.activateSetSpawn(BED);
    play.drainSpawnMarks();
    play.drainNotices();

    // True, not false: nothing about the board refused it, so the tap must not
    // fall through to whatever else the tile offers — `canInteract` would
    // disagree with `interact` if it did.
    expect(play.activateSetSpawn(BED)).toBe(true);
    expect(play.drainSpawnMarks()).toEqual([]);
    expect(play.drainNotices()).toEqual(["You already come back here."]);
  });

  it("refuses a creature, which comes back where it was authored", () => {
    const play = session(world("bed", "deer"), { actorIds: [] });
    expect(play.activateSetSpawn(BED, "npc:0,0,0,1")).toBe(false);
    expect(play.drainSpawnMarks()).toEqual([]);
  });
});

describe("walking onto something that moves where you come back", () => {
  it("takes the cell walked onto", () => {
    const play = session(world("threshold"));
    step(play, "e");
    expect(play.drainSpawnMarks()).toEqual([
      { actorId: "local", at: { x: 1, y: 0, z: 0 } },
    ]);
    expect(play.drainNotices()).toEqual(["You will come back here."]);
  });

  it("costs nothing to walk across twice", () => {
    const play = session(world("threshold"));
    step(play, "e");
    play.drainSpawnMarks();
    play.drainNotices();

    // Off and back on. The mark has not moved, so neither a write nor a
    // sentence is owed — this is the case the whole refusal exists for.
    step(play, "w");
    step(play, "e");
    expect(play.drainSpawnMarks()).toEqual([]);
    expect(play.drainNotices()).toEqual([]);
  });

  it("leaves a creature alone", () => {
    const play = session(world("threshold", "deer"), { actorIds: [] });
    expect(play.requestStep("npc:0,0,0,1", "e")).toBe("started");
    run(play, TICKS_PER_STEP);
    expect(play.drainSpawnMarks()).toEqual([]);
  });
});

describe("a mark the world already remembers", () => {
  it("makes the first press a no-op, which is what seeding it is for", () => {
    const play = session(world("bed"), { actorIds: [] });
    // What `GameServer.seatActor` hands over: the cell the `spawn:` row holds.
    // The player is standing on it, so pressing the bed asks for what they
    // already have.
    play.spawn("local", { spawnAt: { x: 0, y: 0, z: 0 } });

    expect(play.activateSetSpawn(BED)).toBe(true);
    expect(play.drainSpawnMarks()).toEqual([]);
    expect(play.drainNotices()).toEqual(["You already come back here."]);
  });

  it("is still moved by a press from anywhere else", () => {
    const play = session(world("bed"), { actorIds: [] });
    play.spawn("local", { spawnAt: { x: 5, y: 5, z: 0 } });

    expect(play.activateSetSpawn(BED)).toBe(true);
    expect(play.drainSpawnMarks()).toEqual([
      { actorId: "local", at: { x: 0, y: 0, z: 0 } },
    ]);
  });
});
