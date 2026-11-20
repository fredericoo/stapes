import { CellHeap, N4, components, distanceTo, fbm, perlin } from "./grid";
import { ROADS, SITES, SITE_APRON, type PlaceId, type SiteId } from "./layout";
import { SNOW_LEVEL } from "../../app/verify/landscape";
import { Ground, type Island } from "./terrain";

export type Dir = "n" | "e" | "s" | "w";
export const STEP: Record<Dir, readonly [number, number]> = {
  n: [0, -1],
  e: [1, 0],
  s: [0, 1],
  w: [-1, 0],
};
export const DIRS: readonly Dir[] = ["n", "e", "s", "w"];
export const OPPOSITE: Record<Dir, Dir> = { n: "s", e: "w", s: "n", w: "e" };
export const SIDEWAYS: Record<Dir, Dir> = { n: "e", e: "s", s: "w", w: "n" };

export type Site = {
  id: SiteId;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  level: number;
};

/** `low` and `high` are the two ramp cells, `foot` and `head` the ground they join; `climbs` is the way up. */
export type Ramp = { foot: number; low: number; high: number; head: number; climbs: Dir };

/** A deck along `cells`, every one on `level`, railed on both sides. */
export type Bridge = { cells: number[]; across: Dir; level: number };

export type Plan = {
  sites: Map<SiteId, Site>;
  /** Which site a cell is in, by index into `SITE_ORDER` plus one; 0 is none. */
  siteOf: Uint8Array;
  ramps: Ramp[];
  /** 1 where a road runs. */
  road: Uint8Array;
  bridges: Bridge[];
  /** Cells a ramp or a bridge uses, which nothing may be put on. */
  reserved: Uint8Array;
  /** The cells where each road enters each site, so the town can run a street to it. */
  entries: Map<SiteId, Array<{ x: number; y: number }>>;
  roadLengths: Array<{ from: PlaceId; to: PlaceId; cells: number }>;
  /** The cell the tall fall off the snow lands in, or -1 when the island has none. */
  tallFall: number;
};

export const SITE_ORDER = Object.keys(SITES) as SiteId[];

const TERRACE_WIDTH = 3;
const APRON_SALT = 0xa960;
/** Cells round a site kept level with it whatever the noise says, so no cliff stands against a town's edge. */
const SITE_FLAT_RING_CELLS = 2;
const APRON_FRAY_CELLS = 5;
const APRON_FRAY_SCALE_CELLS = 9;
const MIN_REGION_CELLS = 28;
const MIN_PIT_CELLS = 40;
const MIN_SHELF_FOR_RAMP = 40;
const RAMP_SPACING = 36;
const MAX_BRIDGE = 9;
const SEA_RING = 20;
/** What a road pays to build a ramp of its own over the four cells it takes, against walking round to one already built. */
const RAMP_COST = 4 + 12;

const isWater = (g: number) =>
  g === Ground.DeepSea ||
  g === Ground.Shallows ||
  g === Ground.Lake ||
  g === Ground.River ||
  g === Ground.Lava ||
  g === Ground.Bog;

/**
 * Flattens the sites, cuts the levels into terraces, joins every terrace by
 * ramps, and routes the roads over them. Everything after this reads its
 * levels, so the terrain is final when it returns.
 */
