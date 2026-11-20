import { planHouse, type HouseConfig, type RoofColour } from "../../app/editor/house";
import { chunkifyMap } from "../../app/lib/mapData";
import type { Direction, FlatMapFile, PlacedTile, TileDef } from "../../app/lib/types";
import { MAP_FILE_VERSION, coordKey } from "../../app/lib/types";
import { Board, tile } from "./board";
import type { Plan } from "./plan";
import { baseTile } from "./stacks";
import type { Island } from "./terrain";

export type Rect = { x0: number; y0: number; x1: number; y1: number };

/** Somebody from `docs/npcs.md`, keyed by the tile id draft PR #699 gives them. */
export type Resident = {
  tileId: string;
  name: string;
  home: string;
  bed: { x: number; y: number; z: number } | null;
  work: string;
  workCell: { x: number; y: number; z: number } | null;
  /** Which way they look at their work cell, where the post itself does not say. */
  faces?: Direction;
  /** Where they stand to get into bed, their `bed` spot. */
  bedside?: { x: number; y: number; z: number };
  post?: { x: number; y: number; z: number; facing: Direction };
};

export type Building = {
  key: string;
  label: string;
  rect: Rect;
  z: number;
  storeys: number;
  door: { x: number; y: number; wall: Direction };
};

export type HouseStyle = {
  storeys?: number;
  roof?: RoofColour | null;
  wall?: string;
  floor?: string;
  window?: string | null;
};

const BED_SPAN_SEED = 0x5eed;

/**
 * Writes buildings and what is in them onto the board, and keeps the record
 * of who sleeps and works where that `docs/map.md` is written from.
 */
export class Builder {
  readonly residents: Resident[] = [];
  readonly buildings: Building[] = [];
  readonly lamps: Array<{ x: number; y: number; z: number; route: string }> = [];
  readonly cats: Array<{ tileId: string; owner: string; x: number; y: number; z: number }> = [];
  private spans = 0;

  constructor(
    readonly board: Board,
    readonly island: Island,
    readonly plan: Plan,
    readonly tilesById: Record<string, TileDef>,
  ) {}

  /** Map coordinates of a board cell, for the record. */
  world(x: number, y: number, z: number) {
    return { x: x + this.board.ox, y: y + this.board.oy, z };
  }

  base(x: number, y: number): string {
    return baseTile(this.island, y * this.island.width + x);
  }

  /** Puts a cell back to bare ground on level `z`. */
  clear(x: number, y: number, z: number, ground?: string) {
    this.board.set(x, y, z, [tile(ground ?? this.base(x, y))]);
  }

  /**
   * A house from the editor's own generator (`app/editor/house.ts`), so its
   * walls, windows, door and roof are what the editor would build there.
   */
  house(
    key: string,
    label: string,
    rect: Rect,
    z: number,
    door: Direction,
    style: HouseStyle = {},
  ): Building {
    const config: HouseConfig = {
      generator: "house",
      storeys: style.storeys ?? 1,
      roofOrientation: "auto",
      roofColour: style.roof === undefined ? "red" : style.roof,
      roofPitch: "low",
      wallTileId: style.wall ?? "sw2",
      floorTileId: style.floor ?? "wooden-floor",
      windowTileId: style.window === undefined ? "window-1" : style.window,
      windowSpacing: 4,
      doorTileId: "door-closed",
      doorRow: door === "n" ? "north" : door === "s" ? "south" : "centre",
      doorColumn: door === "e" ? "east" : door === "w" ? "west" : "centre",
    };
    const flat: FlatMapFile = { version: MAP_FILE_VERSION, levels: {} };
    for (let level = z; level <= z + 10; level++) {
      const cells: Record<string, PlacedTile[]> = {};
      for (let y = rect.y0 - 1; y <= rect.y1 + 1; y++) {
        for (let x = rect.x0 - 1; x <= rect.x1 + 1; x++) {
          const stack = this.board.get(x, y, level);
          if (stack) cells[coordKey(x, y)] = stack;
        }
      }
      if (Object.keys(cells).length) flat.levels[String(level)] = cells;
    }
    const result = planHouse(chunkifyMap(flat), this.tilesById, rect, z, config);
    if (!result.ok) throw new Error(`${label}: ${result.reason}`);
    for (const edit of result.edits)
      this.board.set(
        edit.x,
        edit.y,
        edit.z,
        edit.stack.map((p) => ({ ...p })),
      );
    const mx = Math.floor((rect.x0 + rect.x1) / 2);
    const my = Math.floor((rect.y0 + rect.y1) / 2);
    const spot =
      door === "n"
        ? { x: mx, y: rect.y0 }
        : door === "s"
          ? { x: mx, y: rect.y1 }
          : door === "w"
            ? { x: rect.x0, y: my }
            : { x: rect.x1, y: my };
    const building = {
      key,
      label,
      rect,
      z,
      storeys: config.storeys,
      door: { ...spot, wall: door },
    };
    this.buildings.push(building);
    return building;
  }

