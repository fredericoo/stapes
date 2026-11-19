import type { Direction, PlacedTile } from "../../app/lib/types";
import { tile } from "./board";
import type { Builder } from "./build";
import { N4, mulberry32 } from "./grid";
import type { Site } from "./plan";
import { Ground } from "./terrain";
import { Town, type Point } from "./town";

const TIERS = [
  { from: 0, to: 3, r: 8, wall: "lighthouse-wall" },
  { from: 4, to: 9, r: 6, wall: "lighthouse-wall-limewashed" },
  { from: 10, to: 13, r: 4, wall: "lighthouse-wall" },
] as const;
const PLATFORM = 14;

const insideTier = (r: number, x: number, y: number) =>
  Math.max(Math.abs(x), Math.abs(y)) <= r && Math.abs(x) + Math.abs(y) <= r + Math.floor(r / 2);

const tierAt = (z: number) => TIERS.find((t) => z >= t.from && z <= t.to)!;

/** The corner tile's facing for the quadrant a cell is in: `n` is north-east, `e` south-east, `s` south-west, `w` north-west. */
const quadrant = (x: number, y: number): Direction =>
  x > 0 ? (y < 0 ? "n" : "e") : y > 0 ? "s" : "w";

type Spot = { x: number; y: number };

/** A quarter turn clockwise about the tower's centre, `k` times. */
const turn = (p: Spot, k: number): Spot => {
  let { x, y } = p;
  for (let i = 0; i < ((k % 4) + 4) % 4; i++) [x, y] = [-y, x];
  return { x, y };
};

const DIR_OF: Record<string, Direction> = { "0,-1": "n", "1,0": "e", "0,1": "s", "-1,0": "w" };
const FACING: Record<Direction, Direction> = { n: "s", e: "w", s: "n", w: "e" };

/**
 * The lighthouse of `docs/lighthouse.md`: an octagon in three tiers that
 * narrow upwards, a walkway outside each setback, a floor on every storey, slits
 * on alternate storeys, a flight of stairs a quarter turn further round on
 * each storey, and Wyrd in its arcade under the stone roof on top.
 */
