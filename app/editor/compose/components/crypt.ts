import { mulberry32, newGrid, setOpen, type Bounds, type CellGrid } from "../../generator";

type Room = { x0: number; y0: number; x1: number; y1: number };

const ROOM_W = { min: 4, spread: 6 } as const;
const ROOM_H = { min: 3, spread: 5 } as const;
/** Cells of rock between two rooms, so each keeps a wall of its own. */
const ROOM_GAP = 2;
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
 * Rectangular rooms that keep `ROOM_GAP` of rock between them, joined by
 * corridors two cells wide that turn once, along the shortest tree that
 * reaches every room. Two cells is the width the cave's settle keeps.
 */
export function carveCrypt(bounds: Bounds, seed: number, density: number): CellGrid {
  const g = newGrid(bounds);
  const random = mulberry32(seed >>> 0);
  const area = (bounds.maxX - bounds.minX + 1) * (bounds.maxY - bounds.minY + 1);
  const t = Math.min(1, Math.max(0, density / 100));
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
        room.x0 > r.x1 + ROOM_GAP ||
        room.x1 < r.x0 - ROOM_GAP ||
        room.y0 > r.y1 + ROOM_GAP ||
        room.y1 < r.y0 - ROOM_GAP,
    );
    if (clear) rooms.push(room);
  }
  for (const r of rooms) {
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) setOpen(g, x, y, true);
  }

  const corridor = (a: Room, b: Room) => {
    const from = centre(a);
    const to = centre(b);
    const across = random() < 0.5;
    const bend = across ? { x: to.x, y: from.y } : { x: from.x, y: to.y };
    for (const [p, q] of [
      [from, bend],
      [bend, to],
    ] as const) {
      for (let y = Math.min(p.y, q.y); y <= Math.max(p.y, q.y); y++) {
        for (let x = Math.min(p.x, q.x); x <= Math.max(p.x, q.x); x++) {
          for (const [dx, dy] of [
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1],
          ] as const) {
            setOpen(g, x + dx, y + dy, true);
          }
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
  return g;
}
