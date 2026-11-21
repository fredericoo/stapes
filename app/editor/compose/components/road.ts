import * as v from "valibot";
import { stackHeight, type StackEdit } from "../../../lib/mapData";
import type { Direction, PlacedTile } from "../../../lib/types";
import { placed } from "../../generator";
import type { BridgeStyle, Component } from "../build";
import { TILES, field } from "../field";
import {
  DEFAULT_BRIDGE,
  ROUTE_PROPS,
  across,
  bandOffsets,
  isWet,
  lineCells,
  routeOf,
  type RouteCell,
} from "./line";
import { STEP, nearestRamp, rampCells, type RampGround, type RampSite } from "./ramp";

const RoadSchema = v.object({
  ...ROUTE_PROPS,
  tile: v.optional(v.nullable(field.tile(TILES.ground)), "dirt"),
  width: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3)), 1),
  clears: v.optional(field.tiles(TILES.standing), [
    "tree",
    "apple-tree",
    "old-tree",
    "dead-tree",
    "small-bush",
  ]),
  cuts: v.optional(field.tiles(TILES.ground), ["grass"]),
  verge: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(2)), 0),
});

export type RoadProps = v.InferOutput<typeof RoadSchema>;

/** A route cell that is one of a ramp's two cells of slope, which take no road tile. */
type Stepped = RouteCell & { slope?: true };

/** `span` numbers the bridge a cell is part of, and `at` of `of` is how far along it the cell is. */
type Laid = Stepped & { bridge: boolean; span?: number; at?: number; of?: number };

/** How far from where a route meets a cliff it looks for somewhere a ramp fits. */
const RAMP_REACH = 8;

const DIRECTIONS: readonly Direction[] = ["n", "e", "s", "w"];
const OPPOSITE: Record<Direction, Direction> = { n: "s", s: "n", e: "w", w: "e" };

const apart = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/**
 * The shortest way from `start` over cells that are `open`, stepping to four
 * neighbours, to the first cell `goal` gives an index for. It is how a road
 * finds its way round a hill to a ramp: a straight line to the ramp's foot
 * would as often cut the corner of the cliff it is trying to climb.
 */
function pathTo(
  start: { x: number; y: number },
  open: (c: { x: number; y: number }) => boolean,
  goal: (c: { x: number; y: number }) => number | undefined,
): { cells: Array<{ x: number; y: number }>; index: number } | null {
  const key = (c: { x: number; y: number }) => `${c.x},${c.y}`;
  const from = new Map<string, { x: number; y: number } | null>([[key(start), null]]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const c = queue[head]!;
    const index = goal(c);
    if (index !== undefined) {
      const cells = [];
      for (let k: { x: number; y: number } | null = c; k; k = from.get(key(k)) ?? null)
        cells.push(k);
      return { cells: cells.reverse(), index };
    }
    for (const d of DIRECTIONS) {
      const next = { x: c.x + STEP[d].x, y: c.y + STEP[d].y };
      if (from.has(key(next))) continue;
      if (goal(next) === undefined && !open(next)) continue;
      from.set(key(next), c);
      queue.push(next);
    }
  }
  return null;
}

/**
 * Takes the route up and down cliffs by ramps. Where two cells in a row are
 * a level apart the nearest place a ramp fits is found (`rampFits`), and the
 * route is relaid through it: from the ramp's lower end the shortest way back
 * over clear ground on that level to a cell the route has already passed,
 * and from its upper end the shortest way on to a cell the route has yet to
 * reach. A place neither can be reached from is passed over. Where nothing
 * fits within `RAMP_REACH`, or the levels differ by more than one, the route
 * is left as it was and the road is laid on both levels unjoined.
 */
