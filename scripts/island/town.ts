import type { Direction } from "../../app/lib/types";
import { tile } from "./board";
import type { Builder, Building, HouseStyle, Rect } from "./build";
import type { Site } from "./plan";

const FREE = 0;
const STREET = 1;
const BUILT = 2;
const YARD = 3;

export type Point = { x: number; y: number };

/**
 * A settlement's ground plan in board cells: which cells are street, which
 * are taken by a building or a yard, and what is still free. Buildings are
 * placed beside a street with their door onto it, nearest their anchor.
 * The whole site stands on one ground, the one most of it had, so no line
 * between two grounds runs under a floor or a street.
 */
export class Town {
  readonly grid: Uint8Array;
  readonly w: number;
  readonly h: number;
  readonly z: number;

  constructor(
    readonly b: Builder,
    readonly site: Site,
    readonly streetTile = "cobblestone",
  ) {
    this.w = site.x1 - site.x0 + 1;
    this.h = site.y1 - site.y0 + 1;
    this.grid = new Uint8Array(this.w * this.h);
    this.z = site.level;
    const kinds = new Map<number, number>();
    for (let y = site.y0; y <= site.y1; y++) {
      for (let x = site.x0; x <= site.x1; x++) {
        const i = y * b.island.width + x;
        if (b.island.level[i] === site.level && b.plan.siteOf[i])
          kinds.set(b.island.ground[i]!, (kinds.get(b.island.ground[i]!) ?? 0) + 1);
      }
    }
    const ground = [...kinds].sort((a, c) => c[1] - a[1])[0]?.[0];
    for (let y = site.y0; y <= site.y1; y++) {
      for (let x = site.x0; x <= site.x1; x++) {
        const i = y * b.island.width + x;
        if (ground !== undefined && b.island.level[i] === site.level && b.plan.siteOf[i])
          b.island.ground[i] = ground;
      }
    }
    for (let y = site.y0; y <= site.y1; y++) {
      for (let x = site.x0; x <= site.x1; x++) {
        const i = y * b.island.width + x;
        if (b.island.level[i] !== site.level || !b.plan.siteOf[i])
          this.grid[this.local(x, y)] = YARD;
        else b.clear(x, y, this.z);
      }
    }
  }

  get centre(): Point {
    return { x: (this.site.x0 + this.site.x1) >> 1, y: (this.site.y0 + this.site.y1) >> 1 };
  }

  private local(x: number, y: number) {
    return (y - this.site.y0) * this.w + (x - this.site.x0);
  }

  inSite(x: number, y: number, border = 0) {
    return (
      x >= this.site.x0 + border &&
      x <= this.site.x1 - border &&
      y >= this.site.y0 + border &&
      y <= this.site.y1 - border
    );
  }

  at(x: number, y: number): number {
    return this.inSite(x, y) ? this.grid[this.local(x, y)]! : YARD;
  }

  mark(x: number, y: number, value: number) {
    if (this.inSite(x, y)) this.grid[this.local(x, y)] = value;
  }

  isStreet(x: number, y: number) {
    return this.at(x, y) === STREET;
  }

  street(x: number, y: number) {
    if (!this.inSite(x, y) || this.at(x, y) === BUILT) return;
    if (this.at(x, y) === YARD && this.b.board.get(x, y, this.z) === undefined) return;
    this.mark(x, y, STREET);
    this.b.board.set(x, y, this.z, [tile(this.b.base(x, y)), tile(this.streetTile)]);
  }

