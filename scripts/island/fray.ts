import type { PlacedTile } from "../../app/lib/types";
import { N4, distanceTo, fbm, perlin } from "./grid";
import type { Builder } from "./build";
import { baseTile, forNeighbours, plainGround } from "./stacks";
import { Ground, MIN_PATCH_CELLS } from "./terrain";

const FRAY_SALT = 0xf7a1;
/** The settlement's own ground kept round everything it built, so no line between two grounds runs beside a floor or a street. */
const GROUND_MIN_CELLS = 2;
/** Bare ground kept round everything a settlement built, so nothing that grows walls in a door or a street. */
const CLEAR_MIN_CELLS = 3;
/** How much further than those the noise may push each one. */
const SPREAD_CELLS = 6;
const SCALE_CELLS = 7;
/** Moves the spill's noise off the clearing's, so the two edges do not wander together. */
const SPILL_OFFSET = 37.5;

const WATER = new Set<number>([
  Ground.DeepSea,
  Ground.Shallows,
  Ground.Lake,
  Ground.River,
  Ground.Lava,
]);

/**
 * A site is a rectangle, and a settlement uses only part of it. Every bare
 * cell of a site further from what was built than a noisy distance gets the
 * ground it had before the site was levelled, and a cell a step further may
 * grow plants, so the clearing round a town follows its buildings and frays
 * into the land round it rather than ending at a straight line. Returns the
 * cells that may grow plants.
 */
export function frayClearings(b: Builder): Uint8Array {
  const { island, plan, board } = b;
  const { width: w, height: h } = island;
  const n = w * h;
  const bareAt = (i: number) => {
    const stack = board.get(i % w, Math.floor(i / w), island.level[i]!);
    return stack?.length === 1 && stack[0]!.tileId === plainGround(island, i)[0]!.tileId;
  };
  const used = (i: number) =>
    plan.road[i] === 1 || plan.reserved[i] === 1 || (plan.siteOf[i]! > 0 && !bareAt(i));
  const distance = distanceTo(island, used);
  const noise = perlin(FRAY_SALT);
  const wild = new Uint8Array(n);
  const changed = new Map<number, Before>();
  for (let i = 0; i < n; i++) {
    if (!plan.siteOf[i] || !bareAt(i)) continue;
    const x = i % w;
    const y = (i - x) / w;
    const spread = SPREAD_CELLS * (0.5 + 0.5 * fbm(noise, x / SCALE_CELLS, y / SCALE_CELLS, 3));
    if (distance[i]! <= GROUND_MIN_CELLS + spread) continue;
    if (distance[i]! > CLEAR_MIN_CELLS + spread) wild[i] = 1;
    const was = island.biome[i]!;
    if (WATER.has(was) || was === island.ground[i]) continue;
    const before = { ground: island.ground[i]!, stack: board.get(x, y, island.level[i]!)! };
    island.ground[i] = was;
    const stack = plainGround(island, i);
    if (stack[0]!.tileId !== before.stack[0]!.tileId) changed.set(i, before);
    board.set(x, y, island.level[i]!, stack);
  }
  undoSpecks(b, changed);
  spillGround(b, noise);
  return wild;
}

/**
 * Where a settlement is built right up to the edge of its site, the line
 * between its ground and the land round it is the site's edge. The site's
 * ground spills out over the bare cells past it, by a noisy depth, so that
 * line wanders too.
 */
function spillGround(b: Builder, noise: (x: number, y: number) => number) {
  const { island, plan } = b;
  const { width: w, height: h } = island;
  for (const site of plan.sites.values()) {
    for (let y = site.y0 - SPREAD_CELLS; y <= site.y1 + SPREAD_CELLS; y++) {
      for (let x = site.x0 - SPREAD_CELLS; x <= site.x1 + SPREAD_CELLS; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        spillInto(b, site, x, y, noise);
      }
    }
  }
}

function spillInto(
  b: Builder,
  site: { x0: number; y0: number; x1: number; y1: number; level: number },
  x: number,
  y: number,
  noise: (x: number, y: number) => number,
) {
  const { island, plan, board } = b;
  const w = island.width;
  const i = y * w + x;
  if (plan.siteOf[i] || plan.road[i] || plan.reserved[i] || island.level[i] !== site.level) return;
  const out = Math.max(site.x0 - x, x - site.x1, site.y0 - y, y - site.y1);
  const depth =
    SPREAD_CELLS * (0.5 + 0.5 * fbm(noise, x / SCALE_CELLS + SPILL_OFFSET, y / SCALE_CELLS, 3));
  if (out > depth) return;
  const from =
    Math.min(site.y1, Math.max(site.y0, y)) * w + Math.min(site.x1, Math.max(site.x0, x));
  const g = island.ground[from]!;
  if (!plan.siteOf[from] || WATER.has(g) || g === island.ground[i]) return;
  const stack = board.get(x, y, site.level);
  if (stack?.length !== 1 || stack[0]!.tileId !== plainGround(island, i)[0]!.tileId) return;
  island.ground[i] = g;
  board.set(x, y, site.level, plainGround(island, i));
}

type Before = { ground: number; stack: PlacedTile[] };

/**
 * A cell given back a different ground from the site round it is a speck
 * of that ground unless enough of them lie together or they join the same
 * ground outside the site, so a piece smaller than a patch is put back.
 */
function undoSpecks(b: Builder, changed: Map<number, Before>) {
  const { island, plan, board } = b;
  const { width: w, height: h } = island;
  const seen = new Set<number>();
  for (const start of changed.keys()) {
    if (seen.has(start)) continue;
    const piece = [start];
    seen.add(start);
    let joined = false;
    for (let k = 0; k < piece.length; k++) {
      forNeighbours(w, h, piece[k]!, N4, (j) => {
        if (!plan.siteOf[j] && baseTile(island, j) === baseTile(island, start)) joined = true;
        if (seen.has(j) || !changed.has(j)) return;
        seen.add(j);
        piece.push(j);
      });
    }
    if (joined || piece.length >= MIN_PATCH_CELLS) continue;
    for (const i of piece) {
      const before = changed.get(i)!;
      island.ground[i] = before.ground;
      board.set(i % w, Math.floor(i / w), island.level[i]!, before.stack);
    }
  }
}
