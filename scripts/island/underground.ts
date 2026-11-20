import { stackOcclusion } from "../../app/lib/lighting";
import type { Direction, PlacedTile, TileDef } from "../../app/lib/types";
import { CHUNK_SIZE } from "../../app/lib/types";
import { tile } from "./board";
import type { Builder } from "./build";
import { N4, N8, mulberry32 } from "./grid";
import { OPPOSITE, SIDEWAYS, STEP, type Dir } from "./plan";
import { SNOW_LEVEL } from "../../app/verify/landscape";

/**
 * Rock and floor for one part of the underground. `floor` is laid over the
 * `dirt` every cave cell has, and `props` stand on it against the walls.
 */
type Style = {
  wall: string;
  /** The full tile under the `dirt` of a cave dug into a hill, which its edges show. */
  ground: string;
  floor: (x: number, y: number) => PlacedTile[];
  props: ReadonlyArray<readonly [string, number]>;
};

/** Tiles that make a surface cell no place for an entrance. */
const AWKWARD = new Set([
  "water",
  "deep-water",
  "lava",
  "ramp",
  "snowy-ramp",
  "fence",
  "stone-stairs",
  "hole",
  "ladder-top",
  "swamp",
  "mud",
]);

/** A tunnel above ground lies on its style's ground, except that no snow lies below the snow line, where a frost cave's mouth opens onto grass. */
function groundAt(style: Style, z: number): string {
  return style.ground === "snow" && z < SNOW_LEVEL ? "grass-2" : style.ground;
}

const FILL_WALLS = new Set([
  "hill-wall",
  "hill-wall-frost",
  "hill-wall-sandstone",
  "hill-wall-basalt",
]);

const enum Kind {
  Floor = 1,
  /** The empty cell over a flight of stairs, which a body climbs out of. */
  Shaft = 2,
  /** A `hole` with nothing under it on its own level, dropped through to the floor below. */
  Hole = 3,
}

type Cell = { kind: Kind; style: Style; fixed?: PlacedTile[] };

/** A named part of the underground, for `docs/map.md`. */
export type CavePlace = {
  name: string;
  levels: string;
  at: { x: number; y: number; z: number };
  note: string;
};

export type Entrance = {
  place: string;
  by: string;
  at: { x: number; y: number; z: number };
};

export type Underground = {
  places: CavePlace[];
  entrances: Entrance[];
  cells: number;
  levels: number[];
};

