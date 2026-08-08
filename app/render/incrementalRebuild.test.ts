/**
 * The claim the incremental geometry rebuild rests on: gameplay motion touches
 * a couple of cells, and touches only tiles that are already drawn as their own
 * mesh. If either stops holding, the renderer quietly falls back to rebuilding
 * a 4565-cell floor per step and the walk stutter returns — so both are pinned
 * here rather than left as an assumption in a comment.
 */
import { describe, expect, it } from "vitest";
import mapJson from "../../data/map.json";
import tilesJson from "../../data/tiles.json";
import { changedCellsOnLevel, chunkifyMap, getStack } from "../lib/mapData";
import { isMobileTile } from "../lib/interactions";
import type { FlatMapFile, MapFile, TileDef } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL, parseCoordKey } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { GameSession } from "../game/GameSession";
import { TICK_MS, WALK_DURATION_MS } from "../game/constants";

const tiles = tilesJson as TileDef[];
const tilesById = tilesByIdFromList(tiles);
const mapFile = chunkifyMap(mapJson as FlatMapFile);

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
    const session = new GameSession(mapFile, tiles);
    session.setInput({ directions: ["e"] });

    const step = stepUntilMapChanges(session);
    expect(step, "the player never moved — fixture or input is wrong").not.toBeNull();

    const changed = changedByLevel(step!.before, step!.after);
    let total = 0;
    for (const cells of changed.values()) total += cells.size;

    // A step is: leave one cell, arrive in another. Facing-only updates are a
    // single cell. Anything approaching the floor's 4565 means the diff is not
    // seeing copy-on-write and the renderer will rebuild everything.
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(4);
  });

  it("moves only tiles that already have their own mesh", () => {
    const session = new GameSession(mapFile, tiles);
    session.setInput({ directions: ["e"] });

    // Walk for a while so this covers committed steps, not just the first.
    for (let i = 0; i < 40; i++) {
      const before = session.getMap();
      session.tick(TICK_MS);
      const after = session.getMap();
      if (before === after) continue;

      for (const [z, cells] of changedByLevel(before, after)) {
        for (const key of cells) {
          for (const id of movedTileIds(before, after, z, key)) {
            const def = tilesById[id];
            expect(def, `unknown tile ${id}`).toBeDefined();
            // Merged geometry holds everything that is not mobile. A step that
            // moved a non-mobile tile would change the batch, and the renderer
            // would have to rebuild the whole level to reflect it.
            expect(
              isMobileTile(def!),
              `${id} moved during a walk but is not mobile, so it lives in the merged batch`,
            ).toBe(true);
          }
        }
      }
    }
  });
});

describe("mobility classification", () => {
  it("covers exactly the tiles gameplay can relocate", () => {
    const mobile = tiles.filter(isMobileTile).map((t) => t.id).sort();
    // Gravity or a push interaction are the only two ways a tile changes cell.
    expect(mobile).toEqual(["brick-slab", "cat", "player"]);
  });

  it("leaves the merged batch holding almost everything", () => {
    let mobilePlacements = 0;
    let total = 0;
    for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
      const level = mapFile.levels[String(z)];
      if (!level) continue;
      for (const chunk of Object.values(level)) {
        for (const stack of Object.values(chunk)) {
          for (const placed of stack) {
            total++;
            const def = tilesById[placed.tileId];
            if (def && isMobileTile(def)) mobilePlacements++;
          }
        }
      }
    }
    // Mobile tiles are pulled out of the merged batch permanently, so each one
    // is a draw call. That trade only holds while they stay a rounding error.
    expect(total).toBeGreaterThan(1000);
    expect(mobilePlacements / total).toBeLessThan(0.01);
  });
});