  /** True when the cell holds a floor and nothing on it. */
  isFree(x: number, y: number, z: number): boolean {
    const stack = this.board.get(x, y, z);
    if (!stack || stack.length === 0) return false;
    const top = stack[stack.length - 1]!.tileId;
    const def = this.tilesById[top];
    return (def?.height ?? 0) === 0 && top !== "hole";
  }

  put(x: number, y: number, z: number, tileId: string, direction?: Direction) {
    if (!this.isFree(x, y, z)) return false;
    this.board.push(x, y, z, tile(tileId, direction));
    return true;
  }

  /** A bed facing south, its head in `x`,`y - 1`. Both cells must be free floor. */
  bed(x: number, y: number, z: number, resident?: Omit<Resident, "bed">): boolean {
    if (!this.isFree(x, y, z) || !this.isFree(x, y - 1, z)) return false;
    const id = ((BED_SPAN_SEED + this.spans++ * 0x9e3779b1) >>> 0).toString(16).padStart(8, "0");
    this.board.push(
      x,
      y,
      z,
      tile("bed", "s", { span: { id, dx: 0, dy: 0 } } as Partial<PlacedTile>),
    );
    this.board.push(
      x,
      y - 1,
      z,
      tile("bed", "s", { span: { id, dx: 0, dy: 1 } } as Partial<PlacedTile>),
    );
    if (resident) this.residents.push({ ...resident, bed: this.world(x, y, z) });
    return true;
  }

  /** Puts a character's tile on the board, standing on free floor at `at` (map coordinates). */
  stand(r: Resident, at: { x: number; y: number; z: number }, facing: Direction): PlacedTile {
    const x = at.x - this.board.ox;
    const y = at.y - this.board.oy;
    if (!this.isFree(x, y, at.z))
      throw new Error(`${r.name}: no free floor at ${at.x}, ${at.y}, L${at.z}`);
    const placed = tile(r.tileId, facing);
    this.board.push(x, y, at.z, placed);
    r.post = { ...at, facing };
    return placed;
  }

  /**
   * The free floor beside a bed whose foot is at `bed` (map coordinates), where
   * somebody stands to get into it, or null when every side is taken.
   */
  bedside(bed: { x: number; y: number; z: number }) {
    for (const [dx, dy] of [
      [-1, 0],
      [1, 0],
      [0, 1],
      [-1, -1],
      [1, -1],
      [0, -2],
    ] as const) {
      const at = { x: bed.x + dx, y: bed.y + dy, z: bed.z };
      if (this.isFree(at.x - this.board.ox, at.y - this.board.oy, at.z)) return at;
    }
    return null;
  }

  /** A ladder from storey `z` to the floor above it. */
  ladder(x: number, y: number, z: number) {
    this.board.push(x, y, z, tile("ladder-up"));
    this.board.push(x, y, z + 1, tile("ladder-top"));
  }

