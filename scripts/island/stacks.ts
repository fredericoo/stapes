import type { PlacedTile } from "../../app/lib/types";
import { Board, tile } from "./board";
import { N4, N8 } from "./grid";
import { OPPOSITE, SIDEWAYS, STEP, type Plan } from "./plan";
import { Ground, type Island } from "./terrain";

type Kind = "grass" | "sand" | "snow" | "basalt";

const KIND: Record<number, Kind> = {
  [Ground.Grass]: "grass",
  [Ground.Woods]: "grass",
  [Ground.DeepWoods]: "grass",
  [Ground.Bog]: "grass",
  [Ground.Lake]: "grass",
  [Ground.River]: "grass",
  [Ground.Beach]: "sand",
  [Ground.Shallows]: "sand",
  [Ground.Desert]: "sand",
  [Ground.Basalt]: "basalt",
  [Ground.Lava]: "basalt",
  [Ground.Snow]: "snow",
  [Ground.Rock]: "snow",
};

const BASE: Record<Kind, string> = {
  grass: "grass-2",
  sand: "sand-dunes",
  snow: "snow",
  basalt: "sand-dunes",
};
const WALL: Record<Kind, string> = {
  grass: "hill-wall",
  sand: "hill-wall-sandstone",
  snow: "hill-wall-frost",
  basalt: "hill-wall-basalt",
};
const BRINK: Record<Kind, string> = {
  grass: "grass-brink",
  sand: "sand-brink",
  snow: "snow-brink",
  basalt: "basalt-brink",
};

/** What a ramp is made of on each ground: the slope, and the half-height block the top half of the climb stands on. */
const RAMP: Record<Kind, { slope: string; block: string }> = {
  grass: { slope: "ramp", block: "half-stone" },
  sand: { slope: "ramp", block: "half-stone" },
  snow: { slope: "snowy-ramp", block: "frosted-half-stone" },
  basalt: { slope: "ramp", block: "half-stone" },
};

export const kindAt = (island: Island, i: number): Kind => KIND[island.ground[i]!] ?? "grass";
export const baseTile = (island: Island, i: number) => BASE[kindAt(island, i)];

/**
 * Lays the ground: a filled column under every raised cell, its top cut to a
 * brink where the wall below it has open air beside it (`docs/terrain.md`),
 * water and its beds, the sea ring with foam along the sand, then the ramps,
 * bridges and roads the plan placed.
 */