export function planIsland(island: Island): Plan {
  const { width: w, height: h, level, ground } = island;
  const n = w * h;
  const at = (x: number, y: number) => y * w + x;
  const land = (i: number) =>
    level[i]! >= 0 && ground[i] !== Ground.DeepSea && ground[i] !== Ground.Shallows;

  const sites = new Map<SiteId, Site>();
  const siteOf = new Uint8Array(n);
  const pinned = new Uint8Array(n);
  const apronNoise = perlin(APRON_SALT);
  /** Distance out from a site, pushed out by noise so the terraces round it are not squares. */
  const frayed = (x: number, y: number, d: number) =>
    d +
    APRON_FRAY_CELLS *
      (0.5 + 0.5 * fbm(apronNoise, x / APRON_FRAY_SCALE_CELLS, y / APRON_FRAY_SCALE_CELLS, 3));
  SITE_ORDER.forEach((id, k) => {
    const size = SITES[id];
    const centre = island.place(id);
    const site = chooseSite(island, id, centre, size.w, size.h, siteOf);
    sites.set(id, site);
    if (id === "lighthouse") raiseHeadland(island, site);
    for (let y = site.y0; y <= site.y1; y++) {
      for (let x = site.x0; x <= site.x1; x++) {
        const i = at(x, y);
        if (!land(i)) continue;
        siteOf[i] = k + 1;
        level[i] = site.level;
        if (isWater(ground[i]!) || ground[i] === Ground.Rock || ground[i] === Ground.Snow) {
          ground[i] = ground[i] === Ground.Lava ? Ground.Basalt : Ground.Grass;
        }
      }
    }
    for (let y = site.y0 - SITE_APRON; y <= site.y1 + SITE_APRON; y++) {
      for (let x = site.x0 - SITE_APRON; x <= site.x1 + SITE_APRON; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = at(x, y);
        if (siteOf[i] || !land(i)) continue;
        const out = Math.max(site.x0 - x, x - site.x1, site.y0 - y, y - site.y1);
        const d = frayed(x, y, out);
        const flat = d <= TERRACE_WIDTH + 1 || out <= SITE_FLAT_RING_CELLS;
        const slack = flat ? 0 : Math.floor((d - TERRACE_WIDTH) / (TERRACE_WIDTH + 1));
        level[i] = Math.max(site.level - slack, Math.min(site.level + slack, level[i]!));
        if (flat) pinned[i] = 1;
      }
    }
  });
  for (let i = 0; i < n; i++) if (siteOf[i]) pinned[i] = 1;
  const tallFall = raiseTallFall(island, siteOf, pinned);

  let ramps: Ramp[] = [];
  let candidates: Ramp[] = [];
  for (let round = 0; ; round++) {
    terrace(island, pinned);
    ({ ramps, candidates } = placeRamps(island, siteOf));
    const merged = mergeStranded(island, ramps, pinned, island.place("wreckBeach"));
    if (merged === 0 || round === 8) {
      if (merged) console.warn(`  ${merged} cells still cut off after ${round + 1} rounds`);
      break;
    }
  }

  thawLowSnow(island);

  const reserved = new Uint8Array(n);
  for (const r of ramps) for (const i of [r.low, r.high, r.head]) reserved[i] = 1;

  const road = new Uint8Array(n);
  const bridges: Bridge[] = [];
  const entries = new Map<SiteId, Array<{ x: number; y: number }>>();
  const roadLengths: Plan["roadLengths"] = [];
  const rampAt = new Map<number, Ramp>();
  for (const r of ramps) {
    rampAt.set(r.high, r);
    rampAt.set(r.head, r);
    rampAt.set(r.low, r);
  }
  const taken = new Uint8Array(n);
  const take = (r: Ramp) => {
    for (const i of [r.foot, r.low, r.high, r.head]) taken[i] = 1;
  };
  for (const r of ramps) take(r);
  for (const [from, to] of ROADS) {
    const offers = new Map<number, Ramp[]>();
    for (const r of candidates) {
      if ([r.foot, r.low, r.high, r.head].some((i) => taken[i])) continue;
      for (const end of [r.foot, r.head]) offers.set(end, [...(offers.get(end) ?? []), r]);
    }
    const path = routeRoad(
      island,
      road,
      rampAt,
      offers,
      siteOf,
      island.place(from),
      island.place(to),
    );
    for (let k = 1; k < path.length; k++) {
      const r = rampAt.get(path[k]!);
      if (!r || ramps.includes(r)) continue;
      ramps.push(r);
      take(r);
      for (const i of [r.low, r.high, r.head]) reserved[i] = 1;
    }
    roadLengths.push({ from, to, cells: path.length });
    for (const i of path) if (!siteOf[i]) road[i] = 1;
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1]!;
      const b = path[k]!;
      if (siteOf[a] === siteOf[b]) continue;
      const inside = siteOf[a] ? a : b;
      const id = SITE_ORDER[siteOf[inside]! - 1]!;
      const list = entries.get(id) ?? [];
      list.push({ x: inside % w, y: Math.floor(inside / w) });
      entries.set(id, list);
    }
    bridges.push(...bridgesAlong(island, path, reserved, siteOf));
  }
  for (const b of bridges) for (const i of b.cells) reserved[i] = 1;
  for (const b of bridges) joinBridgeEnds(island, road, reserved, siteOf, b);
  return { sites, siteOf, ramps, road, bridges, reserved, entries, roadLengths, tallFall };
}