  /** The cells inside a building's walls, on `z`, that are not in the doorway's path. */
  inside(b: Building, z = b.z): Array<{ x: number; y: number }> {
    const out: Array<{ x: number; y: number }> = [];
    const path = this.doorPath(b);
    for (let y = b.rect.y0 + 1; y < b.rect.y1; y++) {
      for (let x = b.rect.x0 + 1; x < b.rect.x1; x++) {
        if (z === b.z && path.has(`${x},${y}`)) continue;
        out.push({ x, y });
      }
    }
    return out;
  }

  /** The two cells inside the door, kept clear so the door can be walked through. */
  private doorPath(b: Building): Set<string> {
    const { x, y, wall } = b.door;
    const inward: Record<Direction, [number, number]> = {
      n: [0, 1],
      s: [0, -1],
      w: [1, 0],
      e: [-1, 0],
    };
    const [dx, dy] = inward[wall];
    return new Set([`${x + dx},${y + dy}`, `${x + 2 * dx},${y + 2 * dy}`]);
  }

  /** Inside cells along the walls, furthest from the door first. */
  wallSide(b: Building, z = b.z): Array<{ x: number; y: number }> {
    const cells = this.inside(b, z).filter(
      ({ x, y }) =>
        x === b.rect.x0 + 1 || x === b.rect.x1 - 1 || y === b.rect.y0 + 1 || y === b.rect.y1 - 1,
    );
    const { x: dx, y: dy } = b.door;
    return cells.sort((a, c) => Math.hypot(c.x - dx, c.y - dy) - Math.hypot(a.x - dx, a.y - dy));
  }

  /** Puts each tile against the walls, furthest from the door first. Returns how many fitted. */
  furnish(b: Building, tileIds: readonly string[], z = b.z): number {
    let placed = 0;
    const spots = this.wallSide(b, z);
    for (const id of tileIds) {
      const at = spots.find(({ x, y }) => this.isFree(x, y, z));
      if (!at) break;
      this.put(at.x, at.y, z, id);
      spots.splice(spots.indexOf(at), 1);
      placed++;
    }
    return placed;
  }

  /** A bed against a wall, for one resident. */
  bedFor(
    b: Building,
    resident: Omit<Resident, "bed" | "home"> & { home?: string },
    z = b.z,
  ): boolean {
    for (const { x, y } of this.wallSide(b, z)) {
      if (this.bed(x, y, z, { ...resident, home: resident.home ?? b.label })) return true;
    }
    for (const { x, y } of this.inside(b, z)) {
      if (this.bed(x, y, z, { ...resident, home: resident.home ?? b.label })) return true;
    }
    throw new Error(`no room for ${resident.name}'s bed in ${b.label}`);
  }

  /** The middle of a building's floor, as somebody's place of work. */
  workCell(b: Building, z = b.z) {
    const cells = this.inside(b, z).filter(({ x, y }) => this.isFree(x, y, z));
    const cx = (b.rect.x0 + b.rect.x1) / 2;
    const cy = (b.rect.y0 + b.rect.y1) / 2;
    cells.sort((a, c) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(c.x - cx, c.y - cy));
    const at = cells[0] ?? { x: Math.round(cx), y: Math.round(cy) };
    return this.world(at.x, at.y, z);
  }

  /** A ladder in the corner furthest from the door, for a house of two storeys. */
  stairsUp(b: Building) {
    const corners = [
      { x: b.rect.x0 + 1, y: b.rect.y0 + 1 },
      { x: b.rect.x1 - 1, y: b.rect.y0 + 1 },
      { x: b.rect.x0 + 1, y: b.rect.y1 - 1 },
      { x: b.rect.x1 - 1, y: b.rect.y1 - 1 },
    ].sort(
      (a, c) =>
        Math.hypot(c.x - b.door.x, c.y - b.door.y) - Math.hypot(a.x - b.door.x, a.y - b.door.y),
    );
    for (const c of corners) {
      if (this.isFree(c.x, c.y, b.z) && this.isFree(c.x, c.y, b.z + 1)) {
        this.ladder(c.x, c.y, b.z);
        return;
      }
    }
    throw new Error(`no room for a ladder in ${b.label}`);
  }
}