export function buildLighthouse(b: Builder, site: Site) {
  const { island } = b;
  const z0 = site.level;
  const R = TIERS[0].r;
  const solid = (x: number, y: number) => {
    const i = y * island.width + x;
    return (
      island.level[i] === z0 &&
      island.ground[i] !== Ground.DeepSea &&
      island.ground[i] !== Ground.Shallows &&
      b.plan.siteOf[i]
    );
  };
  let centre: Point | null = null;
  let bestD = Infinity;
  const want = { x: (site.x0 + site.x1) >> 1, y: (site.y0 + site.y1) >> 1 };
  for (let cy = site.y0; cy <= site.y1; cy++) {
    for (let cx = site.x0; cx <= site.x1; cx++) {
      const d = Math.hypot(cx - want.x, cy - want.y);
      if (d >= bestD) continue;
      let ok = true;
      for (let dy = -R - 2; dy <= R + 2 && ok; dy++) {
        for (let dx = -R - 2; dx <= R + 2; dx++) {
          if (!solid(cx + dx, cy + dy)) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        centre = { x: cx, y: cy };
        bestD = d;
      }
    }
  }
  if (!centre) throw new Error("no ground on the headland wide enough for the lighthouse");
  for (let y = site.y0; y <= site.y1; y++) {
    for (let x = site.x0; x <= site.x1; x++) {
      const i = y * island.width + x;
      if (
        b.plan.siteOf[i] &&
        island.level[i] === z0 &&
        island.ground[i] !== Ground.DeepSea &&
        island.ground[i] !== Ground.Shallows
      ) {
        island.ground[i] = Ground.Grass;
      }
    }
  }
  const town = new Town(b, site, "cobblestone");
  const entry = (b.plan.entries.get("lighthouse") ?? [])[0] ?? { x: centre.x, y: site.y0 };
  const doorSide: Direction =
    Math.abs(entry.x - centre.x) > Math.abs(entry.y - centre.y)
      ? entry.x > centre.x
        ? "e"
        : "w"
      : entry.y > centre.y
        ? "s"
        : "n";
  const doorLocal = turn({ x: 0, y: R }, { s: 0, w: 1, n: 2, e: 3 }[doorSide]);

  const at = (p: Spot) => ({ x: centre.x + p.x, y: centre.y + p.y });
  const put = (p: Spot, z: number, stack: PlacedTile[]) => {
    const c = at(p);
    b.board.set(c.x, c.y, z, z === z0 ? [tile(b.base(c.x, c.y)), ...stack] : stack);
  };

  const holes = new Set<string>();
  const flights: Array<{ low: Spot; high: Spot; facing: Direction; z: number }> = [];
  for (let z = z0; z < z0 + PLATFORM; z++) {
    const here = tierAt(z - z0);
    const above = z + 1 - z0 >= PLATFORM ? TIERS[2] : tierAt(z + 1 - z0);
    const a = Math.min(here.r, above.r) - 2;
    const k = z - z0;
    const low = turn({ x: a, y: 1 }, k);
    const high = turn({ x: a, y: 0 }, k);
    const climb = turn({ x: 0, y: -1 }, k);
    const facing = FACING[DIR_OF[`${climb.x},${climb.y}`]!];
    flights.push({ low, high, facing, z });
    holes.add(`${low.x},${low.y},${z + 1}`);
    holes.add(`${high.x},${high.y},${z + 1}`);
  }

  for (let z = z0; z < z0 + PLATFORM; z++) {
    const tier = tierAt(z - z0);
    const r = tier.r;
    const limit = r + Math.floor(r / 2);
    const slits = (z - z0) % 2 === 1;
    for (let y = -TIERS[0].r; y <= TIERS[0].r; y++) {
      for (let x = -TIERS[0].r; x <= TIERS[0].r; x++) {
        const p = { x, y };
        if (insideTier(r, x, y)) {
          const edge = N4.some(([dx, dy]) => !insideTier(r, x + dx, y + dy));
          if (!edge) {
            if (!holes.has(`${x},${y},${z}`)) put(p, z, [tile("flagstone-floor")]);
            continue;
          }
          const corner = Math.abs(x) + Math.abs(y) === limit;
          const limewashed = tier.wall === "lighthouse-wall-limewashed";
          const finish = (kind: string) =>
            limewashed ? `lighthouse-wall-limewashed-${kind}` : `lighthouse-wall-${kind}`;
          if (corner) {
            put(p, z, [tile(finish("corner"), quadrant(x, y))]);
            continue;
          }
          const along = Math.abs(x) === r ? y : x;
          if (z === z0 && x === doorLocal.x && y === doorLocal.y) {
            put(p, z, [tile(finish("doorway"), doorSide === "n" || doorSide === "s" ? "n" : "e")]);
          } else if (slits && (along === 0 || Math.abs(along) === 2)) {
            put(p, z, [tile(finish("slit"), Math.abs(x) === r ? "e" : "n")]);
          } else put(p, z, [tile(tier.wall)]);
        } else if (z - z0 === tier.from && tier.from > 0) {
          const below = tierAt(tier.from - 1).r;
          if (!insideTier(below, x, y)) continue;
          const outerEdge = N4.some(([dx, dy]) => !insideTier(below, x + dx, y + dy));
          put(
            p,
            z,
            outerEdge
              ? [tile("flagstone-floor"), tile("lighthouse-ledge")]
              : [tile("flagstone-floor")],
          );
        }
      }
    }
  }
  for (const f of flights) {
    const z = f.z;
    const floor = z === z0 ? [] : [tile("flagstone-floor")];
    const lowCell = at(f.low);
    const highCell = at(f.high);
    const ground = (c: Point) => (z === z0 ? [tile(b.base(c.x, c.y))] : []);
    b.board.set(lowCell.x, lowCell.y, z, [
      ...ground(lowCell),
      ...(z === z0 ? [tile("flagstone-floor")] : floor),
      tile("stone-stairs", f.facing),
    ]);
    b.board.set(highCell.x, highCell.y, z, [
      ...ground(highCell),
      ...(z === z0 ? [tile("flagstone-floor")] : floor),
      tile("brick-slab"),
      tile("stone-stairs", f.facing),
    ]);
  }

  const zTop = z0 + PLATFORM;
  const rTop = TIERS[2].r;
  for (let y = -rTop; y <= rTop; y++) {
    for (let x = -rTop; x <= rTop; x++) {
      if (!insideTier(rTop, x, y)) continue;
      const p = { x, y };
      if (holes.has(`${x},${y},${zTop}`)) continue;
      const edge = N4.some(([dx, dy]) => !insideTier(rTop, x + dx, y + dy));
      const ring = Math.max(Math.abs(x), Math.abs(y)) === 1;
      if (x === 0 && y === 0) put(p, zTop, [tile("flagstone-floor"), tile("wyrd")]);
      else if (ring) put(p, zTop, [tile("flagstone-floor"), tile("lighthouse-arcade")]);
      else
        put(
          p,
          zTop,
          edge ? [tile("flagstone-floor"), tile("lighthouse-parapet")] : [tile("flagstone-floor")],
        );
    }
  }
  footprint(b, at({ x: -1, y: -1 }), zTop + 1, "lighthouse-roof", 3, 3);

  const outside = at(turn({ x: 0, y: R + 2 }, { s: 0, w: 1, n: 2, e: 3 }[doorSide]));
  town.lane(outside, entry, 3, doorSide === "e" || doorSide === "w");
  b.buildings.push({
    key: "lighthouse",
    label: "The lighthouse",
    rect: { x0: centre.x - R, y0: centre.y - R, x1: centre.x + R, y1: centre.y + R },
    z: z0,
    storeys: PLATFORM,
    door: { ...at(doorLocal), wall: doorSide },
  });
  return { centre, doorSide };
}

/**
 * A tile wider than one cell: the anchor in the south-east cell and a part,
 * carrying `span`, in each other cell (`docs/terrain.md`).
 */
export function footprint(
  b: Builder,
  nw: Point,
  z: number,
  tileId: string,
  w: number,
  d: number,
  direction?: Direction,
) {
  const anchor = { x: nw.x + w - 1, y: nw.y + d - 1 };
  const id = ((anchor.x * 73856093) ^ (anchor.y * 19349663) ^ (z * 83492791))
    .toString(16)
    .replace("-", "")
    .padStart(8, "0")
    .slice(-8);
  for (let y = nw.y; y <= anchor.y; y++) {
    for (let x = nw.x; x <= anchor.x; x++) {
      const extra = { span: { id, dx: anchor.x - x, dy: anchor.y - y } } as Partial<PlacedTile>;
      b.board.push(x, y, z, tile(tileId, direction, extra));
    }
  }
}

/**
 * The harbour town, a century and more after the flood: roofless houses of
 * broken wall, moss on the flagstones, rubble, ivy, and the waterfront under
 * the shallows. Nobody lives here.
 */
export function buildHarbour(b: Builder, site: Site) {
  const { island } = b;
  const z = site.level;
  const random = mulberry32(0x4a7b0 + ur(site));
  const land = (x: number, y: number) => {
    const i = y * island.width + x;
    return (
      island.level[i] === z &&
      b.plan.siteOf[i] &&
      island.ground[i] !== Ground.DeepSea &&
      island.ground[i] !== Ground.Shallows
    );
  };
  const seaNear = (x: number, y: number, r: number) => {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const i = (y + dy) * island.width + x + dx;
        if (island.ground[i] === Ground.Shallows || island.ground[i] === Ground.DeepSea)
          return true;
      }
    }
    return false;
  };
  for (let y = site.y0; y <= site.y1; y++) {
    for (let x = site.x0; x <= site.x1; x++) {
      if (!land(x, y)) continue;
      island.ground[y * island.width + x] = Ground.Beach;
      b.clear(x, y, z);
      if (seaNear(x, y, 2)) b.board.set(x, y, z, [tile(b.base(x, y)), tile("water")]);
    }
  }
  const taken = new Uint8Array((site.x1 - site.x0 + 1) * (site.y1 - site.y0 + 1));
  const local = (x: number, y: number) => (y - site.y0) * (site.x1 - site.x0 + 1) + (x - site.x0);
  const ruins: Array<{ x0: number; y0: number; x1: number; y1: number; chapel: boolean }> = [];
  for (let attempt = 0; attempt < 400 && ruins.length < 11; attempt++) {
    const chapel = ruins.length === 0;
    const w = chapel ? 10 : 5 + Math.floor(random() * 4);
    const d = chapel ? 8 : 4 + Math.floor(random() * 3);
    const x0 = site.x0 + 1 + Math.floor(random() * (site.x1 - site.x0 - w - 1));
    const y0 = site.y0 + 1 + Math.floor(random() * (site.y1 - site.y0 - d - 1));
    const r = { x0, y0, x1: x0 + w - 1, y1: y0 + d - 1, chapel };
    let ok = true;
    for (let y = r.y0 - 1; y <= r.y1 + 1 && ok; y++) {
      for (let x = r.x0 - 1; x <= r.x1 + 1; x++) {
        if (!land(x, y) || taken[local(x, y)]) {
          ok = false;
          break;
        }
      }
    }
    if (!ok) continue;
    ruins.push(r);
    for (let y = r.y0 - 1; y <= r.y1 + 1; y++)
      for (let x = r.x0 - 1; x <= r.x1 + 1; x++) taken[local(x, y)] = 1;
  }
  const decor = ["vines-south", "moss-top", "vines-corner", "vines-east"];
  for (const r of ruins) {
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        const edge = x === r.x0 || x === r.x1 || y === r.y0 || y === r.y1;
        const wet = b.board.get(x, y, z)?.some((p) => p.tileId === "water");
        const floor = random() < 0.45 ? "moss-flagstone" : "flagstone-floor";
        const doorway = y === r.y1 && x === (r.x0 + r.x1) >> 1;
        if (edge && !doorway) {
          const roll = random();
          if (roll < 0.55) {
            const stack = [tile(b.base(x, y)), tile("stone-wall")];
            if (random() < 0.5) stack.push(tile(decor[Math.floor(random() * decor.length)]!));
            b.board.set(x, y, z, stack);
          } else if (roll < 0.8) b.board.set(x, y, z, [tile(b.base(x, y)), tile("rubble")]);
          else b.board.set(x, y, z, [tile(b.base(x, y)), tile(floor)]);
        } else {
          const stack = [tile(b.base(x, y)), tile(floor)];
          if (wet) stack.push(tile("water"));
          else if (random() < 0.12) stack.push(tile("rubble"));
          else if (random() < 0.1) stack.push(tile(random() < 0.5 ? "ivy-north" : "ivy-west"));
          b.board.set(x, y, z, stack);
        }
      }
    }
    if (r.chapel) {
      for (const [dx, dy] of [
        [2, 2],
        [7, 2],
        [2, 5],
        [7, 5],
      ] as const) {
        b.board.push(
          r.x0 + dx,
          r.y0 + dy,
          z,
          tile(dy === 5 && dx === 7 ? "marble-pillar-broken" : "marble-pillar-bottom-cracked"),
        );
      }
    }
  }
  b.buildings.push({
    key: "harbour-ruins",
    label: `The harbour ruins (${ruins.length} roofless buildings, the first the chapel)`,
    rect: { x0: site.x0, y0: site.y0, x1: site.x1, y1: site.y1 },
    z,
    storeys: 1,
    door: { x: site.x0, y: site.y0, wall: "s" },
  });
}