function withRamps(cells: readonly RouteCell[], ground: RampGround) {
  const out: Stepped[] = [];
  const sites: RampSite[] = [];
  const key = (c: { x: number; y: number }) => `${c.x},${c.y}`;
  const level = (c: { x: number; y: number }) => ground.level(c.x, c.y);
  const sided = (path: Array<{ x: number; y: number }>): Stepped[] =>
    path.map((c, n) => {
      const other = path[n + 1] ?? path[n - 1] ?? c;
      return { ...c, side: other.x !== c.x ? { x: 0, y: 1 } : { x: 1, y: 0 } };
    });
  let i = 0;
  while (i < cells.length) {
    const c = cells[i]!;
    const prev = out.at(-1);
    if (!prev || level(prev) === level(c) || Math.abs(level(prev) - level(c)) !== 1) {
      out.push(c);
      i++;
      continue;
    }
    const up = level(c) > level(prev);
    const heading = DIRECTIONS.find(
      (d) => STEP[d].x === c.x - prev.x && STEP[d].y === c.y - prev.y,
    );
    const upper = Math.max(level(c), level(prev));
    const passed = new Map(out.map((k, n) => [key(k), n]));
    const ahead = new Map<string, number>();
    for (let n = cells.length - 1; n >= i; n--) ahead.set(key(cells[n]!), n);
    type Plan = { site: RampSite; from: number; to: number; laid: Stepped[] };
    let plan = null as Plan | null;
    nearestRamp(
      ground,
      up ? c : prev,
      RAMP_REACH,
      (site) => {
        if (ground.level(site.head.x, site.head.y) !== upper) return false;
        const r = rampCells(site);
        const order = up
          ? [r.foot, r.low, r.high, r.head, r.landing]
          : [r.landing, r.head, r.high, r.low, r.foot];
        const taken = new Set(order.map(key));
        const [entry, exit] = [order[0]!, order[4]!];
        const open = (on: number) => (k: { x: number; y: number }) =>
          level(k) === on &&
          !taken.has(key(k)) &&
          apart(k, site.head) <= 2 * RAMP_REACH &&
          ground.clear(k.x, k.y);
        const reached = (index: Map<string, number>, on: number) => (k: { x: number; y: number }) =>
          level(k) === on && !(taken.has(key(k)) && k !== entry && k !== exit)
            ? index.get(key(k))
            : undefined;
        const back = pathTo(entry, open(level(entry)), reached(passed, level(entry)));
        const on = pathTo(exit, open(level(exit)), reached(ahead, level(exit)));
        if (!back || !on) return false;
        const across = { x: Math.abs(STEP[site.side].y), y: Math.abs(STEP[site.side].x) };
        plan = {
          site,
          from: back.index,
          to: on.index,
          laid: [
            ...sided(back.cells.reverse()).slice(1),
            { ...order[1]!, side: across, ...(up ? { slope: true as const } : {}) },
            { ...order[2]!, side: across, slope: true as const },
            { ...order[3]!, side: across, ...(up ? {} : { slope: true as const }) },
            ...sided(on.cells),
          ],
        };
        return true;
      },
      heading && (up ? OPPOSITE[heading] : heading),
    );
    if (!plan) {
      out.push(c);
      i++;
      continue;
    }
    out.length = plan.from + 1;
    out.push(...plan.laid);
    sites.push(plan.site);
    i = plan.to + 1;
  }
  return { cells: out, sites };
}

/** Longest bridge a road will build; past it the far bank is taken to be open sea, and the road stops. */
const MAX_SPAN = 48;

/** How far from a bridge's end the route is relaid to meet it squarely. */
const SQUARE_UP_CELLS = 3;

/**
 * Whether a route cell is near the end of a bridge without being past it in
 * the direction `onward`. A line from past the end to such a cell would
 * double back through the cells beside the end, where the rails go.
 */
function beside(cell: RouteCell, end: { x: number; y: number }, onward: { x: number; y: number }) {
  const dx = cell.x - end.x;
  const dy = cell.y - end.y;
  return (
    dx * onward.x + dy * onward.y < 1 && Math.max(Math.abs(dx), Math.abs(dy)) <= SQUARE_UP_CELLS
  );
}

/**
 * Replaces every stretch of the route that runs over water with one straight
 * bridge. It runs along the crossing's longer axis, or along the step the
 * route entered the water by when the longer axis starts on land, from the
 * last land cell before the water to the first one after it on that line, so
 * a bridge always spans the whole crossing and rests one cell on each bank,
 * rails included, so its outline is a rectangle.
 * The road then rejoins its route across land. A route that ends in water,
 * or whose crossing never reaches land within `MAX_SPAN`, stops at the bank.
 */