/**
 * The lighthouse needs ground 21 cells across and the headland in the sketch
 * is narrower, so the sea inside an octagon round the site's centre is filled
 * in at the site's level, as a rocky point the tower stands on.
 */
function raiseHeadland(island: Island, site: Site) {
  const { width: w, level, ground } = island;
  const cx = (site.x0 + site.x1) >> 1;
  const cy = (site.y0 + site.y1) >> 1;
  const r = 11;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (
        Math.max(Math.abs(x - cx), Math.abs(y - cy)) > r ||
        Math.abs(x - cx) + Math.abs(y - cy) > r + (r >> 1)
      )
        continue;
      const i = y * w + x;
      if (ground[i] === Ground.DeepSea || ground[i] === Ground.Shallows || level[i]! < 0) {
        ground[i] = Ground.Grass;
        level[i] = site.level;
      }
    }
  }
  const sea = distanceTo(
    island,
    (i) => ground[i] !== Ground.DeepSea && ground[i] !== Ground.Shallows && level[i]! >= 0,
  );
  for (let i = 0; i < level.length; i++) {
    if (ground[i] !== Ground.DeepSea && ground[i] !== Ground.Shallows && level[i]! >= 0) continue;
    island.seaDistance[i] = sea[i]!;
    ground[i] = sea[i]! <= 4 ? Ground.Shallows : Ground.DeepSea;
    level[i] = sea[i]! <= SEA_RING ? 0 : -1;
  }
}

/** The site rectangle near `centre` with the least water in it and the flattest ground. */
function chooseSite(
  island: Island,
  id: SiteId,
  centre: { x: number; y: number },
  sw: number,
  sh: number,
  taken: Uint8Array,
): Site {
  const { width: w, level, ground } = island;
  const coastal = id === "harbour" || id === "lighthouse";
  let best: Site | null = null;
  let bestScore = Infinity;
  for (let dy = -20; dy <= 20; dy += 2) {
    for (let dx = -20; dx <= 20; dx += 2) {
      const x0 = centre.x + dx - (sw >> 1);
      const y0 = centre.y + dy - (sh >> 1);
      const x1 = x0 + sw - 1;
      const y1 = y0 + sh - 1;
      if (x0 < 2 || y0 < 2 || x1 >= island.width - 2 || y1 >= island.height - 2) continue;
      let wet = 0;
      let sea = 0;
      let overlap = 0;
      const levels: number[] = [];
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = y * w + x;
          if (taken[i]) overlap++;
          const g = ground[i]!;
          if (g === Ground.DeepSea || g === Ground.Shallows || level[i]! < 0) sea++;
          else {
            if (isWater(g)) wet++;
            levels.push(level[i]!);
          }
        }
      }
      if (overlap) continue;
      levels.sort((a, b) => a - b);
      const median = levels[levels.length >> 1] ?? 0;
      let spread = 0;
      for (const l of levels) spread += Math.abs(l - median);
      const area = sw * sh;
      const seaPenalty = coastal ? Math.abs(sea / area - 0.35) * area : sea * 4;
      const score = wet * 6 + seaPenalty + spread * 2 + (dx * dx + dy * dy) * 0.6;
      if (score < bestScore) {
        bestScore = score;
        best = { id, x0, y0, x1, y1, level: median };
      }
    }
  }
  if (!best) throw new Error(`no room for the ${id} site`);
  return best;
}

/** How many storeys the river leaving the snow falls in one drop: the one place a cliff is taller than a storey. */
export const TALL_FALL_STOREYS = 3;
/** How far across the cliff the land is raised with the river, so the fall drops from a headwall rather than out of a slot. */
const TALL_FALL_REACH_CELLS = 7;
/** The headwall's reach is pushed in and out by noise, so the raised land ends in a ragged round and not a square. */
const TALL_FALL_FRAY_CELLS = 3;
const TALL_FALL_FRAY_SCALE_CELLS = 4;
const TALL_FALL_SALT = 0x7a11;
/** How far up its own course the river is raised, which must reach the storey it is raised to. */
const TALL_FALL_RIVER_CELLS = 40;
/** The drops a fall can be drawn down: water leaving a cliff south or east. */
const FALL_STEPS = [
  [0, 1],
  [1, 0],
] as const;

