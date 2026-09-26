import { describe, expect, it } from "vitest";
import { DEFAULT_PUSH, isMobileTile } from "../lib/interactions";
import { changedCellsOnLevel, emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL, parseCoordKey } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { GameSession } from "../game/GameSession";
import { TICK_MS, WALK_DURATION_MS } from "../game/constants";
import { tile } from "../lib/testTile";

const playerFrames = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "wall", height: 4, walkable: false }),
  tile({
    id: "crate",
    height: 2,
    walkable: false,
    interactions: { push: DEFAULT_PUSH },
  }),
  tile({
    id: "player",
    height: 4,
    directional: true,
    affectedByGravity: true,
    walkable: false,
    variants: {
      n: [playerFrames],
      e: [playerFrames],
      s: [playerFrames],
      w: [playerFrames],
    },
  }),
];
const tilesById = tilesByIdFromList(tiles);

const FLOOR_SIZE = 40;
const FLOOR_CELLS = FLOOR_SIZE * FLOOR_SIZE;

function walkableFloor(): MapFile {
  let map = emptyMap();
  for (let x = 0; x < FLOOR_SIZE; x++) {
    for (let y = 0; y < FLOOR_SIZE; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" } as PlacedTile]);
    }
  }
  map = replaceStack(map, 0, 0, 0, [
    { tileId: "grass" } as PlacedTile,
    { tileId: "player", direction: "e" } as PlacedTile,
  ]);
  map = replaceStack(map, 0, 1, 0, [
    { tileId: "grass" } as PlacedTile,
    { tileId: "wall" } as PlacedTile,
  ]);
  map = replaceStack(map, 3, 0, 0, [
    { tileId: "grass" } as PlacedTile,
    { tileId: "crate" } as PlacedTile,
  ]);
  return map;
}

function changedByLevel(prev: MapFile, next: MapFile): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    const changed = changedCellsOnLevel(prev, next, z);
    if (changed.size > 0) out.set(z, changed);
  }
  return out;
}

function movedTileIds(prev: MapFile, next: MapFile, z: number, key: string): Set<string> {
  const { x, y } = parseCoordKey(key);
  const before = getStack(prev, x, y, z).map((p) => p.tileId);
  const after = getStack(next, x, y, z).map((p) => p.tileId);
  const counts = new Map<string, number>();
  for (const id of before) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const id of after) counts.set(id, (counts.get(id) ?? 0) - 1);
  const moved = new Set<string>();
  for (const [id, n] of counts) if (n !== 0) moved.add(id);
  return moved;
}

describe("a walk stays cheap to rebuild", () => {
  function stepUntilMapChanges(session: GameSession): { before: MapFile; after: MapFile } | null {
    const maxTicks = Math.ceil((WALK_DURATION_MS * 3) / TICK_MS);
    for (let i = 0; i < maxTicks; i++) {
      const before = session.getMap();
      session.tick(TICK_MS);
      const after = session.getMap();
      if (before !== after) return { before, after };
    }
    return null;
  }

  it("changes a handful of cells, not a floor", () => {
    const session = new GameSession(walkableFloor(), tiles);
    session.setInput({ directions: ["e"] });

    const step = stepUntilMapChanges(session);
    expect(step, "the player never moved — fixture or input is wrong").not.toBeNull();

    const changed = changedByLevel(step!.before, step!.after);
    let total = 0;
    for (const cells of changed.values()) total += cells.size;

    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(4);
    expect(total).toBeLessThan(FLOOR_CELLS);
  });

  it("moves only tiles that already have their own mesh", () => {
    const session = new GameSession(walkableFloor(), tiles);
    const moved = new Set<string>();

    function record(before: MapFile, after: MapFile) {
      if (before === after) return;
      for (const [z, cells] of changedByLevel(before, after)) {
        for (const key of cells) {
          for (const id of movedTileIds(before, after, z, key)) {
            const def = tilesById[id];
            expect(def, `unknown tile ${id}`).toBeDefined();
            moved.add(id);
            expect(
              isMobileTile(def!),
              `${id} moved but is not mobile, so it lives in the merged batch`,
            ).toBe(true);
          }
        }
      }
    }

    function run(ticks: number) {
      for (let i = 0; i < ticks; i++) {
        const before = session.getMap();
        session.tick(TICK_MS);
        record(before, session.getMap());
      }
    }

    session.setInput({ directions: ["e"] });
    run(40);
    session.setInput({ directions: [] });
    expect(session.getSnapshot().self.x).toBe(2);

    const beforePush = session.getMap();
    expect(session.interact({ x: 3, y: 0, z: 0, stackIndex: 1 })).toBe(true);
    record(beforePush, session.getMap());
    run(40);

    expect([...moved].sort()).toEqual(["crate", "player"]);
  });
});

describe("mobility classification", () => {
  it("counts gravity, pushability and bodies, and nothing else", () => {
    expect(isMobileTile(tile({ id: "boulder", height: 4, affectedByGravity: true }))).toBe(true);
    expect(isMobileTile(tile({ id: "ghost", height: 2, actor: true }))).toBe(true);
    expect(
      isMobileTile(tile({ id: "crate", height: 2, interactions: { push: DEFAULT_PUSH } })),
    ).toBe(true);
    expect(isMobileTile(tile({ id: "grass", height: 0 }))).toBe(false);
    expect(
      isMobileTile(
        tile({
          id: "lever",
          height: 2,
          interactions: { switch: { targetTileId: "lever-on" } },
        }),
      ),
    ).toBe(false);
  });
});
