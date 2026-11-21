import * as v from "valibot";
import type { StackEdit } from "../../../lib/mapData";
import type { Direction, PlacedTile } from "../../../lib/types";
import { DEFAULT_STAIRS_TILE_ID, stairBlock } from "../../building";
import { placed } from "../../generator";
import type { Component } from "../build";
import { TILES, field } from "../field";
import { bandOffsets, isWet, lineCells, type Cell } from "./line";
import { STEP } from "./ramp";

const WallSchema = v.object({
  from: field.point(),
  via: v.optional(field.points(), []),
  to: field.point(),
  closed: v.optional(v.boolean(), false),
  height: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3)), 1),
  thickness: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(4)), 3),
  wall: v.optional(field.tile(TILES.wall), "brick-wall"),
  walkway: v.optional(field.tile(TILES.ground), "flagstone-floor"),
  battlement: v.optional(v.nullable(field.tile(TILES.halfBlock)), "brick-slab"),
  merlonEvery: v.optional(v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(4)), 3),
  gates: v.optional(field.points(), []),
  gateWidth: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3)), 2),
  door: v.optional(v.nullable(field.tile(TILES.door)), null),
  stairs: v.optional(field.points(), []),
  stairsTile: v.optional(field.tile(TILES.stairs), DEFAULT_STAIRS_TILE_ID),
});

export type WallProps = v.InferOutput<typeof WallSchema>;

const DIRECTIONS: readonly Direction[] = ["n", "e", "s", "w"];
const OPPOSITE: Record<Direction, Direction> = { n: "s", s: "n", e: "w", w: "e" };

/** How far from its point a flight of stairs is looked for before the wall is refused. */
const STAIRS_REACH = 12;

const at = (c: Cell) => `${c.x},${c.y}`;
const plus = (c: Cell, by: Cell, steps = 1): Cell => ({
  x: c.x + by.x * steps,
  y: c.y + by.y * steps,
});
const apart = (a: Cell, b: Cell) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** The wall's centre line through its points in order, and back to the first when it is closed. */
function centreLine(anchors: readonly Cell[], closed: boolean): Cell[] {
  const stops = closed ? [...anchors, anchors[0]!] : anchors;
  const out: Cell[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    for (const c of lineCells(stops[i]!, stops[i + 1]!)) {
      const last = out.at(-1);
      if (!last || last.x !== c.x || last.y !== c.y) out.push(c);
    }
  }
  if (closed && out.length > 1 && at(out[0]!) === at(out.at(-1)!)) out.pop();
  return out;
}

/**
 * The cells no wall stands on that can be reached from beyond the wall
 * without crossing it. A closed wall leaves the ground it encloses out of
 * this, which is how its outer face is told from its inner one; round an
 * open wall every cell is outside, so both its faces are outer ones.
 */
function outsideOf(band: ReadonlyMap<string, Cell>): (c: Cell) => boolean {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const c of band.values()) {
    minX = Math.min(minX, c.x - 1);
    minY = Math.min(minY, c.y - 1);
    maxX = Math.max(maxX, c.x + 1);
    maxY = Math.max(maxY, c.y + 1);
  }
  const start = { x: minX, y: minY };
  const seen = new Set([at(start)]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    for (const d of DIRECTIONS) {
      const next = plus(queue[head]!, STEP[d]);
      if (next.x < minX || next.y < minY || next.x > maxX || next.y > maxY) continue;
      if (seen.has(at(next)) || band.has(at(next))) continue;
      seen.add(at(next));
      queue.push(next);
    }
  }
  return (c) =>
    !band.has(at(c)) && (c.x < minX || c.y < minY || c.x > maxX || c.y > maxY || seen.has(at(c)));
}

type Gate = { opening: Cell[]; doors: Array<{ cell: Cell; facing: Direction }> };

/**
 * A wall of solid courses `height` levels high with a walkway on top. Every
 * top cell that looks out over the outside is a battlement of half blocks,
 * one block for a crenel and two for every `merlonEvery`th, as a merlon; the
 * rest of the top is walked on. A wall one cell thick is all battlement, so
 * a walkway needs a thickness of two for a closed wall and three for an open
 * one, which has an outer face on both sides.
 *
 * A gate is an opening through the bottom course with the walkway carried
 * over it. Stairs are a flight along the wall's face, two cells a level, up
 * to a landing beside the walkway.
 */