/**
 * Finds the widest river dropping south or east inside the snow, the
 * lowest such drop where two are as wide, which is the last cliff before
 * the river runs out onto the lower ground, and raises
 * the land above that drop until the river falls `TALL_FALL_STOREYS` in
 * one cliff. The raised cells are pinned, as `terrace` would otherwise
 * lower them into one-storey shelves again. Returns the cell the fall lands
 * in, or -1 when no river leaves the snow that way.
 */
function raiseTallFall(island: Island, siteOf: Uint8Array, pinned: Uint8Array): number {
  const drop = widestSnowDrop(island);
  if (!drop) return -1;
  const { width: w, height: h, level, ground } = island;
  const top = level[drop.pool]! + TALL_FALL_STOREYS;
  const [sx, sy] = drop.step;
  const rx = drop.from % w;
  const ry = (drop.from - rx) / w;
  const seen = new Uint8Array(w * h);
  const fray = perlin(TALL_FALL_SALT);
  const queue = [drop.from];
  seen[drop.from] = 1;
  for (let k = 0; k < queue.length; k++) {
    const i = queue[k]!;
    level[i] = top;
    pinned[i] = 1;
    const x = i % w;
    const y = (i - x) / w;
    for (const [dx, dy] of N4) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (seen[j] || siteOf[j] || level[j]! <= level[drop.pool]! || level[j]! >= top) continue;
      /** Only the side the river comes from is raised: nothing below the cliff's line moves. */
      if ((nx - rx) * sx + (ny - ry) * sy > 0) continue;
      const reach =
        ground[j] === Ground.River
          ? TALL_FALL_RIVER_CELLS
          : TALL_FALL_REACH_CELLS +
            TALL_FALL_FRAY_CELLS *
              fbm(fray, nx / TALL_FALL_FRAY_SCALE_CELLS, ny / TALL_FALL_FRAY_SCALE_CELLS, 3);
      if (Math.hypot(nx - rx, ny - ry) > reach) continue;
      seen[j] = 1;
      queue.push(j);
    }
  }
  pinned[drop.pool] = 1;
  return drop.pool;
}

type SnowDrop = { from: number; pool: number; step: readonly [number, number]; width: number };

function widestSnowDrop(island: Island): SnowDrop | undefined {
  const { width: w, height: h, level, ground, biome } = island;
  let best: SnowDrop | undefined;
  for (let i = 0; i < w * h; i++) {
    if (ground[i] !== Ground.River || biome[i] !== Ground.Snow) continue;
    const x = i % w;
    const y = (i - x) / w;
    for (const step of FALL_STEPS) {
      const [dx, dy] = step;
      if (x + dx >= w || y + dy >= h) continue;
      const j = i + dy * w + dx;
      if (ground[j] !== Ground.River || level[j]! >= level[i]!) continue;
      const width = riverWidth(island, i, dy, dx);
      const lower = best && width === best.width && level[i]! < level[best.from]!;
      if (!best || width > best.width || lower) best = { from: i, pool: j, step, width };
    }
  }
  return best;
}

/** How many river cells in a row the river at `i` is across `ax`, `ay`, at its own level. */
function riverWidth(island: Island, i: number, ax: number, ay: number): number {
  const { width: w, level, ground } = island;
  const same = (j: number) => ground[j] === Ground.River && level[j] === level[i];
  let width = 1;
  for (const sign of [-1, 1]) {
    for (let k = 1; same(i + sign * k * (ay * w + ax)); k++) width++;
  }
  return width;
}

/** Terracing lowers cells into the shelf below them, so snow it took below `SNOW_LEVEL` becomes grass. */
function thawLowSnow(island: Island) {
  const { level, ground, biome } = island;
  for (let i = 0; i < ground.length; i++) {
    if (level[i]! >= SNOW_LEVEL) continue;
    if (ground[i] === Ground.Snow || ground[i] === Ground.Rock) ground[i] = Ground.Grass;
    if (biome[i] === Ground.Snow || biome[i] === Ground.Rock) biome[i] = Ground.Grass;
  }
}

/**
 * Each level stands on a shelf of the level below at least `TERRACE_WIDTH`
 * wide, so every cliff is one storey and has room for a ramp at its foot.
 * Pieces of a level too small to matter are lowered into what is round them,
 * and hollows too small for a ramp out are filled to the level round them.
 */