function withBridges(
  cells: readonly Stepped[],
  wet: (x: number, y: number) => boolean,
  bridged: (water: readonly RouteCell[]) => boolean,
): Laid[] {
  const out: Laid[] = [];
  let spans = 0;
  let i = 0;
  while (i < cells.length && wet(cells[i]!.x, cells[i]!.y)) i++;
  while (i < cells.length) {
    const c = cells[i]!;
    if (!wet(c.x, c.y)) {
      out.push({ ...c, bridge: false });
      i++;
      continue;
    }
    const bank = out.at(-1)!;
    let j = i;
    while (j < cells.length && wet(cells[j]!.x, cells[j]!.y)) j++;
    if (j >= cells.length) break;
    if (!bridged(cells.slice(i, j))) {
      i = j;
      continue;
    }
    const exit = cells[j]!;
    const entered = { x: c.x - bank.x, y: c.y - bank.y };
    const longer =
      Math.abs(exit.x - bank.x) >= Math.abs(exit.y - bank.y)
        ? { x: Math.sign(exit.x - bank.x), y: 0 }
        : { x: 0, y: Math.sign(exit.y - bank.y) };
    const step = wet(bank.x + longer.x, bank.y + longer.y) ? longer : entered;
    const side = step.x !== 0 ? { x: 0, y: 1 } : { x: 1, y: 0 };
    /**
     * The road comes onto the bridge from straight behind it. A route that
     * steps sideways onto the bank cell would run through where a rail goes,
     * so its last cells round the bank are relaid as a line to the cell
     * behind the bridge, unless that line would itself touch water.
     */
    const behind = { x: bank.x - step.x, y: bank.y - step.y };
    let kept = out.length - 1;
    while (
      kept > 0 &&
      !out[kept - 1]!.bridge &&
      beside(out[kept - 1]!, bank, { x: -step.x, y: -step.y })
    ) {
      kept--;
    }
    const joined = kept > 0 && !out[kept - 1]!.bridge ? out[kept - 1]! : null;
    const approach = joined ? lineCells(joined, behind).slice(1) : [];
    if (joined && !wet(behind.x, behind.y) && !approach.some((k) => wet(k.x, k.y))) {
      const approachSide = across(joined, behind);
      out.length = kept;
      for (const k of approach) out.push({ ...k, side: approachSide, bridge: false });
      out.push({ ...bank, bridge: false });
    }
    const span: Laid[] = [{ x: bank.x, y: bank.y, side, bridge: true }];
    let x = bank.x + step.x;
    let y = bank.y + step.y;
    while (wet(x, y) && span.length <= MAX_SPAN) {
      span.push({ x, y, side, bridge: true });
      x += step.x;
      y += step.y;
    }
    if (span.length > MAX_SPAN) break;
    span.push({ x, y, side, bridge: true });
    span.forEach((cell, n) => Object.assign(cell, { span: spans, at: n, of: span.length }));
    spans++;
    out[out.length - 1] = span[0]!;
    out.push(...span.slice(1));
    /**
     * It leaves the same way: one more cell straight on where there is ground
     * for it, and from there to the first cell of the route that is past the
     * end, so the road turns beyond the rails' ends rather than through one.
     */
    let rejoin = j;
    while (
      rejoin < cells.length - 1 &&
      !wet(cells[rejoin + 1]!.x, cells[rejoin + 1]!.y) &&
      beside(cells[rejoin]!, { x, y }, step)
    ) {
      rejoin++;
    }
    const target = cells[rejoin]!;
    const ahead = { x: x + step.x, y: y + step.y };
    const clear = !wet(ahead.x, ahead.y) && (x !== target.x || y !== target.y);
    const from = clear ? ahead : { x, y };
    if (clear) out.push({ ...ahead, side, bridge: false });
    const joinSide = across(from, target);
    for (const k of lineCells(from, target).slice(1))
      out.push({ ...k, side: joinSide, bridge: false });
    i = rejoin + 1;
  }
  return out;
}

const DEFAULT_RAMP = { slope: "ramp", block: "half-stone" };