/** Smooth noise in 0..1 from a seeded lattice, for patches of floor. */
function noise(x: number, y: number, seed: number, scale: number): number {
  const fx = x / scale;
  const fy = y / scale;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const r = (a: number, b: number) => {
    let h = Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const top = r(x0, y0) + (r(x0 + 1, y0) - r(x0, y0)) * sx;
  const bottom = r(x0, y0 + 1) + (r(x0 + 1, y0 + 1) - r(x0, y0 + 1)) * sx;
  return top + (bottom - top) * sy;
}

const patch = (seed: number, scale: number, above: number) => (x: number, y: number) =>
  noise(x, y, seed, scale) > above;

const STYLES = (() => {
  const ice = patch(11, 5, 0.62);
  const lake = patch(12, 9, 0.42);
  const thaw = patch(13, 3, 0.8);
  const roots = (x: number, y: number) => noise(x, y, 21, 6) > 0.6 && noise(x, y, 25, 0.9) > 0.85;
  const mud = patch(22, 6, 0.7);
  const shrooms = (x: number, y: number) => noise(x, y, 23, 6) > 0.55 && noise(x, y, 26, 0.9) > 0.9;
  const flood = patch(31, 6, 0.45);
  const moss = patch(41, 4, 0.6);
  const bones = patch(42, 1.5, 0.88);
  const sand = patch(51, 5, 0.55);
  const lavaPool = patch(61, 6, 0.66);
  const crust = patch(62, 6, 0.58);
  return {
    frost: {
      wall: "hill-wall-frost",
      ground: "snow",
      floor: (x, y) => (ice(x, y) ? [tile("ice")] : []),
      props: [
        ["ice-spike", 26],
        ["snowy-rock", 70],
      ],
    },
    crystal: {
      wall: "hill-wall-frost",
      ground: "snow",
      floor: (x, y) => (ice(x, y) ? [tile("ice")] : []),
      props: [
        ["arcane-crystal-1", 45],
        ["arcane-crystal-2", 55],
        ["arcane-crystal-3", 40],
        ["ice-spike", 60],
      ],
    },
    frozenLake: {
      wall: "hill-wall-frost",
      ground: "snow",
      floor: (x, y) =>
        lake(x, y)
          ? thaw(x, y)
            ? [tile("water")]
            : [tile("water"), tile("ice")]
          : ice(x, y)
            ? [tile("ice")]
            : [],
      props: [
        ["ice-spike", 50],
        ["arcane-crystal-3", 140],
      ],
    },
    earth: {
      wall: "cave-wall-sloped",
      ground: "grass-2",
      floor: (x, y) => (mud(x, y) ? [tile("mud")] : []),
      props: [["stalagmite", 22]],
    },
    roots: {
      wall: "cave-wall-sloped",
      ground: "grass-2",
      floor: (x, y) =>
        roots(x, y)
          ? [tile("tree-roots")]
          : shrooms(x, y)
            ? [tile(noise(x, y, 24, 1.3) > 0.7 ? "blue-mushroom-patch" : "mushroom-patch")]
            : mud(x, y)
              ? [tile("mud")]
              : [],
      props: [["stalagmite", 45]],
    },
    stone: {
      wall: "cave-wall-sloped-grey",
      ground: "grass-2",
      floor: () => [],
      props: [["stalagmite-grey", 20]],
    },
    barrow: {
      wall: "cave-wall-sloped-grey",
      ground: "grass-2",
      floor: (x, y) => [
        tile(moss(x, y) ? "moss-flagstone" : "flagstone-floor"),
        ...(bones(x, y) ? [tile("bleached-bones")] : []),
      ],
      props: [],
    },
    flooded: {
      wall: "cave-wall-sloped-grey",
      ground: "grass-2",
      floor: (x, y) => (flood(x, y) ? [tile("water")] : mud(x, y) ? [tile("mud")] : []),
      props: [["stalagmite-grey", 45]],
    },
    grotto: {
      wall: "cave-wall-sloped-grey",
      ground: "sand",
      floor: (x, y) => (flood(x, y) ? [tile("water")] : sand(x, y) ? [tile("sand")] : []),
      props: [["stalagmite-grey", 60]],
    },
    sandstone: {
      wall: "hill-wall-sandstone",
      ground: "sand",
      floor: (x, y) => [
        ...(sand(x, y) ? [tile("sand")] : []),
        ...(bones(x, y) ? [tile("bleached-bones")] : []),
      ],
      props: [["stalagmite", 40]],
    },
    basalt: {
      wall: "hill-wall-basalt",
      ground: "sand",
      floor: (x, y) => (crust(x, y) ? [tile("basalt"), tile("lava-crust")] : [tile("basalt")]),
      props: [["rock-pillar", 70]],
    },
    lava: {
      wall: "hill-wall-basalt",
      ground: "sand",
      floor: (x, y) =>
        lavaPool(x, y)
          ? [tile("basalt"), tile("lava-crust"), tile("lava")]
          : crust(x, y)
            ? [tile("basalt"), tile("lava-crust")]
            : [tile("basalt")],
      props: [
        ["obsidian-vein-1", 30],
        ["obsidian-vein-2", 40],
      ],
    },
  } satisfies Record<string, Style>;
})();

type StyleId = keyof typeof STYLES;

/**
 * The caves under Rune Isle, dug into the board after the surface is built.
 * Everything is placed in map coordinates and kept off the two towns' chunks,
 * because every level of a chunk is sent to whoever stands on it.
 */
export class Digger {
  private readonly levels = new Map<number, Map<number, Cell>>();
  private readonly protectedCells = new Set<string>();
  readonly places: CavePlace[] = [];
  readonly entrances: Entrance[] = [];
  private readonly townChunks = new Set<string>();
  private readonly surfaceEdits: Array<{ x: number; y: number; z: number; stack: PlacedTile[] }> =
    [];

  constructor(
    private readonly b: Builder,
    private readonly tilesById: Record<string, TileDef>,
  ) {
    for (const id of ["druids", "warriors"] as const) {
      const s = b.plan.sites.get(id)!;
      const a = b.world(s.x0, s.y0, 0);
      const c = b.world(s.x1, s.y1, 0);
      for (let cy = Math.floor(a.y / CHUNK_SIZE); cy <= Math.floor(c.y / CHUNK_SIZE); cy++)
        for (let cx = Math.floor(a.x / CHUNK_SIZE); cx <= Math.floor(c.x / CHUNK_SIZE); cx++)
          this.townChunks.add(`${cx},${cy}`);
    }
  }

  private get w() {
    return this.b.island.width;
  }
  private get h() {
    return this.b.island.height;
  }
  /** Grid cell of a map coordinate. */
  private gx(x: number) {
    return x - this.b.board.ox;
  }
  private gy(y: number) {
    return y - this.b.board.oy;
  }
  private top(x: number, y: number) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
    return this.b.island.level[y * this.w + x]!;
  }

  private layer(z: number) {
    let l = this.levels.get(z);
    if (!l) this.levels.set(z, (l = new Map()));
    return l;
  }

  private inTown(x: number, y: number) {
    const m = this.b.world(x, y, 0);
    return this.townChunks.has(`${Math.floor(m.x / CHUNK_SIZE)},${Math.floor(m.y / CHUNK_SIZE)}`);
  }

  private inSite(x: number, y: number) {
    return this.b.plan.siteOf[y * this.w + x]! > 0;
  }

  /** A cell of a raised column below its top: its ground layers with a hill wall over them, nothing else. */
  private isFill(x: number, y: number, z: number) {
    const wall = this.b.board.get(x, y, z)?.at(-1);
    return !!wall && FILL_WALLS.has(wall.tileId) && !wall.direction;
  }

  private seals(x: number, y: number, z: number) {
    const s = this.b.board.get(x, y, z);
    if (!s) return false;
    const o = stackOcclusion(s, this.tilesById);
    return o.sealsLevel || o.opacity >= 1;
  }

  /**
   * Whether a cave cell may be opened at `x, y, z`. Above ground it has to be
   * the fill of a hill with fill or the hill's own floor over it, and two cells
   * of fill to every side, so its wall is a cell of rock inside the hill. Below
   * ground the column has to be sealed from the sky by the surface.
   */
  private diggable(x: number, y: number, z: number): boolean {
    if (this.top(x, y) < 0) return false;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (this.top(nx, ny) < 0 || this.inTown(nx, ny)) return false;
        if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && this.inSite(nx, ny)) return false;
        if (z >= 0 && !this.isFill(nx, ny, z) && !this.layer(z).has(ny * this.w + nx)) return false;
      }
    if (z >= 0) return this.seals(x, y, z + 1);
    for (let zz = 0; zz <= this.top(x, y); zz++) if (this.seals(x, y, zz)) return true;
    return false;
  }

  private open(x: number, y: number, z: number, cell: Cell, pinned = false) {
    const i = y * this.w + x;
    const l = this.layer(z);
    const had = l.get(i);
    if (had?.fixed && !cell.fixed) return;
    if (had && had.kind !== Kind.Floor && cell.kind === Kind.Floor && !cell.fixed) return;
    l.set(i, cell);
    if (pinned) this.protectedCells.add(`${x},${y},${z}`);
  }

  private dig(x: number, y: number, z: number, style: Style) {
    if (this.layer(z).has(y * this.w + x) || this.diggable(x, y, z))
      this.open(x, y, z, { kind: Kind.Floor, style });
  }

  private pin(x: number, y: number, z: number, style: Style, fixed?: PlacedTile[], edge = false) {
    if (!edge && !this.layer(z).has(y * this.w + x) && !this.diggable(x, y, z)) {
      const at = this.b.world(x, y, z);
      this.plainProblems.push(`${at.x},${at.y} L${z} cannot be dug`);
    }
    this.open(x, y, z, { kind: Kind.Floor, style, fixed }, true);
  }

  /** A room as a noisy ellipse round a map coordinate, with rock left standing where the noise is low. */
  room(name: string, mx: number, my: number, z: number, rx: number, ry: number, style: StyleId) {
    const st = STYLES[style];
    const cx = this.gx(mx);
    const cy = this.gy(my);
    const seed = hashName(name);
    for (let y = cy - ry - 3; y <= cy + ry + 3; y++)
      for (let x = cx - rx - 3; x <= cx + rx + 3; x++) {
        const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
        const wobble = (noise(x, y, seed, 5) - 0.5) * 0.7;
        if (d > 1 + wobble) continue;
        if (d < 0.6 && noise(x, y, seed + 1, 2.2) > 0.84) continue;
        this.dig(x, y, z, st);
      }
  }

  /**
   * A warren: `count` chambers scattered round a map cell inside `spread`,
   * each joined by a passage to the nearest one placed before it, and a few
   * passages more so that the warren has loops rather than dead ends only.
   */
  warren(
    name: string,
    mx: number,
    my: number,
    z: number,
    spread: [number, number],
    count: number,
    style: StyleId,
  ) {
    const random = mulberry32(hashName(name) ^ 0x3a11);
    const rooms: Array<[number, number]> = [[mx, my]];
    for (let tries = 0; rooms.length < count && tries < count * 20; tries++) {
      const x = Math.round(mx + (random() * 2 - 1) * spread[0]);
      const y = Math.round(my + (random() * 2 - 1) * spread[1]);
      if (rooms.some(([ax, ay]) => Math.hypot(ax - x, ay - y) < 14)) continue;
      rooms.push([x, y]);
    }
    rooms.forEach(([x, y], k) => {
      const rx = k === 0 ? 12 : 6 + Math.floor(random() * 7);
      const ry = k === 0 ? 8 : 4 + Math.floor(random() * 4);
      this.room(`${name} ${k}`, x, y, z, rx, ry, style);
      if (k === 0) return;
      const near = rooms
        .slice(0, k)
        .sort((a, b) => Math.hypot(a[0] - x, a[1] - y) - Math.hypot(b[0] - x, b[1] - y));
      this.tunnel(`${name} ${k}`, [near[0]!, [x, y]], z, style, 3);
      if (near[1] && random() < 0.35) this.tunnel(`${name} ${k}b`, [near[1], [x, y]], z, style, 2);
    });
  }

  /** A rectangular hall, for the barrow. */
  hall(mx0: number, my0: number, mx1: number, my1: number, z: number, style: StyleId) {
    for (let y = this.gy(my0); y <= this.gy(my1); y++)
      for (let x = this.gx(mx0); x <= this.gx(mx1); x++) this.dig(x, y, z, STYLES[style]);
  }

  /** A passage `width` cells across through map coordinates, wandering between them. */
  tunnel(name: string, points: Array<[number, number]>, z: number, style: StyleId, width = 3) {
    const st = STYLES[style];
    const random = mulberry32(hashName(name));
    const path: Array<[number, number]> = [];
    for (let k = 0; k + 1 < points.length; k++) {
      const [ax, ay] = [this.gx(points[k]![0]), this.gy(points[k]![1])];
      const [bx, by] = [this.gx(points[k + 1]![0]), this.gy(points[k + 1]![1])];
      const len = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
      const legs = Math.max(1, Math.round(len / 14));
      let px = ax;
      let py = ay;
      for (let leg = 1; leg <= legs; leg++) {
        const t = leg / legs;
        const jitter = leg === legs ? 0 : 3;
        const qx = Math.round(ax + (bx - ax) * t + (random() - 0.5) * 2 * jitter);
        const qy = Math.round(ay + (by - ay) * t + (random() - 0.5) * 2 * jitter);
        let x = px;
        let y = py;
        path.push([x, y]);
        while (x !== qx || y !== qy) {
          const dx = qx - x;
          const dy = qy - y;
          if (Math.abs(dx) > Math.abs(dy) || (Math.abs(dx) === Math.abs(dy) && random() < 0.5))
            x += Math.sign(dx);
          else y += Math.sign(dy);
          path.push([x, y]);
        }
        px = qx;
        py = qy;
      }
    }
    const lo = -Math.floor((width - 1) / 2);
    for (const [x, y] of path)
      for (let dy = lo; dy < lo + width; dy++)
        for (let dx = lo; dx < lo + width; dx++) this.dig(x + dx, y + dy, z, st);
  }

  /**
   * A flight of `stone-stairs` two cells wide from `zLow` up to the level
   * above, climbed heading `climbs` from map cell `mx, my`. The two cells
   * over the flight are left empty: that is where a body climbs out
   * (`docs/notes.md`, "A ramp between two levels needs a hole above it").
   */
  stairs(
    mx: number,
    my: number,
    zLow: number,
    climbs: Dir,
    low: StyleId,
    high: StyleId,
  ): { below: [number, number]; above: [number, number] } {
    const [dx, dy] = STEP[climbs];
    const [sx, sy] = STEP[SIDEWAYS[climbs]];
    const facing = OPPOSITE[climbs] as Direction;
    const x0 = this.gx(mx);
    const y0 = this.gy(my);
    const surfaceAbove = zLow + 1 > -1 && this.top(x0, y0) === zLow + 1;
    for (let k = 0; k < 2; k++) {
      const at = (n: number) => [x0 + dx * n + sx * k, y0 + dy * n + sy * k] as const;
      for (const n of [-2, -1]) {
        const [x, y] = at(n);
        this.pin(x, y, zLow, STYLES[low]);
      }
      const [lx, ly] = at(0);
      const [hx, hy] = at(1);
      this.pin(lx, ly, zLow, STYLES[low], [tile("dirt"), tile("stone-stairs", facing)]);
      this.pin(hx, hy, zLow, STYLES[low], [
        tile("dirt"),
        tile("half-stone"),
        tile("stone-stairs", facing),
      ]);
      for (const [x, y] of [at(0), at(1)]) {
        this.open(x, y, zLow + 1, { kind: Kind.Shaft, style: STYLES[high] }, true);
        if (surfaceAbove) this.surfaceEdits.push({ x, y, z: zLow + 1, stack: [] });
      }
      for (const n of [2, 3]) {
        const [x, y] = at(n);
        if (surfaceAbove) this.requirePlain(x, y, zLow + 1);
        else this.pin(x, y, zLow + 1, STYLES[high]);
      }
    }
    if (surfaceAbove) {
      this.requirePlain(x0 - sx, y0 - sy, zLow + 1);
      this.requirePlain(x0 + dx - sx, y0 + dy - sy, zLow + 1);
      this.requirePlain(x0 + 2 * sx, y0 + 2 * sy, zLow + 1);
      this.requirePlain(x0 + dx + 2 * sx, y0 + dy + 2 * sy, zLow + 1);
    }
    return { below: [mx - dx * 2, my - dy * 2], above: [mx + dx * 3, my + dy * 3] };
  }

  /** A ladder from `zLow` to the level above, with a floor to stand on round its foot. */
  ladder(mx: number, my: number, zLow: number, low: StyleId, high: StyleId) {
    const x = this.gx(mx);
    const y = this.gy(my);
    if (this.top(x, y) > zLow + 1 && zLow + 1 >= 0)
      throw new Error(`a ladder at ${mx},${my} would come up inside a hill`);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) if (dx || dy) this.pin(x + dx, y + dy, zLow, STYLES[low]);
    this.pin(x, y, zLow, STYLES[low], [tile("dirt"), tile("ladder-up")]);
    if (this.top(x, y) === zLow + 1) {
      this.requirePlain(x, y, zLow + 1);
      this.surfaceEdits.push({
        x,
        y,
        z: zLow + 1,
        stack: [tile(this.b.base(x, y)), tile("ladder-top")],
      });
    } else {
      this.pin(x, y, zLow + 1, STYLES[high], [tile("dirt"), tile("ladder-top")]);
      for (const [ox, oy] of N8) this.pin(x + ox, y + oy, zLow + 1, STYLES[high]);
    }
  }

  /** A hole in the floor of `zUpper` that drops a body onto the floor below. */
  hole(mx: number, my: number, zUpper: number, low: StyleId, high: StyleId) {
    const x = this.gx(mx);
    const y = this.gy(my);
    const surface = this.top(x, y) === zUpper;
    for (let dy = 0; dy <= 1; dy++)
      for (let dx = 0; dx <= 1; dx++) {
        if (surface) {
          this.requirePlain(x + dx, y + dy, zUpper);
          this.surfaceEdits.push({
            x: x + dx,
            y: y + dy,
            z: zUpper,
            stack: [tile("hole", undefined, { variant: "grass" })],
          });
          this.open(x + dx, y + dy, zUpper, { kind: Kind.Hole, style: STYLES[high] }, true);
        } else {
          this.open(
            x + dx,
            y + dy,
            zUpper,
            {
              kind: Kind.Hole,
              style: STYLES[high],
              fixed: [tile("hole", undefined, { variant: "dirt" })],
            },
            true,
          );
        }
      }
    for (let dy = -1; dy <= 2; dy++)
      for (let dx = -1; dx <= 2; dx++) this.pin(x + dx, y + dy, zUpper - 1, STYLES[low]);
    if (surface) {
      for (let dy = -1; dy <= 2; dy++)
        for (let dx = -1; dx <= 2; dx++)
          if (dx < 0 || dy < 0 || dx > 1 || dy > 1) this.requirePlain(x + dx, y + dy, zUpper);
    }
  }

  private plainProblems: string[] = [];

  /** Bare ground a player can walk on at the top of its column, with nothing built on it. */
  private isPlain(x: number, y: number, z: number) {
    const s = this.b.board.get(x, y, z);
    const i = y * this.w + x;
    return (
      !!s &&
      this.top(x, y) === z &&
      !this.b.plan.road[i] &&
      !this.b.plan.reserved[i] &&
      !this.inSite(x, y) &&
      !this.inTown(x, y) &&
      s.every((p) => !p.span) &&
      !s.some((p) => AWKWARD.has(p.tileId))
    );
  }

  /** A surface cell an entrance needs: plain ground, cleared of whatever grows on it. */
  private requirePlain(x: number, y: number, z: number) {
    if (!this.isPlain(x, y, z)) {
      const at = this.b.world(x, y, z);
      this.plainProblems.push(`${at.x},${at.y} L${z}`);
      return;
    }
    const s = this.b.board.get(x, y, z)!;
    const kept = s.filter((p) => (this.tilesById[p.tileId]?.height ?? 0) === 0);
    if (kept.length !== s.length) this.surfaceEdits.push({ x, y, z, stack: kept });
  }

  /**
   * The plain cell nearest a map coordinate with plain ground for `radius`
   * cells round it on the surface, where an entrance from above can go.
   */
  spot(mx: number, my: number, radius: number, reach = 20): [number, number, number] {
    const tx = this.gx(mx);
    const ty = this.gy(my);
    let best: [number, number, number] | null = null;
    let bestD = Infinity;
    for (let y = ty - reach; y <= ty + reach; y++)
      for (let x = tx - reach; x <= tx + reach; x++) {
        const d = Math.hypot(x - tx, y - ty);
        if (d >= bestD) continue;
        const z = this.top(x, y);
        let ok = z >= 0;
        for (let dy = -radius; ok && dy <= radius; dy++)
          for (let dx = -radius; ok && dx <= radius; dx++) ok = this.isPlain(x + dx, y + dy, z);
        if (!ok) continue;
        best = [x, y, z];
        bestD = d;
      }
    if (!best) throw new Error(`no plain ground within ${reach} of ${mx},${my}`);
    const at = this.b.world(best[0], best[1], best[2]);
    return [at.x, at.y, at.z];
  }

  /**
   * The nearest cliff face to a map cell where a tunnel can leave a hill on
   * level `z` through one `hill-cave-mouth`, preferring the south and east
   * faces the projection shows. The tunnel is two cells wide behind the mouth,
   * and the cell of the face beside the mouth stays rock. Returns the cell
   * four in from the face.
   */
  mouth(
    name: string,
    mx: number,
    my: number,
    z: number,
    mouthTile: string,
    style: StyleId,
    faces: readonly Dir[] = ["s", "e", "w", "n"],
    reach = 30,
  ): { x: number; y: number; d: Dir } {
    const tx = this.gx(mx);
    const ty = this.gy(my);
    let best: { x: number; y: number; d: Dir; rank: number } | null = null;
    for (let y = ty - reach; y <= ty + reach; y++)
      for (let x = tx - reach; x <= tx + reach; x++)
        for (const d of faces) {
          const [dx, dy] = STEP[d];
          const [sx, sy] = STEP[SIDEWAYS[d]];
          const ok = [0, 1].every((k) => {
            const ix = x + sx * k;
            const iy = y + sy * k;
            return (
              this.isFill(ix, iy, z) &&
              !this.inTown(ix, iy) &&
              [1, 2].every((n) => this.isFill(ix - dx * n, iy - dy * n, z)) &&
              [3, 4, 5].every((n) => this.diggable(ix - dx * n, iy - dy * n, z))
            );
          });
          if (!ok || !this.isPlain(x + dx, y + dy, z)) continue;
          const flank = [
            [x - sx, y - sy],
            [x + 2 * sx, y + 2 * sy],
          ].every(([fx, fy]) => this.isFill(fx!, fy!, z) && this.isFill(fx! - dx, fy! - dy, z));
          if (!flank) continue;
          const rank = Math.hypot(x - tx, y - ty) + faces.indexOf(d) * 6;
          if (!best || rank < best.rank) best = { x, y, d, rank };
        }
    if (!best) throw new Error(`${name}: no cliff face on L${z} within ${reach} of ${mx},${my}`);
    const { x, y, d } = best;
    const [dx, dy] = STEP[d];
    const [sx, sy] = STEP[SIDEWAYS[d]];
    this.requirePlain(x + dx, y + dy, z);
    /** The mouth lies on the ground in front of it, which below the snow line is not the frost style's snow: its dirt would spread that ground out onto the land. */
    const outside = this.b.board.get(x + dx, y + dy, z)?.[0]?.tileId ?? STYLES[style].ground;
    this.pin(
      x,
      y,
      z,
      STYLES[style],
      [tile(outside), tile("dirt"), tile(mouthTile, d as Direction)],
      true,
    );
    for (let k = 0; k < 2; k++)
      for (let n = 1; n <= 4; n++)
        this.pin(x + sx * k - dx * n, y + sy * k - dy * n, z, STYLES[style], undefined, n <= 2);
    const at = this.b.world(x, y, z);
    this.entrances.push({ place: name, by: `\`${mouthTile}\` facing ${d}`, at });
    return { x: at.x - dx * 4, y: at.y - dy * 4, d };
  }

  entrance(place: string, by: string, mx: number, my: number, z: number) {
    this.entrances.push({ place, by, at: { x: mx, y: my, z } });
  }

  place(name: string, levels: string, mx: number, my: number, z: number, note: string) {
    this.places.push({ name, levels, at: { x: mx, y: my, z }, note });
  }

  /**
   * Fills back every floor cell not in a two-by-two square of open cells, and
   * every piece of a level that holds none of the pinned cells, which are the
   * ends of its stairs, ladders, holes and mouths.
   */
  private settle() {
    for (const [z, l] of this.levels) {
      const isOpenAt = (x: number, y: number) => l.has(y * this.w + x);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [i, c] of [...l]) {
          if (c.kind !== Kind.Floor || this.isPinned(i, z)) continue;
          const x = i % this.w;
          const y = (i - x) / this.w;
          const square = (ax: number, ay: number) =>
            isOpenAt(ax, ay) &&
            isOpenAt(ax + 1, ay) &&
            isOpenAt(ax, ay + 1) &&
            isOpenAt(ax + 1, ay + 1);
          if (!(square(x, y) || square(x - 1, y) || square(x, y - 1) || square(x - 1, y - 1))) {
            l.delete(i);
            changed = true;
          }
        }
      }
      const seen = new Set<number>();
      for (const start of l.keys()) {
        if (seen.has(start)) continue;
        const piece = [start];
        seen.add(start);
        for (let k = 0; k < piece.length; k++) {
          const i = piece[k]!;
          for (const [dx, dy] of N4) {
            const j = i + dy * this.w + dx;
            if (l.has(j) && !seen.has(j)) {
              seen.add(j);
              piece.push(j);
            }
          }
        }
        if (piece.some((i) => this.isPinned(i, z))) continue;
        if (piece.length > 40) {
          const i = piece[0]!;
          const at = this.b.world(i % this.w, Math.floor(i / this.w), z);
          console.log(
            `  underground: ${piece.length} cells at ${at.x},${at.y} L${z} joined nothing and were filled back`,
          );
        }
        for (const i of piece) l.delete(i);
      }
    }
  }

  private isPinned(i: number, z: number) {
    const x = i % this.w;
    return this.protectedCells.has(`${x},${(i - x) / this.w},${z}`);
  }

  /** Props against the walls: never beside a pinned cell, never where they would split the floor. */
  private furnish(z: number, l: Map<number, Cell>, floors: Map<number, PlacedTile[]>) {
    const random = mulberry32(0x5707e + z * 977);
    const blocked = new Set<number>();
    const walkable = (j: number) => l.get(j)?.kind === Kind.Floor && !blocked.has(j);
    const near = (i: number) => {
      const x = i % this.w;
      const y = (i - x) / this.w;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          if (
            this.protectedCells.has(`${x + dx},${y + dy},${z}`) ||
            this.protectedCells.has(`${x + dx},${y + dy},${z + 1}`)
          )
            return true;
      return false;
    };
    for (const [i, c] of l) {
      if (c.kind !== Kind.Floor || c.fixed || near(i)) continue;
      const stack = floors.get(i)!;
      if (stack.some((p) => ["water", "lava", "ice"].includes(p.tileId))) continue;
      for (const [id, per] of c.style.props) {
        if (random() * per >= 1) continue;
        const ring = N8.map(([dx, dy]) => walkable(i + dy * this.w + dx));
        const rock = ring.filter((o) => !o).length;
        let runs = 0;
        for (let k = 0; k < 8; k++) if (ring[k] && !ring[(k + 7) % 8]) runs++;
        const behind = [-this.w, -1, -this.w - 1].every((o) => walkable(i + o));
        if (rock < 2 || runs > 1 || !behind) continue;
        blocked.add(i);
        stack.push(tile(id));
        break;
      }
    }
  }

  /** Writes every cave onto the board and returns the number of cells it added. */
  write(): number {
    this.settle();
    if (this.plainProblems.length)
      throw new Error(
        `underground: entrances need bare ground at ${this.plainProblems.join("; ")}`,
      );
    const board = this.b.board;
    const before = board.cellCount();
    for (const e of this.surfaceEdits) board.set(e.x, e.y, e.z, e.stack);
    for (const [z, l] of this.levels) {
      const floors = new Map<number, PlacedTile[]>();
      for (const [i, c] of l) {
        const x = i % this.w;
        const y = (i - x) / this.w;
        const under = z >= 0 ? [tile(groundAt(c.style, z))] : [];
        if (c.kind === Kind.Floor && !c.fixed) {
          floors.set(i, [...under, tile("dirt"), ...c.style.floor(x + board.ox, y + board.oy)]);
        } else if (c.fixed?.[0]?.tileId === "dirt" && z >= 0) {
          c.fixed = [...under, ...c.fixed];
        }
      }
      this.furnish(z, l, floors);
      for (const [i, c] of l) {
        const x = i % this.w;
        const y = (i - x) / this.w;
        if (c.kind === Kind.Shaft) {
          if (!this.surfaceEdits.some((e) => e.x === x && e.y === y && e.z === z))
            board.set(x, y, z, []);
        } else if (c.kind === Kind.Hole) {
          if (c.fixed) board.set(x, y, z, c.fixed);
        } else board.set(x, y, z, c.fixed ?? floors.get(i)!);
      }
      for (const [i, c] of l) {
        const x = i % this.w;
        const y = (i - x) / this.w;
        for (const [dx, dy] of N8) {
          const j = i + dy * this.w + dx;
          if (l.has(j)) continue;
          const nx = x + dx;
          const ny = y + dy;
          const rock = board.get(nx, ny, z);
          if (z >= 0 && this.isFill(nx, ny, z))
            board.set(nx, ny, z, [tile(c.style.ground), rock!.at(-1)!]);
          else if (z < 0 && !rock) board.set(nx, ny, z, [tile("dirt"), tile(c.style.wall)]);
        }
      }
    }
    return board.cellCount() - before;
  }

  summary(cells: number): Underground {
    return {
      places: this.places,
      entrances: this.entrances,
      cells,
      levels: [...this.levels.keys()].sort((a, b) => a - b),
    };
  }
}

function hashName(name: string): number {
  let h = 2166136261;
  for (let k = 0; k < name.length; k++) h = Math.imul(h ^ name.charCodeAt(k), 16777619);
  return h >>> 0;
}