function terrace(island: Island, pinned: Uint8Array) {
  const { width: w, height: h, level } = island;
  let top = 0;
  for (const l of level) top = Math.max(top, l);
  for (let l = 1; l <= top; l++) {
    const lower: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (level[i]! < l || pinned[i]) continue;
        let ok = true;
        for (let dy = -TERRACE_WIDTH; dy <= TERRACE_WIDTH && ok; dy++) {
          for (let dx = -TERRACE_WIDTH; dx <= TERRACE_WIDTH; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (level[ny * w + nx]! < l - 1) {
              ok = false;
              break;
            }
          }
        }
        if (!ok) lower.push(i);
      }
    }
    for (const i of lower) level[i] = l - 1;
    const pits = components(island, (i) => level[i]! >= 0 && level[i]! < l);
    const open = new Uint8Array(pits.sizes.length);
    for (let i = 0; i < w * h; i++) {
      const p = pits.labels[i]!;
      if (!p || open[p]) continue;
      const x = i % w;
      const y = (i - x) / w;
      if (pinned[i] || x === 0 || y === 0 || x === w - 1 || y === h - 1) open[p] = 1;
      for (const [dx, dy] of N4) {
        const j = (y + dy) * w + x + dx;
        if (level[j]! < 0) open[p] = 1;
      }
    }
    for (let i = 0; i < w * h; i++) {
      const p = pits.labels[i]!;
      if (p && !open[p] && pits.sizes[p]! < MIN_PIT_CELLS) level[i] = l;
    }
    const parts = components(island, (i) => level[i]! >= l);
    for (let i = 0; i < w * h; i++) {
      const p = parts.labels[i]!;
      if (p && parts.sizes[p]! < MIN_REGION_CELLS && !pinned[i]) level[i] = l - 1;
    }
  }
}

const walkable = (island: Island, i: number) => {
  const g = island.ground[i]!;
  return island.level[i]! >= 0 && g !== Ground.DeepSea && g !== Ground.Lava && g !== Ground.Lake;
};

const plainLand = (island: Island, i: number) => {
  const g = island.ground[i]!;
  return (
    walkable(island, i) &&
    g !== Ground.River &&
    g !== Ground.Bog &&
    g !== Ground.Shallows &&
    g !== Ground.Beach
  );
};

/**
 * Ramps where a cliff can take one, the way `raise-hills` places them: a ramp
 * on every cliff every `RAMP_SPACING` cells, then one more wherever two shelves
 * are still not joined. South and east faces are what the camera sees, so a
 * ramp climbing north or west is preferred.
 */