/**
 * Lays its tile along the route on the ground the nodes before it left; with
 * no tile it lays nothing of its own and is only the path that bridges and
 * ramps are put on. Through the plants it `clears` it cuts them down, and it
 * goes round nothing, so a cell where anything else stands is left as it is.
 *
 * A crossing of water is one straight bridge (see `withBridges`), in the
 * deck, rail and arc the layer that laid the water declared, the default
 * where none did, and none at all over water declared as not bridged. A
 * cliff is climbed by a ramp (see `withRamps`) in the tiles the hill
 * declared, or by one that is already there.
 */
export const road: Component<RoadProps> = {
  type: "road",
  label: "Road",
  starter: { props: { from: { x: 2, y: 2 }, to: { x: 14, y: 2 } } },
  schema: RoadSchema,
  build(ctx, props) {
    for (const id of [props.tile, ...props.clears]) {
      if (id && !ctx.tilesById[id]) return { ok: false, reason: `There is no tile called ${id}` };
    }
    const route = routeOf(ctx, props);
    if ("reason" in route) return { ok: false, reason: route.reason };
    const band = bandOffsets(props.width);
    const edges = [band[0]! - 1, band.at(-1)! + 1];
    const tile = (id: string, direction?: Direction) => placed(id, ctx.tilesById, direction);
    const clears = new Set([...props.clears, ...props.cuts]);
    const cuts = new Set(props.cuts);
    const written = new Map<string, PlacedTile[]>();
    const below: StackEdit[] = [];
    const at = (x: number, y: number) => `${x},${y}`;
    const wet = (x: number, y: number) => isWet(ctx.stackAt(x, y));

    /** A slope that is already there counts as clear ground, so a second road over a cliff takes the first one's ramp. */
    const isSlope = (x: number, y: number) => {
      const top = ctx.stackAt(x, y).at(-1)?.tileId;
      if (!top) return false;
      return DIRECTIONS.some((d) =>
        [1, 2].some((n) => {
          const style = ctx.rampAt(x + STEP[d].x * n, y + STEP[d].y * n) ?? DEFAULT_RAMP;
          return style.slope === top;
        }),
      );
    };
    const ground: RampGround = {
      level: ctx.raisedAt,
      clear: (x, y) => {
        const stack = ctx.stackAt(x, y);
        if (stack.length === 0 || isWet(stack)) return false;
        if (isSlope(x, y)) return true;
        return (
          stackHeight(
            stack.filter((p) => !clears.has(p.tileId)),
            ctx.tilesById,
          ) === 0
        );
      },
    };
    const ramped = withRamps(route, ground);
    /** What a ramp leaves on its cells, which the road is then laid on: slope cells are finished, a head gets the road's tile like any other cell. */
    const reshaped = new Map<string, PlacedTile[]>();
    const slopes = new Set<string>();
    const stackOn = (x: number, y: number) => reshaped.get(at(x, y)) ?? ctx.stackAt(x, y);
    for (const site of ramped.sites) {
      const { head, high, low } = rampCells(site);
      if (isSlope(low.x, low.y)) continue;
      const style = ctx.rampAt(head.x, head.y) ?? DEFAULT_RAMP;
      if (!ctx.tilesById[style.slope] || !ctx.tilesById[style.block]) continue;
      const bottom = (c: { x: number; y: number }) => ctx.stackAt(c.x, c.y).slice(0, 1);
      slopes.add(at(low.x, low.y));
      slopes.add(at(high.x, high.y));
      reshaped.set(at(low.x, low.y), [...bottom(low), tile(style.slope, site.side)]);
      reshaped.set(at(high.x, high.y), [
        ...bottom(high),
        tile(style.block),
        tile(style.slope, site.side),
      ]);
      const top = ctx.stackAt(head.x, head.y);
      const hillGround = ctx.rampAt(head.x, head.y)?.ground;
      const plain = hillGround ? [tile(hillGround)] : top.slice(0, 1);
      reshaped.set(at(head.x, head.y), [...plain, ...top.slice(1)]);
      const column = ctx.stackAt(head.x, head.y, ctx.z - 1);
      if (column.length) {
        below.push({
          x: head.x,
          y: head.y,
          z: ctx.z - 1,
          stack: [...column.slice(0, -1), tile(style.block), tile(style.block)],
        });
      }
    }

    const styles = new Map<number, BridgeStyle>();
    const declared = (cells: readonly { x: number; y: number }[]) =>
      cells.map((c) => ctx.bridgeAt(c.x, c.y)).find((b) => b !== undefined);
    const laid = withBridges(ramped.cells, wet, (water) => declared(water) !== null);
    for (const c of laid) {
      if (c.span === undefined || styles.has(c.span)) continue;
      const style = declared(laid.filter((k) => k.span === c.span)) ?? DEFAULT_BRIDGE;
      styles.set(c.span, ctx.tilesById[style.deck] ? style : DEFAULT_BRIDGE);
    }
    /** The deck steps up a unit a cell from each bank to the arc's height, which a body walks without a ramp. */
    const deckOf = (c: Laid) => {
      const style = styles.get(c.span!)!;
      const foot = Math.min(style.arc, c.at!, c.of! - 1 - c.at!);
      return { style, deck: foot > 0 ? { ...tile(style.deck), foot } : tile(style.deck) };
    };
    /** Where the road itself runs beside its bridge, which only happens when it turns on the bank: a rail there would fence the road off from its own deck. */
    const roadway = new Set(
      laid
        .filter((c) => !c.bridge)
        .flatMap((c) => band.map((o) => at(c.x + c.side.x * o, c.y + c.side.y * o))),
    );
    for (const c of laid) {
      if (c.slope) continue;
      for (const o of band) {
        const x = c.x + c.side.x * o;
        const y = c.y + c.side.y * o;
        const stack = stackOn(x, y);
        if (stack.length === 0) continue;
        if (!c.bridge && (written.has(at(x, y)) || isWet(stack) || slopes.has(at(x, y)))) continue;
        const cleared = isWet(stack) ? stack : stack.filter((p) => !clears.has(p.tileId));
        if (stackHeight(cleared, ctx.tilesById) > 0) continue;
        const surface = c.bridge ? deckOf(c).deck : props.tile ? tile(props.tile) : null;
        if (!surface) {
          if (cleared.length !== stack.length) written.set(at(x, y), cleared);
          continue;
        }
        if (cleared.at(-1)?.tileId === surface.tileId && cleared.length === stack.length) continue;
        written.set(
          at(x, y),
          cleared.at(-1)?.tileId === surface.tileId ? cleared : [...cleared, surface],
        );
      }
      if (!c.bridge) continue;
      const { style, deck } = deckOf(c);
      if (!style.rail || !ctx.tilesById[style.rail]) continue;
      for (const o of edges) {
        const x = c.x + c.side.x * o;
        const y = c.y + c.side.y * o;
        const stack = ctx.stackAt(x, y);
        if (stack.length === 0 || roadway.has(at(x, y))) continue;
        const cleared = isWet(stack) ? stack : stack.filter((p) => !clears.has(p.tileId));
        if (stackHeight(cleared, ctx.tilesById) > 0) continue;
        const under = cleared.filter((p) => p.tileId !== props.tile && p.tileId !== style.deck);
        written.set(at(x, y), [...under, deck, tile(style.rail)]);
      }
    }
    for (const c of laid) {
      if (c.bridge || c.slope) continue;
      for (let n = 1; n <= props.verge; n++) {
        for (const o of [band[0]! - n, band.at(-1)! + n]) {
          const x = c.x + c.side.x * o;
          const y = c.y + c.side.y * o;
          if (written.has(at(x, y)) || slopes.has(at(x, y))) continue;
          const stack = stackOn(x, y);
          if (isWet(stack)) continue;
          const cut = stack.filter((p) => !cuts.has(p.tileId));
          if (cut.length !== stack.length) written.set(at(x, y), cut);
        }
      }
    }
    for (const [key, stack] of reshaped) if (!written.has(key)) written.set(key, stack);

    const edits: StackEdit[] = [...below];
    for (const [key, stack] of written) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      edits.push({ x, y, z: ctx.z, stack });
    }
    return { ok: true, edits };
  },
};