function ur(site: Site): number {
  return (site.x0 * 31 + site.y0) & 0xff;
}

/**
 * The wreck on the beach the player wakes beside: the hull on the sand, its
 * ribs in the surf, the mast and the planks thrown up the beach. Every piece
 * wider than a cell is placed whole (`footprint`), and nothing lands within two
 * cells of where the player wakes, so they can step off the spawn any way.
 */
export function buildWreck(b: Builder) {
  const { island, board } = b;
  const at = island.place("wreckBeach");
  const z = island.level[at.y * island.width + at.x]!;
  const clear = (x: number, y: number) => Math.max(Math.abs(x - at.x), Math.abs(y - at.y)) > 2;
  const top = (x: number, y: number) =>
    board
      .get(x, y, z)
      ?.map((p) => p.tileId)
      .join(",");
  const sand = (x: number, y: number) =>
    top(x, y) === "sand-dunes" && !b.plan.road[y * island.width + x];
  const surf = (x: number, y: number) =>
    top(x, y)?.startsWith("sand-dunes,water") === true && !top(x, y)!.includes("deep");
  const taken = new Set<string>();
  const place = (
    tileId: string,
    w: number,
    d: number,
    ok: (x: number, y: number) => boolean,
    reach: number,
  ) => {
    for (let r = 2; r <= reach; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nw = { x: at.x + dx, y: at.y + dy };
          const cells: Point[] = [];
          for (let y = nw.y; y < nw.y + d; y++)
            for (let x = nw.x; x < nw.x + w; x++) cells.push({ x, y });
          if (!cells.every((c) => ok(c.x, c.y) && clear(c.x, c.y) && !taken.has(`${c.x},${c.y}`)))
            continue;
          for (const c of cells) taken.add(`${c.x},${c.y}`);
          if (w === 1 && d === 1) board.push(nw.x, nw.y, z, tile(tileId));
          else footprint(b, nw, z, tileId, w, d);
          return true;
        }
      }
    }
    return false;
  };
  const shore = (x: number, y: number) =>
    (sand(x, y) || top(x, y) === "grass-2") && !b.plan.road[y * island.width + x];
  place("wreck-ribs", 3, 2, surf, 12);
  if (!place("wreck-hull", 3, 2, sand, 10)) place("wreck-hull", 3, 2, shore, 12);
  if (!place("wreck-mast", 4, 2, sand, 12)) place("wreck-mast", 4, 2, shore, 14);
  for (const id of [
    "wreck-planks",
    "driftwood",
    "wreck-planks",
    "rope-coil",
    "barrel",
    "driftwood",
    "wreck-planks",
  ]) {
    place(id, 1, 1, sand, 9);
  }
  place("driftwood", 1, 1, surf, 9);
}