export const wall: Component<WallProps> = {
  type: "wall",
  label: "Castle wall",
  starter: {
    frame: { x: 2, y: 2, w: 24, h: 18 },
    props: {
      from: { x: 1, y: 1 },
      via: [
        { x: 1, y: 1, pinX: "right" },
        { x: 1, y: 1, pinX: "right", pinY: "bottom" },
      ],
      to: { x: 1, y: 1, pinY: "bottom" },
      closed: true,
      gates: [{ x: 0, y: 1, pinX: "center", pinY: "bottom" }],
      stairs: [{ x: 6, y: 4 }],
    },
  },
  schema: WallSchema,
  ownLevels: true,
  build(ctx, props) {
    const anchors: Cell[] = [];
    for (const point of [props.from, ...props.via, props.to]) {
      const cell = ctx.point(point);
      if (!cell) return { ok: false, reason: `There is no node called ${point.in ?? ""}` };
      anchors.push(cell);
    }
    const path = centreLine(anchors, props.closed);
    const offsets = bandOffsets(props.thickness);
    const band = new Map<string, Cell>();
    for (const c of path) {
      for (const dy of offsets) {
        for (const dx of offsets) band.set(`${c.x + dx},${c.y + dy}`, { x: c.x + dx, y: c.y + dy });
      }
    }
    const outside = outsideOf(band);
    const looksOut = (c: Cell) => {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) if (outside({ x: c.x + dx, y: c.y + dy })) return true;
      }
      return false;
    };

    const pathAt = (i: number) =>
      props.closed ? path[((i % path.length) + path.length) % path.length] : path[i];
    const nearestOnPath = (cell: Cell) => {
      let best = 0;
      path.forEach((c, i) => {
        if (apart(c, cell) < apart(path[best]!, cell)) best = i;
      });
      return best;
    };

    const gates: Gate[] = [];
    const opened = new Set<string>();
    const span = bandOffsets(props.gateWidth);
    for (const point of props.gates) {
      const cell = ctx.point(point);
      if (!cell) return { ok: false, reason: `There is no node called ${point.in ?? ""}` };
      const middle = nearestOnPath(cell);
      const reach = props.thickness + props.gateWidth;
      const first = pathAt(middle + span[0]! - reach);
      const last = pathAt(middle + span.at(-1)! + reach);
      const straight =
        first && last && (first.x === last.x || first.y === last.y) && apart(first, last) > 0;
      const run = straight
        ? Array.from({ length: apart(first, last) + 1 }, (_, n) =>
            pathAt(middle + span[0]! - reach + n),
          )
        : [];
      if (!straight || run.some((c) => !c || (c.x !== first.x && c.y !== first.y))) {
        return {
          ok: false,
          reason:
            "A gate needs a straight stretch of wall on both sides. Move it away from the corner or the end of the wall.",
        };
      }
      const through: Cell = first.y === last.y ? { x: 0, y: 1 } : { x: 1, y: 0 };
      const gate: Gate = { opening: [], doors: [] };
      for (const o of span) {
        const c = pathAt(middle + o)!;
        const row = offsets.map((n) => plus(c, through, n));
        gate.opening.push(...row);
        const front = row.find(looksOut) ?? row[0]!;
        gate.doors.push({ cell: front, facing: through.y ? "s" : "e" });
      }
      for (const c of gate.opening) opened.add(at(c));
      gates.push(gate);
    }

    const level = (c: Cell) => ctx.raisedAt(c.x, c.y);
    const raised = level(path[0]!);
    const base = ctx.z + raised;
    const top = base + props.height;
    const groundOf = (c: Cell) =>
      ctx.stackAt(c.x, c.y, base).filter((p) => ctx.tilesById[p.tileId]?.height === 0);

    type Flight = { steps: Cell[]; landing: Cell; onto: Cell; climb: Direction };
    const flights: Flight[] = [];
    const taken = new Set<string>();
    const free = (c: Cell) =>
      !band.has(at(c)) &&
      !taken.has(at(c)) &&
      level(c) === raised &&
      ctx.stackAt(c.x, c.y, base).length > 0 &&
      !isWet(ctx.stackAt(c.x, c.y, base));
    const solid = (c: Cell) => band.has(at(c)) && !opened.has(at(c));
    for (const point of props.stairs) {
      const cell = ctx.point(point);
      if (!cell) return { ok: false, reason: `There is no node called ${point.in ?? ""}` };
      const options: Array<Flight & { far: number }> = [];
      for (const onto of band.values()) {
        if (apart(onto, cell) > STAIRS_REACH + props.thickness) continue;
        for (const side of DIRECTIONS) {
          const landing = plus(onto, STEP[side]);
          if (band.has(at(landing))) continue;
          for (const climb of DIRECTIONS) {
            if (climb === side || climb === OPPOSITE[side]) continue;
            const down = STEP[OPPOSITE[climb]];
            const steps = Array.from({ length: props.height * 2 }, (_, n) =>
              plus(landing, down, props.height * 2 - n),
            );
            const foot = plus(steps[0]!, down);
            const hugs = [...steps, landing].every((c) => solid(plus(c, STEP[OPPOSITE[side]])));
            if (!hugs || ![foot, ...steps, landing].every(free)) continue;
            options.push({ steps, landing, onto, climb, far: apart(landing, cell) });
          }
        }
      }
      const best = options.sort((a, b) => a.far - b.far)[0];
      if (!best || best.far > STAIRS_REACH) {
        return {
          ok: false,
          reason: `There is no room for stairs near ${cell.x},${cell.y}: a flight needs ${props.height * 2 + 2} clear cells in a row along a straight stretch of the wall.`,
        };
      }
      flights.push(best);
      for (const c of [...best.steps, best.landing]) taken.add(at(c));
    }

    for (const c of [...band.values(), ...flights.flatMap((f) => [...f.steps, f.landing])]) {
      if (level(c) === raised) continue;
      return {
        ok: false,
        reason:
          "The ground under this wall is on more than one level. Move it onto flat ground, or put it before the hill in the layers so the hill is raised round it.",
      };
    }

    const tile = (id: string, direction?: Direction) => placed(id, ctx.tilesById, direction);
    const course = (c: Cell, n: number): PlacedTile[] =>
      n === 0 ? [...groundOf(c), tile(props.wall)] : [tile(props.wall)];
    const edits: StackEdit[] = [];
    const stepsDown = new Set(flights.map((f) => at(f.onto)));
    const merlon = (c: Cell) => {
      const n = props.merlonEvery;
      return (((c.x + c.y) % n) + n) % n === 0;
    };

    for (const c of band.values()) {
      for (let n = 0; n < props.height; n++) {
        const open = n === 0 && opened.has(at(c));
        edits.push({ ...c, z: base + n, stack: open ? groundOf(c) : course(c, n) });
      }
      const crown: PlacedTile[] = [tile(props.walkway)];
      if (props.battlement && looksOut(c) && !stepsDown.has(at(c))) {
        crown.push(tile(props.battlement));
        if (merlon(c)) crown.push(tile(props.battlement));
      }
      edits.push({ ...c, z: top, stack: crown });
    }
    if (props.door) {
      for (const { cell, facing } of gates.flatMap((g) => g.doors)) {
        edits.push({ ...cell, z: base, stack: [...groundOf(cell), tile(props.door, facing)] });
      }
    }
    const block = stairBlock(props.stairsTile, ctx.tilesById);
    for (const flight of flights) {
      const facing = OPPOSITE[flight.climb];
      flight.steps.forEach((c, i) => {
        const storey = Math.floor(i / 2);
        for (let n = 0; n < storey; n++) edits.push({ ...c, z: base + n, stack: course(c, n) });
        const stair = tile(props.stairsTile, facing);
        const flightOf = i % 2 === 0 ? [stair] : [tile(block), stair];
        edits.push({
          ...c,
          z: base + storey,
          stack: storey === 0 ? [...groundOf(c), ...flightOf] : flightOf,
        });
      });
      for (let n = 0; n < props.height; n++) {
        edits.push({ ...flight.landing, z: base + n, stack: course(flight.landing, n) });
      }
      edits.push({ ...flight.landing, z: top, stack: [tile(props.walkway)] });
    }
    return { ok: true, edits };
  },
};
