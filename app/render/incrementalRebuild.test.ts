/**
 * The claim the incremental geometry rebuild rests on: gameplay motion touches
 * a couple of cells, and touches only tiles that are already drawn as their own
 * mesh. If either stops holding, the renderer quietly falls back to rebuilding
 * a whole floor per step and the walk stutter returns — so both are pinned here
 * rather than left as an assumption in a comment.
 *
 * Built on fixtures. The claim is about how motion touches a map, not about the
 * map we happen to ship: authoring a tile or shoving a crate around in the
 * editor used to break this, which taught nobody anything. The fixture floor is
 * deliberately far larger than any step, so "a handful of cells, not a floor"
 * is a real distinction.
 *
 * One test still reads `data/` — the last one, whose subject really is the
 * shipped world. It is a canary with a loose threshold rather than a fixture
 * test, and it is marked as such.
 */
import { describe, expect, it } from "vitest";
import mapJson from "../../data/map.json";
import tilesJson from "../../data/tiles.json";
import { DEFAULT_PUSH, isMobileTile } from "../lib/interactions";
import {
  changedCellsOnLevel,
  chunkifyMap,
  emptyMap,
  getStack,
  replaceStack,
} from "../lib/mapData";
import type { FlatMapFile, MapFile, PlacedTile, TileDef } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL, normalizeTileDef, parseCoordKey } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { GameSession } from "../game/GameSession";
import { TICK_MS, WALK_DURATION_MS } from "../game/constants";

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

const playerFrames = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

/**
 * One of each kind the renderer sorts on: two tiles it merges into the batch,
 * one mobile by gravity, one mobile by being pushable.
 */
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

/** Wide enough that rebuilding it would be the cost this all exists to avoid. */
const FLOOR_SIZE = 40;
const FLOOR_CELLS = FLOOR_SIZE * FLOOR_SIZE;

/**
 * A grass floor with the player at one corner, a wall behind them and a crate
 * in their path — so a walk east eventually pushes something, and there is
 * non-mobile scenery next to everything that moves.
 */
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

/** Every cell that differs between two maps, as `z -> cell keys`. */
function changedByLevel(prev: MapFile, next: MapFile): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    const changed = changedCellsOnLevel(prev, next, z);
    if (changed.size > 0) out.set(z, changed);
  }
  return out;
}

/**
 * Tile ids whose presence in a cell differs between two stacks. Order is
 * ignored: what matters is which tiles came and went, not where in the stack.
 */
function movedTileIds(
  prev: MapFile,
  next: MapFile,
  z: number,
  key: string,
): Set<string> {
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
  /** Run until the map changes, or give up. Returns the map before and after. */
  function stepUntilMapChanges(
    session: GameSession,
  ): { before: MapFile; after: MapFile } | null {
    // Enough ticks to cover a full step with room to spare.
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

    // A step is: leave one cell, arrive in another. Facing-only updates are a
    // single cell. Anything approaching the floor's cell count means the diff
    // is not seeing copy-on-write and the renderer will rebuild everything.
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
            // Merged geometry holds everything that is not mobile. A step that
            // moved a non-mobile tile would change the batch, and the renderer
            // would have to rebuild the whole level to reflect it.
            expect(
              isMobileTile(def!),
              `${id} moved but is not mobile, so it lives in the merged batch`,
            ).toBe(true);
          }
        }
      }
    }

    /** Tick a while, recording everything the map relocated. */
    function run(ticks: number) {
      for (let i = 0; i < ticks; i++) {
        const before = session.getMap();
        session.tick(TICK_MS);
        record(before, session.getMap());
      }
    }

    // Several committed steps east, not just the first, then a shove into the
    // crate — the two ways a tile changes cell, over the same board.
    session.setInput({ directions: ["e"] });
    run(40);
    session.setInput({ directions: [] });
    expect(session.getSnapshot().self.x).toBe(2);

    // A push commits to the map on the spot — the slide afterwards is only the
    // sprite catching up — so the shove itself is what has to be watched.
    const beforePush = session.getMap();
    expect(session.interact({ x: 3, y: 0, z: 0, stackIndex: 1 })).toBe(true);
    record(beforePush, session.getMap());
    run(40);

    // Both actually shifted, or the assertions above passed by never looking at
    // anything.
    expect([...moved].sort()).toEqual(["crate", "player"]);
  });
});

describe("mobility classification", () => {
  /**
   * The rule, not the roster. Asserting the ids in `data/tiles.json` made this
   * fail every time a tile was authored, which says nothing about whether the
   * classification is right.
   */
  it("counts gravity, pushability and bodies, and nothing else", () => {
    expect(isMobileTile(tile({ id: "boulder", height: 4, affectedByGravity: true }))).toBe(true);
    // A body moves under its own steam, and saying so explicitly is what keeps
    // one that ignores gravity out of the static bake — baked into the floor,
    // and smearing across it the moment it walked.
    expect(isMobileTile(tile({ id: "ghost", height: 2, actor: true }))).toBe(
      true,
    );
    expect(
      isMobileTile(tile({ id: "crate", height: 2, interactions: { push: DEFAULT_PUSH } })),
    ).toBe(true);
    expect(isMobileTile(tile({ id: "grass", height: 0 }))).toBe(false);
    // Interactive, but nothing about it changes cell: it stays in the batch.
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

  /**
   * The one claim here that is about the map we ship rather than about the
   * code, so it is the one that reads `data/`. It is a canary, not a fixture
   * test: authoring a tile or moving scenery cannot trip it, because the only
   * thing it objects to is the shipped world turning mostly-mobile.
   */
  it("leaves the merged batch of the authored map holding almost everything", () => {
    const authored = chunkifyMap(mapJson as FlatMapFile);
    const authoredTiles = tilesByIdFromList(tilesJson as TileDef[]);
    let mobilePlacements = 0;
    let total = 0;
    for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
      const level = authored.levels[String(z)];
      if (!level) continue;
      for (const chunk of Object.values(level)) {
        for (const stack of Object.values(chunk)) {
          for (const placed of stack) {
            total++;
            const def = authoredTiles[placed.tileId];
            if (def && isMobileTile(def)) mobilePlacements++;
          }
        }
      }
    }
    // Mobile tiles are pulled out of the merged batch permanently, so each one
    // is a draw call. That trade only holds while they stay a rounding error —
    // a map where they are not is a map this renderer is the wrong shape for.
    expect(total).toBeGreaterThan(1000);
    expect(mobilePlacements / total).toBeLessThan(0.01);
  });
});