function placeRamps(island: Island, siteOf: Uint8Array): { ramps: Ramp[]; candidates: Ramp[] } {
  const { width: w, height: h, level } = island;
  const n = w * h;
  const step = (i: number, d: Dir, k = 1) => {
    const x = (i % w) + STEP[d][0] * k;
    const y = Math.floor(i / w) + STEP[d][1] * k;
    return x < 0 || y < 0 || x >= w || y >= h ? -1 : y * w + x;
  };
  const shelf = components(island, (i) => walkable(island, i));
  const sameLevel = new Int32Array(n);
  {
    const parts = componentsByLevel(island);
    sameLevel.set(parts.labels);
    for (let i = 0; i < n; i++) if (!walkable(island, i)) sameLevel[i] = 0;
  }
  const shelfSize = new Map<number, number>();
  for (let i = 0; i < n; i++)
    if (sameLevel[i]) shelfSize.set(sameLevel[i]!, (shelfSize.get(sameLevel[i]!) ?? 0) + 1);
  void shelf;

  type Site = Ramp & { rank: number; order: number };
  const sites: Site[] = [];
  let seed = 0x27d4eb2f;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let head = 0; head < n; head++) {
    const l = level[head]!;
    if (l <= 0 || !walkable(island, head) || siteOf[head]) continue;
    for (const climbs of DIRS) {
      const down = OPPOSITE[climbs];
      const high = step(head, down, 1);
      const low = step(head, down, 2);
      const foot = step(head, down, 3);
      if (high < 0 || low < 0 || foot < 0) continue;
      if (level[high] !== l - 1 || level[low] !== l - 1 || level[foot] !== l - 1) continue;
      if (!plainLand(island, high) || !plainLand(island, low) || !walkable(island, foot)) continue;
      if (siteOf[high] || siteOf[low]) continue;
      const side = SIDEWAYS[climbs];
      const passable = [side, OPPOSITE[side]].every((d) => {
        const bh = step(high, d);
        const bl = step(low, d);
        return (
          bh < 0 ||
          level[bh] !== l - 1 ||
          !walkable(island, bh) ||
          (bl >= 0 && walkable(island, bl) && level[bl] === l - 1)
        );
      });
      if (!passable) continue;
      const straight = [side, OPPOSITE[side]].every((d) => {
        const a = step(head, d);
        const b = step(high, d);
        return a >= 0 && b >= 0 && level[a] === l && level[b] === l - 1;
      });
      if (!straight) continue;
      const faced = climbs === "n" || climbs === "w";
      sites.push({ foot, low, high, head, climbs, rank: faced ? 0 : 1, order: random() });
    }
  }
  sites.sort((a, b) => a.rank - b.rank || a.order - b.order);

  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = sameLevel[i]!;
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]!]!;
      a = parent[a]!;
    }
    return a;
  };
  const taken = new Uint8Array(n);
  const ramps: Ramp[] = [];
  const free = (r: Ramp) => {
    for (const i of [r.foot, r.low, r.high, r.head]) {
      if (taken[i]) return false;
      const x = i % w;
      const y = Math.floor(i / w);
      for (const [dx, dy] of N4) {
        const j = (y + dy) * w + x + dx;
        if (j >= 0 && j < n && taken[j] === 2) return false;
      }
    }
    return true;
  };
  const useful = (r: Ramp) =>
    (shelfSize.get(sameLevel[r.foot]!) ?? 0) >= MIN_SHELF_FOR_RAMP &&
    (shelfSize.get(sameLevel[r.head]!) ?? 0) >= MIN_SHELF_FOR_RAMP;
  const build = (r: Ramp) => {
    ramps.push(r);
    taken[r.foot] = 1;
    taken[r.head] = 1;
    taken[r.low] = 2;
    taken[r.high] = 2;
    parent[find(sameLevel[r.foot]!)] = find(sameLevel[r.head]!);
  };
  const heads: Array<[number, number]> = [];
  for (const r of sites) {
    if (!useful(r) || !free(r)) continue;
    const x = r.head % w;
    const y = Math.floor(r.head / w);
    if (heads.some(([hx, hy]) => Math.max(Math.abs(hx - x), Math.abs(hy - y)) < RAMP_SPACING))
      continue;
    build(r);
    heads.push([x, y]);
  }
  for (const r of sites) {
    if (!free(r)) continue;
    if (find(sameLevel[r.foot]!) === find(sameLevel[r.head]!)) continue;
    build(r);
  }
  return { ramps, candidates: sites };
}

function componentsByLevel(island: Island) {
  const { width: w, height: h, level } = island;
  const n = w * h;
  const labels = new Int32Array(n);
  const queue = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (labels[start] || level[start]! < 0) continue;
    labels[start] = start;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    while (head < tail) {
      const i = queue[head++]!;
      const x = i % w;
      const y = (i - x) / w;
      for (const [dx, dy] of N4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (labels[j] || level[j] !== level[i]) continue;
        labels[j] = start;
        queue[tail++] = j;
      }
    }
  }
  return { labels };
}

/**
 * Walks from the wreck beach over level ground and ramps. A shelf the walk
 * never reaches although it touches one it did is folded into its lowest
 * neighbour, and the caller plans again. Returns how many cells moved.
 */
