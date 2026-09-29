import { describe, expect, it } from "vitest";
import { resolveSetSpawn } from "../lib/interactions";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { Coord, Direction, MapFile, TileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { canSetSpawnFrom, reachableSetSpawnAt } from "./affordances";
import { TICK_MS, WALK_DURATION_MS } from "./constants";
import { GameSession } from "./GameSession";
import { listInteractionOptions } from "./interactionOptions";
import { FRAME, tile } from "../lib/testTile";

const TICKS_PER_STEP = Math.ceil(WALK_DURATION_MS / TICK_MS) + 1;

function body(id: string, extra: Record<string, unknown> = {}): TileDef {
  return tile({
    id,
    height: 4,
    kind: "battler",
    directional: true,
    walkable: false,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
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
  tile({
    id: "bed",
    height: 2,
    interactions: {
      setSpawn: { actionName: "Sleep", trigger: "interact" },
    },
  }),
  tile({
    id: "mat",
    interactions: { setSpawn: { trigger: "interactOver" } },
  }),
  tile({ id: "threshold", interactions: { setSpawn: { trigger: "step" } } }),
];

const tilesById = tilesByIdFromList(tiles);

function run(session: GameSession, ticks: number) {
  for (let i = 0; i < ticks; i++) session.tick(TICK_MS);
}

function step(session: GameSession, direction: Direction) {
  session.setInput({ directions: [direction] });
  session.tick(TICK_MS);
  session.setInput({ directions: [] });
  run(session, TICKS_PER_STEP);
}

function world(beside: string, tileId = "player"): MapFile {
  let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId, direction: "e" }]);
  if (tileId !== "player") {
    map = replaceStack(map, 9, 9, 0, [{ tileId: "grass" }, { tileId: "player", direction: "s" }]);
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
    expect(reachableSetSpawnAt(world("bed"), tilesById, actor, BED)).toMatchObject({
      trigger: "interact",
    });
  });

  it("offers a mat only from its own cell", () => {
    const map = world("mat");
    expect(reachableSetSpawnAt(map, tilesById, actor, BED)).toBeNull();
    expect(reachableSetSpawnAt(map, tilesById, { x: 1, y: 0, z: 0 }, BED)).toMatchObject({
      trigger: "interactOver",
    });
  });

  it("never offers a threshold you walk over, which answers to no press", () => {
    const map = world("threshold");
    expect(canSetSpawnFrom(map, tilesById, actor, BED)).toBe(false);
    expect(canSetSpawnFrom(map, tilesById, { x: 1, y: 0, z: 0 }, BED)).toBe(false);
  });
});