  fillStreet(r: Rect) {
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) this.street(x, y);
  }

  /** A street `width` wide from `a` to `b`, along x first and then y. */
  lane(a: Point, c: Point, width = 3, yFirst = false) {
    const half = Math.floor(width / 2);
    const brush = (x: number, y: number) => {
      for (let dy = -half; dy < width - half; dy++)
        for (let dx = -half; dx < width - half; dx++) this.street(x + dx, y + dy);
    };
    let { x, y } = a;
    const stepX = () => {
      while (x !== c.x) {
        brush(x, y);
        x += Math.sign(c.x - x);
      }
    };
    const stepY = () => {
      while (y !== c.y) {
        brush(x, y);
        y += Math.sign(c.y - y);
      }
    };
    if (yFirst) {
      stepY();
      stepX();
    } else {
      stepX();
      stepY();
    }
    brush(x, y);
  }

  yard(r: Rect, ground?: string) {
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        if (!this.inSite(x, y)) continue;
        this.mark(x, y, YARD);
        if (ground) this.b.board.set(x, y, this.z, [tile(this.b.base(x, y)), tile(ground)]);
      }
    }
  }

  private fits(r: Rect, border: number): boolean {
    for (let y = r.y0 - 1; y <= r.y1 + 1; y++) {
      for (let x = r.x0 - 1; x <= r.x1 + 1; x++) {
        const inner = x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
        if (inner) {
          if (!this.inSite(x, y, border) || this.at(x, y) !== FREE) return false;
        } else if (this.at(x, y) === BUILT) return false;
      }
    }
    return true;
  }

  /** Where the door goes on each side of a rect, and the cell just outside it. */
  private doors(r: Rect): Array<{ wall: Direction; out: Point }> {
    const mx = Math.floor((r.x0 + r.x1) / 2);
    const my = Math.floor((r.y0 + r.y1) / 2);
    return [
      { wall: "s", out: { x: mx, y: r.y1 + 1 } },
      { wall: "n", out: { x: mx, y: r.y0 - 1 } },
      { wall: "e", out: { x: r.x1 + 1, y: my } },
      { wall: "w", out: { x: r.x0 - 1, y: my } },
    ];
  }

  /**
   * Places a building of `w` by `d` (either way round) beside a street,
   * nearest `anchor`, with its door opening onto the street.
   */
  place(
    key: string,
    label: string,
    w: number,
    d: number,
    anchor: Point,
    style: HouseStyle = {},
    border = 2,
  ): Building {
    let best: { r: Rect; wall: Direction; score: number } | null = null;
    for (const [bw, bd] of w === d
      ? [[w, d]]
      : [
          [w, d],
          [d, w],
        ]) {
      for (let y0 = this.site.y0; y0 <= this.site.y1 - bd + 1; y0++) {
        for (let x0 = this.site.x0; x0 <= this.site.x1 - bw + 1; x0++) {
          const r = { x0, y0, x1: x0 + bw - 1, y1: y0 + bd - 1 };
          const cx = (r.x0 + r.x1) / 2;
          const cy = (r.y0 + r.y1) / 2;
          const distance = Math.hypot(cx - anchor.x, cy - anchor.y);
          if (best && distance >= best.score) continue;
          if (!this.fits(r, border)) continue;
          const door = this.doors(r).find(({ out }) => this.isStreet(out.x, out.y));
          if (!door) continue;
          best = { r, wall: door.wall, score: distance };
        }
      }
    }
    if (!best) throw new Error(`no room in the ${this.site.id} site for ${label}`);
    for (let y = best.r.y0; y <= best.r.y1; y++)
      for (let x = best.r.x0; x <= best.r.x1; x++) this.mark(x, y, BUILT);
    return this.b.house(key, label, best.r, this.z, best.wall, style);
  }

  /** Free cells beside a street, one every `spacing` cells along it, for lamp posts. */
  lampPosts(route: string, spacing: number) {
    const taken: Point[] = [];
    for (let y = this.site.y0; y <= this.site.y1; y++) {
      for (let x = this.site.x0; x <= this.site.x1; x++) {
        if (this.at(x, y) !== FREE) continue;
        const beside = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(([dx, dy]) => this.isStreet(x + dx!, y + dy!));
        if (!beside) continue;
        const nearDoor = this.b.buildings.some(
          (b) => Math.abs(b.door.x - x) + Math.abs(b.door.y - y) <= 2,
        );
        if (nearDoor) continue;
        if (taken.some((p) => Math.max(Math.abs(p.x - x), Math.abs(p.y - y)) < spacing)) continue;
        taken.push({ x, y });
        this.mark(x, y, YARD);
        this.b.board.push(x, y, this.z, tile("lamppost-off"));
        this.b.lamps.push({ ...this.b.world(x, y, this.z), route });
      }
    }
  }

  /** Lays a cell of street from a door out to the street, for a building placed against a yard. */
  freeCells(r: Rect): Point[] {
    const out: Point[] = [];
    for (let y = r.y0; y <= r.y1; y++)
      for (let x = r.x0; x <= r.x1; x++) if (this.at(x, y) === FREE) out.push({ x, y });
    return out;
  }
}

export const RECT = (x: number, y: number, w: number, h: number): Rect => ({
  x0: x,
  y0: y,
  x1: x + w - 1,
  y1: y + h - 1,
});
