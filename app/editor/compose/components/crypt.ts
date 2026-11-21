import type { Direction } from "../../../lib/types";
import { isOpen, mulberry32, newGrid, setOpen, type Bounds, type CellGrid } from "../../generator";

type Room = { x0: number; y0: number; x1: number; y1: number };

export type CryptOptions = {
  seed: number;
  density: number;
  /** Cells of rock kept between two rooms, which is how long the shortest corridor is. */
  spacing: number;
  /** How many cells across a corridor is. */
  width: number;
};

/** A corridor cell just outside a room, facing the way the corridor runs, where a door can go. */
export type Doorway = { x: number; y: number; facing: Direction };

const ROOM_W = { min: 4, spread: 6 } as const;
const ROOM_H = { min: 3, spread: 5 } as const;
/** Frame cells per room, from the sparsest crypt to the densest. */
const CELLS_PER_ROOM = { sparse: 160, dense: 60 } as const;
const MAX_ROOMS = 30;
const PLACE_ATTEMPTS = 300;
/** The chance of a second corridor out of a room, so a crypt has loops and not only dead ends. */
const LOOP_CHANCE = 0.25;

const centre = (r: Room) => ({
  x: Math.floor((r.x0 + r.x1) / 2),
  y: Math.floor((r.y0 + r.y1) / 2),
});

/**
 * Rectangular rooms that keep `spacing` cells of rock between them, joined
 * by corridors `width` cells wide that turn once, along the shortest tree
 * that reaches every room. Where a corridor leaves a room it names a
 * doorway, one cell per cell of its width.
 */
export function carveCrypt(
  bounds: Bounds,
  options: CryptOptions,
): { grid: CellGrid; doorways: Doorway[] } {
  const g = newGrid(bounds);
  const random = mulberry32(options.seed >>> 0);
  const gap = options.spacing;
  const area = (bounds.maxX - bounds.minX + 1) * (bounds.maxY - bounds.minY + 1);
  const t = Math.min(1, Math.max(0, options.density / 100));
  const perRoom = CELLS_PER_ROOM.sparse + (CELLS_PER_ROOM.dense - CELLS_PER_ROOM.sparse) * t;
  const wanted = Math.min(MAX_ROOMS, Math.max(2, Math.round(area / perRoom)));
  const rooms: Room[] = [];
  for (let i = 0; i < PLACE_ATTEMPTS && rooms.length < wanted; i++) {
    const w = ROOM_W.min + Math.floor(random() * ROOM_W.spread);
    const h = ROOM_H.min + Math.floor(random() * ROOM_H.spread);
    const spanX = bounds.maxX - bounds.minX - w - 1;
    const spanY = bounds.maxY - bounds.minY - h - 1;
    if (spanX < 1 || spanY < 1) continue;
    const x0 = bounds.minX + 1 + Math.floor(random() * spanX);
    const y0 = bounds.minY + 1 + Math.floor(random() * spanY);
    const room = { x0, y0, x1: x0 + w - 1, y1: y0 + h - 1 };
    const clear = rooms.every(
      (r) =>
        room.x0 > r.x1 + gap ||
        room.x1 < r.x0 - gap ||
        room.y0 > r.y1 + gap ||
        room.y1 < r.y0 - gap,
    );
    if (clear) rooms.push(room);
  }
  const inRoom = (x: number, y: number) =>
    rooms.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
  for (const r of rooms) {
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) setOpen(g, x, y, true);
  }

  const doorways = new Map<string, Doorway>();
  const corridor = (a: Room, b: Room) => {
    const from = centre(a);
    const to = centre(b);
    const bend = random() < 0.5 ? { x: to.x, y: from.y } : { x: from.x, y: to.y };
    const path: Array<{ x: number; y: number; facing: Direction }> = [];
    for (const [p, q] of [
      [from, bend],
      [bend, to],
    ] as const) {
      const dx = Math.sign(q.x - p.x);
      const dy = Math.sign(q.y - p.y);
      const facing: Direction = dx !== 0 ? "e" : "s";
      for (let x = p.x, y = p.y; ; x += dx, y += dy) {
        path.push({ x, y, facing });
        if (x === q.x && y === q.y) break;
      }
    }
    /** A corridor is widened across the way it runs, and fully at the bend, so it turns without a notch. */
    const across = (c: (typeof path)[number]) =>
      Array.from({ length: options.width }, (_, k) =>
        c.facing === "e" ? { x: c.x, y: c.y + k } : { x: c.x + k, y: c.y },
      );
    for (const c of path) for (const cell of across(c)) setOpen(g, cell.x, cell.y, true);
    for (let k = 0; k < options.width; k++) {
      for (let j = 0; j < options.width; j++) setOpen(g, bend.x + k, bend.y + j, true);
    }
    for (let i = 1; i < path.length; i++) {
      const before = path[i - 1]!;
      const here = path[i]!;
      const leaving = inRoom(before.x, before.y) && !inRoom(here.x, here.y);
      const entering = !inRoom(before.x, before.y) && inRoom(here.x, here.y);
      const at = leaving ? here : entering ? before : null;
      if (!at) continue;
      for (const cell of across({ ...at, facing: here.facing })) {
        if (!inRoom(cell.x, cell.y)) {
          doorways.set(`${cell.x},${cell.y}`, { ...cell, facing: here.facing });
        }
      }
    }
  };
  const distance = (a: Room, b: Room) =>
    Math.abs(centre(a).x - centre(b).x) + Math.abs(centre(a).y - centre(b).y);
  const joined = rooms.slice(0, 1);
  const waiting = rooms.slice(1);
  while (waiting.length > 0) {
    let best = { from: 0, to: 0, d: Infinity };
    waiting.forEach((r, to) =>
      joined.forEach((j, from) => {
        const d = distance(j, r);
        if (d < best.d) best = { from, to, d };
      }),
    );
    const [next] = waiting.splice(best.to, 1);
    corridor(joined[best.from]!, next!);
    if (joined.length > 1 && random() < LOOP_CHANCE) {
      const other = joined.filter((_, i) => i !== best.from);
      corridor(other[Math.floor(random() * other.length)]!, next!);
    }
    joined.push(next!);
  }

  /**
   * A doorway is a door only where it is a gap in rock: rock on both sides
   * of the corridor's width, and floor ahead and behind. One where corridors
   * cross or run into each other is left open.
   */
  const kept = [...doorways.values()].filter((d) => {
    const side = d.facing === "e" ? { x: 0, y: 1 } : { x: 1, y: 0 };
    const ahead = d.facing === "e" ? { x: 1, y: 0 } : { x: 0, y: 1 };
    let lo = { x: d.x, y: d.y };
    while (doorways.has(`${lo.x - side.x},${lo.y - side.y}`))
      lo = { x: lo.x - side.x, y: lo.y - side.y };
    let hi = { x: d.x, y: d.y };
    while (doorways.has(`${hi.x + side.x},${hi.y + side.y}`))
      hi = { x: hi.x + side.x, y: hi.y + side.y };
    return (
      !isOpen(g, lo.x - side.x, lo.y - side.y) &&
      !isOpen(g, hi.x + side.x, hi.y + side.y) &&
      isOpen(g, d.x - ahead.x, d.y - ahead.y) &&
      isOpen(g, d.x + ahead.x, d.y + ahead.y)
    );
  });
  return { grid: g, doorways: kept };
}
