import { getStack, presentLevels } from "../lib/mapData";
import { levelKey, parseCoordKey, type Coord, type MapFile, type PlacedTile } from "../lib/types";
import type { CellPatch } from "./protocol";

export class ActorCells {
  private readonly byOwner = new Map<string, Map<string, Coord>>();

  static of(map: MapFile): ActorCells {
    const index = new ActorCells();
    for (const z of presentLevels(map)) {
      const level = map.levels[levelKey(z)];
      if (!level) continue;
      for (const chunk of Object.values(level)) {
        for (const key in chunk) {
          for (const placed of chunk[key]!) {
            if (!placed.owner) continue;
            const { x, y } = parseCoordKey(key);
            index.add(placed.owner, { x, y, z });
          }
        }
      }
    }
    return index;
  }

  /**
   * Reads what `cells` replace from `before`, so it is called before they are
   * written to it. A cell named twice in one patch replaces what the first
   * mention wrote, which is what `setStacks` does with it.
   */
  write(before: MapFile, cells: readonly CellPatch[]) {
    const written = new Map<string, readonly PlacedTile[]>();
    for (const cell of cells) {
      const key = cellKey(cell);
      const replaced = written.get(key) ?? getStack(before, cell.x, cell.y, cell.z);
      for (const placed of replaced) {
        if (placed.owner) this.remove(placed.owner, key);
      }
      for (const placed of cell.stack) {
        if (placed.owner) this.add(placed.owner, cell);
      }
      written.set(key, cell.stack);
    }
  }

  cellsOf(owner: string): ReadonlyMap<string, Coord> | undefined {
    return this.byOwner.get(owner);
  }

  private add(owner: string, at: Coord) {
    let cells = this.byOwner.get(owner);
    if (!cells) {
      cells = new Map();
      this.byOwner.set(owner, cells);
    }
    cells.set(cellKey(at), { x: at.x, y: at.y, z: at.z });
  }

  private remove(owner: string, key: string) {
    const cells = this.byOwner.get(owner);
    if (!cells?.delete(key)) return;
    if (cells.size === 0) this.byOwner.delete(owner);
  }
}

function cellKey(at: Coord): string {
  return `${at.x},${at.y},${at.z}`;
}