export function writeTerrain(island: Island, plan: Plan): Board {
  const { width: w, height: h, level, ground } = island;
  const n = w * h;
  const beach = island.place("wreckBeach");
  const board = new Board(w, h, -beach.x, -beach.y);
  const heads = new Set(plan.ramps.map((r) => r.head));
  const lakeDepth = depthIn(island, (i) => ground[i] === Ground.Lake);
  const lavaNear = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (ground[i] !== Ground.Lava) continue;
    forNeighbours(w, h, i, N8, (j) => {
      if (ground[j] !== Ground.Lava) lavaNear[j] = 1;
    });
  }

  const besideGrass = new Uint8Array(n);
  const besideShallows = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    forNeighbours(w, h, i, N8, (j) => {
      if (KIND[ground[j]!] === "grass" && level[j]! >= 0) besideGrass[i] = 1;
      if (ground[j] === Ground.Shallows) besideShallows[i] = 1;
    });
  }

  for (let i = 0; i < n; i++) {
    const L = level[i]!;
    if (L < 0) continue;
    const x = i % w;
    const y = (i - x) / w;
    const g = ground[i]!;
    if (g === Ground.DeepSea || g === Ground.Shallows) {
      board.set(x, y, 0, seaStack(island, i));
      continue;
    }
    if (
      besideShallows[i] &&
      L === 0 &&
      KIND[g] === "grass" &&
      g !== Ground.River &&
      g !== Ground.Lake
    )
      ground[i] = Ground.Beach;
    if (g === Ground.Basalt && besideGrass[i]) ground[i] = Ground.Desert;
    const kind = kindAt(island, i);
    const base = BASE[kind];
    for (let z = 0; z < L; z++) {
      board.set(
        x,
        y,
        z,
        heads.has(i) && z === L - 1
          ? [tile(base), tile(RAMP[kind].block), tile(RAMP[kind].block)]
          : [tile(base), tile(WALL[kind])],
      );
    }
    let drop = false;
    forNeighbours(w, h, i, N8, (j) => {
      if (level[j]! < L) drop = true;
    });
    const edge = drop && !heads.has(i) && L > 0;
    const ground0 = edge ? BRINK[kind] : base;
    let top: PlacedTile[];
    switch (ground[i]) {
      case Ground.River:
        top = [tile("grass-2"), tile("dirt"), tile("water")];
        break;
      case Ground.Lake:
        top =
          lakeDepth[i]! <= 1
            ? [tile("grass-2"), tile("dirt"), tile("water")]
            : [tile("water"), tile("deep-water")];
        break;
      case Ground.Bog:
        top = bogPond(island, i)
          ? [tile("grass-2"), tile("dirt"), tile("mud"), tile("water"), tile("swamp")]
          : [tile(ground0), tile("mud")];
        break;
      case Ground.Lava:
        top = [tile("sand-dunes"), tile("basalt"), tile("lava-crust"), tile("lava")];
        break;
      case Ground.Basalt:
        top = edge
          ? [tile(ground0)]
          : lavaNear[i]
            ? [tile("sand-dunes"), tile("basalt"), tile("lava-crust")]
            : [tile("sand-dunes"), tile("basalt")];
        break;
      default:
        top = [tile(ground0)];
    }
    board.set(x, y, L, top);
  }

  for (const r of plan.ramps) {
    const z = level[r.low]!;
    const direction = OPPOSITE[r.climbs];
    const lx = r.low % w;
    const hx = r.high % w;
    /** Both cells take the high one's ground, so a ramp on the edge of the snow is not half of each. */
    const { slope, block } = RAMP[kindAt(island, r.high)];
    board.set(lx, Math.floor(r.low / w), z, [
      tile(baseTile(island, r.low)),
      tile(slope, direction),
    ]);
    board.set(hx, Math.floor(r.high / w), z, [
      tile(baseTile(island, r.high)),
      tile(block),
      tile(slope, direction),
    ]);
  }

  for (let i = 0; i < n; i++) {
    if (!plan.road[i] || plan.reserved[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    const stack = board.get(x, y, level[i]!);
    if (!stack || stack.length !== 1) continue;
    board.set(x, y, level[i]!, [tile(baseTile(island, i)), tile("dirt")]);
  }

  for (const bridge of plan.bridges) {
    const side = SIDEWAYS[bridge.across];
    for (const c of bridge.cells) {
      for (const o of [0, 1, -1]) {
        const x = (c % w) + STEP[side][0] * o;
        const y = Math.floor(c / w) + STEP[side][1] * o;
        const under = board.get(x, y, bridge.level) ?? [];
        const kept = under.filter((p) => p.tileId !== "dirt" || ground[y * w + x] === Ground.River);
        board.set(
          x,
          y,
          bridge.level,
          o === 0
            ? [...kept, tile("wooden-floor")]
            : [...kept, tile("wooden-floor"), tile("fence")],
        );
      }
    }
  }
  return board;
}

/** Open sea is bare `deep-water`; the cells next to the shallows have `water` under it, and the shallows foam where they meet dry sand. */
function seaStack(island: Island, i: number): PlacedTile[] {
  const { width: w, height: h, ground } = island;
  if (ground[i] === Ground.DeepSea) {
    let besideShallows = false;
    forNeighbours(w, h, i, N8, (j) => {
      if (ground[j] === Ground.Shallows) besideShallows = true;
    });
    return besideShallows ? [tile("water"), tile("deep-water")] : [tile("deep-water")];
  }
  let besideSand = false;
  forNeighbours(w, h, i, N4, (j) => {
    const g = ground[j]!;
    if (g === Ground.Beach || g === Ground.Desert) besideSand = true;
  });
  return besideSand
    ? [tile("sand-dunes"), tile("water"), tile("shore-foam")]
    : [tile("sand-dunes"), tile("water")];
}

/** Open water in the bog lies in pools a few cells across, between banks of mud. */
function bogPond(island: Island, i: number): boolean {
  const x = i % island.width;
  const y = (i - x) / island.width;
  return Math.sin(x * 0.37) + Math.sin(y * 0.31) + Math.sin((x + y) * 0.23 + 1.7) > -0.4;
}

export function forNeighbours(
  w: number,
  h: number,
  i: number,
  offsets: ReadonlyArray<readonly [number, number]>,
  visit: (j: number) => void,
) {
  const x = i % w;
  const y = (i - x) / w;
  for (const [dx, dy] of offsets) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < w && ny < h) visit(ny * w + nx);
  }
}

/** How many steps in from the edge of the region each of its cells is, by four-way flood. */
function depthIn(island: Island, inside: (i: number) => boolean): Uint8Array {
  const { width: w, height: h } = island;
  const n = w * h;
  const depth = new Uint8Array(n);
  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!inside(i)) continue;
    let edge = false;
    forNeighbours(w, h, i, N4, (j) => {
      if (!inside(j)) edge = true;
    });
    if (edge) {
      depth[i] = 1;
      queue.push(i);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    forNeighbours(w, h, i, N4, (j) => {
      if (inside(j) && !depth[j]) {
        depth[j] = Math.min(255, depth[i]! + 1);
        queue.push(j);
      }
    });
  }
  return depth;
}