function mergeStranded(
  island: Island,
  ramps: Ramp[],
  pinned: Uint8Array,
  start: { x: number; y: number },
): number {
  const { width: w, height: h, level } = island;
  const n = w * h;
  const seen = new Uint8Array(n);
  const links = new Map<number, number[]>();
  for (const r of ramps) {
    (links.get(r.high) ?? links.set(r.high, []).get(r.high)!).push(r.head);
    (links.get(r.head) ?? links.set(r.head, []).get(r.head)!).push(r.high);
  }
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const s = start.y * w + start.x;
  seen[s] = 1;
  queue[tail++] = s;
  while (head < tail) {
    const i = queue[head++]!;
    const x = i % w;
    const y = (i - x) / w;
    const next: number[] = links.get(i) ?? [];
    for (const [dx, dy] of N4) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (level[j] === level[i]) next.push(j);
    }
    for (const j of next) {
      if (seen[j] || !walkable(island, j)) continue;
      seen[j] = 1;
      queue[tail++] = j;
    }
  }
  const parts = componentsByLevel(island);
  const lowest = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (seen[i] || !walkable(island, i)) continue;
    const x = i % w;
    const y = (i - x) / w;
    for (const [dx, dy] of N4) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (!seen[j] || level[j] === level[i]) continue;
      const p = parts.labels[i]!;
      lowest.set(p, Math.min(lowest.get(p) ?? 99, level[j]!));
    }
  }
  let moved = 0;
  for (let i = 0; i < n; i++) {
    const target = lowest.get(parts.labels[i]!);
    if (target === undefined || seen[i] || pinned[i]) continue;
    if (level[i] !== target) {
      level[i] = target;
      moved++;
    }
  }
  return moved;
}

/**
 * A* four ways over walkable ground. A step changes level only up or down a
 * ramp, and the upper ramp cell is entered only along it. Where a cliff has
 * room for a ramp nobody has built, the road may build one, for
 * `RAMP_COST`. A step on a road already laid is cheap, so later roads join
 * the trunks.
 */