describe("pressing something that moves where you come back", () => {
  it("records the marker's cell, not the presser's", () => {
    const play = session(world("bed"));
    expect(play.activateSetSpawn(BED)).toBe(true);
    expect(play.drainSpawnMarks()).toEqual([{ actorId: "local", at: { x: 1, y: 0, z: 0 } }]);
  });

  it("says so, there being nothing in the view to show it", () => {
    const play = session(world("bed"));
    play.activateSetSpawn(BED);
    expect(play.drainNotices()).toEqual(["You will respawn here."]);
  });

  it("is what a plain tap on a bed runs", () => {
    const play = session(world("bed"));
    expect(play.interact(BED)).toBe(true);
    expect(play.drainSpawnMarks()).toHaveLength(1);
  });

  it("moves the mark again from somewhere else", () => {
    let map = world("bed");
    map = replaceStack(map, 1, 1, 0, [{ tileId: "grass" }, { tileId: "bed" }]);
    map = replaceStack(map, 0, 1, 0, [{ tileId: "grass" }]);
    const play = session(map);

    expect(play.activateSetSpawn(BED)).toBe(true);
    step(play, "s");
    expect(play.activateSetSpawn({ x: 1, y: 1, z: 0, stackIndex: 1 })).toBe(true);

    expect(play.drainSpawnMarks()).toEqual([
      { actorId: "local", at: { x: 1, y: 0, z: 0 } },
      { actorId: "local", at: { x: 1, y: 1, z: 0 } },
    ]);
  });

  it("spends the tap on a second press but moves nothing", () => {
    const play = session(world("bed"));
    play.activateSetSpawn(BED);
    play.drainSpawnMarks();
    play.drainNotices();

    expect(play.activateSetSpawn(BED)).toBe(true);
    expect(play.drainSpawnMarks()).toEqual([]);
    expect(play.drainNotices()).toEqual(["You already respawn here."]);
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
    expect(play.drainSpawnMarks()).toEqual([{ actorId: "local", at: { x: 1, y: 0, z: 0 } }]);
    expect(play.drainNotices()).toEqual(["You will respawn here."]);
  });

  it("costs nothing to walk across twice", () => {
    const play = session(world("threshold"));
    step(play, "e");
    play.drainSpawnMarks();
    play.drainNotices();

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
  it("makes a press on the marker it names a no-op", () => {
    const play = session(world("bed"), { actorIds: [] });
    play.spawn("local", { spawnAt: { x: 1, y: 0, z: 0 } });

    expect(play.activateSetSpawn(BED)).toBe(true);
    expect(play.drainSpawnMarks()).toEqual([]);
    expect(play.drainNotices()).toEqual(["You already respawn here."]);
  });

  it("is still moved by a press on a marker it does not name", () => {
    const play = session(world("bed"), { actorIds: [] });
    play.spawn("local", { spawnAt: { x: 0, y: 0, z: 0 } });

    expect(play.activateSetSpawn(BED)).toBe(true);
    expect(play.drainSpawnMarks()).toEqual([{ actorId: "local", at: { x: 1, y: 0, z: 0 } }]);
  });
});

describe("the row on a respawn point", () => {
  function markerWorld(): MapFile {
    return replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "mat" },
      { tileId: "player", direction: "e" },
    ]);
  }

  function rowsFor(spawnAt: Coord | null) {
    const play = session(markerWorld());
    const snap = play.getSnapshot();
    return listInteractionOptions(
      snap.map,
      tilesById,
      snap.self,
      [snap.self],
      null,
      snap.equipment,
      null,
      snap.tags,
      spawnAt,
      false,
    ).filter((option) => option.action === "setSpawn");
  }

  it("is live, and named for the press, where nothing has said otherwise", () => {
    const [row] = rowsFor(null);
    expect(row?.blocked).toBeNull();
    expect(row?.label).toBe("Mark");
  });

  it("is live on a marker that is not the one you come back to", () => {
    const [row] = rowsFor({ x: 5, y: 5, z: 0 });
    expect(row?.blocked).toBeNull();
  });

  it("goes grey and says so on the one you do", () => {
    const [row] = rowsFor({ x: 0, y: 0, z: 0 });
    expect(row?.blocked).toEqual({ kind: "here" });
    expect(row?.label).toBe("You respawn here");
  });

  it("reads the level too, so a marker one floor down is a different place", () => {
    const [row] = rowsFor({ x: 0, y: 0, z: -1 });
    expect(row?.blocked).toBeNull();
  });

  describe("on a marker you press from beside", () => {
    function bedRowsFor(spawnAt: Coord | null) {
      const play = session(world("bed"));
      const snap = play.getSnapshot();
      return listInteractionOptions(
        snap.map,
        tilesById,
        snap.self,
        [snap.self],
        null,
        snap.equipment,
        null,
        snap.tags,
        spawnAt,
        false,
      ).filter((option) => option.action === "setSpawn");
    }

    it("goes grey when the mark is the bed's cell", () => {
      const [row] = bedRowsFor({ x: 1, y: 0, z: 0 });
      expect(row?.blocked).toEqual({ kind: "here" });
      expect(row?.label).toBe("You respawn here");
    });

    it("stays live when the mark is the cell they are standing in", () => {
      const [row] = bedRowsFor({ x: 0, y: 0, z: 0 });
      expect(row?.blocked).toBeNull();
      expect(row?.label).toBe("Sleep");
    });
  });
});