function routeRoad(
  island: Island,
  road: Uint8Array,
  rampAt: Map<number, Ramp>,
  offers: Map<number, Ramp[]>,
  siteOf: Uint8Array,
  from: { x: number; y: number },
  to: { x: number; y: number },
): number[] {
  const { width: w, height: h, level, ground } = island;
  const n = w * h;
  const cost = new Float64Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const via = new Map<number, Ramp>();
  const heap = new CellHeap();
  const start = from.y * w + from.x;
  const goal = to.y * w + to.x;
  cost[start] = 0;
  heap.push(start, 0);
  while (heap.size) {
    const i = heap.pop();
    if (closed[i]) continue;
    closed[i] = 1;
    if (i === goal) break;
    const x = i % w;
    const y = (i - x) / w;
    for (const r of offers.get(i) ?? []) {
      const j = r.foot === i ? r.head : r.foot;
      const next = cost[i]! + RAMP_COST;
      if (next < cost[j]!) {
        cost[j] = next;
        came[j] = i;
        via.set(j, r);
        heap.push(j, next + 0.4 * (Math.abs((j % w) - to.x) + Math.abs(Math.floor(j / w) - to.y)));
      }
    }
    for (const d of DIRS) {
      const nx = x + STEP[d][0];
      const ny = y + STEP[d][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (!walkable(island, j)) continue;
      const rj = rampAt.get(j);
      const ri = rampAt.get(i);
      if (level[j] !== level[i]) {
        const up = ri && ri.high === i && ri.head === j;
        const down = rj && rj.high === j && rj.head === i;
        if (!up && !down) continue;
      } else if (rj && rj.high === j && i !== rj.low && i !== rj.head) continue;
      else if (ri && ri.high === i && j !== ri.low && j !== ri.head) continue;
      let stepCost = road[j] ? 0.4 : 1;
      const g = ground[j]!;
      if (g === Ground.River) stepCost += 8;
      if (g === Ground.Bog || g === Ground.Shallows) stepCost += 4;
      if (g === Ground.DeepWoods) stepCost += 0.5;
      if (siteOf[j] && siteOf[j] !== siteOf[goal] && siteOf[j] !== siteOf[start]) stepCost += 3;
      const next = cost[i]! + stepCost;
      if (next < cost[j]!) {
        cost[j] = next;
        came[j] = i;
        heap.push(j, next + 0.4 * (Math.abs(nx - to.x) + Math.abs(ny - to.y)));
      }
    }
  }
  if (came[goal] < 0 && goal !== start) {
    console.warn(`  no road from ${from.x},${from.y} to ${to.x},${to.y}`);
    return [];
  }
  const path: number[] = [];
  for (let i = goal; i >= 0; i = came[i]!) {
    path.push(i);
    const r = via.get(i);
    if (r) {
      const upward = r.head === i;
      path.push(...(upward ? [r.high, r.low] : [r.low, r.high]));
      for (const c of [r.low, r.high, r.head]) rampAt.set(c, r);
    }
    if (i === start) break;
  }
  return path.reverse();
}

/**
 * Where a road wades a river, a bridge: a straight deck from the bank it left
 * to the first dry cell across, on one level, with a cell of rail either side.
 */
function bridgesAlong(
  island: Island,
  path: number[],
  reserved: Uint8Array,
  siteOf: Uint8Array,
): Bridge[] {
  const { width: w, height: h, level, ground } = island;
  const out: Bridge[] = [];
  for (let k = 1; k < path.length; k++) {
    const i = path[k]!;
    const before = path[k - 1]!;
    if (ground[i] !== Ground.River || ground[before] === Ground.River) continue;
    const dx = (i % w) - (before % w);
    const dy = Math.floor(i / w) - Math.floor(before / w);
    const across = DIRS.find((d) => STEP[d][0] === dx && STEP[d][1] === dy)!;
    const side = SIDEWAYS[across];
    const deck: number[] = [before];
    let x = i % w;
    let y = Math.floor(i / w);
    let ok = false;
    for (let s = 0; s < MAX_BRIDGE; s++) {
      if (x < 0 || y < 0 || x >= w || y >= h) break;
      const j = y * w + x;
      deck.push(j);
      if (level[j] !== level[before]) break;
      if (ground[j] !== Ground.River) {
        ok = true;
        break;
      }
      x += dx;
      y += dy;
    }
    if (!ok || deck.length < 3) continue;
    const cells: number[] = [];
    let fits = true;
    for (const j of deck) {
      for (const o of [0, 1, -1]) {
        const cx = (j % w) + STEP[side][0] * o;
        const cy = Math.floor(j / w) + STEP[side][1] * o;
        if (cx < 0 || cy < 0 || cx >= w || cy >= h) {
          fits = false;
          continue;
        }
        const c = cy * w + cx;
        if (level[c] !== level[before] || reserved[c] || siteOf[c] || !walkable(island, c))
          fits = false;
        cells.push(c);
      }
    }
    if (!fits) continue;
    out.push({ cells: deck, across, level: level[before]! });
    for (const c of cells) reserved[c] = 1;
  }
  return out;
}

/** How far from a deck's end the search for the road on that bank goes, in cells walked. */
const BRIDGE_JOIN_CELLS = 16;

/**
 * A road is one cell wide and meets a bridge's deck square on, at the middle
 * of its three cells. The deck runs straight from where the road reached the
 * water, but the road may have waded on at an angle, so the cell straight out
 * from each end of the deck is joined to the nearest road on that bank by
 * the shortest walk over dry land the bridge does not use.
 */
function joinBridgeEnds(
  island: Island,
  road: Uint8Array,
  reserved: Uint8Array,
  siteOf: Uint8Array,
  bridge: Bridge,
) {
  const { width: w } = island;
  const [dx, dy] = STEP[bridge.across];
  const first = bridge.cells[0]!;
  const last = bridge.cells.at(-1)!;
  const blocked = (i: number) => reserved[i] === 1 || siteOf[i]! > 0;
  joinToRoad(island, road, blocked, first - dx - dy * w, bridge.level);
  joinToRoad(island, road, blocked, last + dx + dy * w, bridge.level);
}

function joinToRoad(
  island: Island,
  road: Uint8Array,
  blocked: (i: number) => boolean,
  start: number,
  z: number,
) {
  const { width: w, height: h, level, ground } = island;
  const dry = (i: number) =>
    level[i] === z && !blocked(i) && walkable(island, i) && ground[i] !== Ground.River;
  if (start < 0 || start >= w * h || !dry(start)) return;
  const from = new Map<number, number>([[start, -1]]);
  const queue = [start];
  for (let k = 0; k < queue.length && k < BRIDGE_JOIN_CELLS ** 2; k++) {
    const i = queue[k]!;
    if (road[i] && i !== start) {
      for (let c = i; c !== -1; c = from.get(c)!) road[c] = 1;
      return;
    }
    for (const [ox, oy] of N4) {
      const x = (i % w) + ox;
      const y = Math.floor(i / w) + oy;
      const j = y * w + x;
      if (x < 0 || y < 0 || x >= w || y >= h || from.has(j) || !dry(j)) continue;
      from.set(j, i);
      queue.push(j);
    }
  }
  road[start] = 1;
}
