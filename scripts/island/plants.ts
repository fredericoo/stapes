import { tile } from "./board";
import type { Builder } from "./build";
import { footprint } from "./landmarks";
import { Ground } from "./terrain";

type Chance = readonly [string, number];

/** What grows on each kind of ground, as a share of its open cells. */
const GROWTH: Partial<Record<number, readonly Chance[]>> = {
  [Ground.Grass]: [
    ["tree", 0.025],
    ["apple-tree", 0.003],
    ["bush", 0.008],
    ["small-bush", 0.008],
    ["yellow-flowers", 0.012],
    ["red-flowers", 0.01],
    ["grass", 0.02],
  ],
  [Ground.Woods]: [
    ["tree", 0.13],
    ["apple-tree", 0.008],
    ["bush", 0.02],
    ["fern", 0.04],
    ["mushroom-patch", 0.005],
  ],
  [Ground.DeepWoods]: [
    ["tree", 0.17],
    ["fern", 0.08],
    ["undergrowth", 0.06],
    ["tree-roots", 0.02],
    ["mushroom-patch", 0.01],
    ["blue-mushroom-patch", 0.003],
  ],
  [Ground.Bog]: [
    ["dead-tree", 0.04],
    ["reeds", 0.06],
    ["cattails", 0.04],
  ],
  [Ground.Desert]: [
    ["saguaro", 0.01],
    ["barrel-cactus", 0.008],
    ["prickly-pear", 0.008],
    ["bleached-bones", 0.005],
    ["dead-tree", 0.002],
  ],
  [Ground.Basalt]: [["bleached-bones", 0.004]],
  [Ground.Snow]: [
    ["snowy-pine", 0.05],
    ["snowy-rock", 0.03],
    ["ice-spike", 0.008],
  ],
  [Ground.Rock]: [
    ["snowy-rock", 0.06],
    ["snowy-pine", 0.03],
  ],
  [Ground.Beach]: [["driftwood", 0.004]],
};

const SWAMP_GROWTH: readonly Chance[] = [
  ["reeds", 0.12],
  ["cattails", 0.08],
  ["duckweed", 0.1],
  ["swamp-lily", 0.04],
];

const hash = (x: number, y: number, salt: number) => {
  let h = (x * 374761393 + y * 668265263 + salt * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

function pick(chances: readonly Chance[], roll: number): string | null {
  let sum = 0;
  for (const [id, share] of chances) {
    sum += share;
    if (roll < sum) return id;
  }
  return null;
}

/**
 * Plants every open cell by its ground, from a hash of its position so a
 * regenerated map grows the same woods. Roads, ramps, bridges and every site
 * are left bare, with a cell's margin round each so nothing walls them in.
 */
export function plant(b: Builder) {
  const { island, plan, board } = b;
  const { width: w, height: h } = island;
  const clear = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!plan.road[i] && !plan.reserved[i] && !plan.siteOf[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) clear[(y + dy) * w + x + dx] = 1;
  }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (clear[i]) continue;
      const z = island.level[i]!;
      if (z < 0) continue;
      const stack = board.get(x, y, z);
      if (!stack) continue;
      const g = island.ground[i]!;
      const roll = hash(x, y, 1);
      const swamp = stack[stack.length - 1]?.tileId === "swamp";
      if (swamp) {
        const id = pick(SWAMP_GROWTH, roll);
        if (id) stack.push(tile(id));
        continue;
      }
      const bare = stack.length === 1 || (stack.length === 2 && stack[1]!.tileId === "mud");
      if (!bare) continue;
      if (g === Ground.DeepWoods && roll < 0.012 && fits2x2(b, x, y, z, clear)) {
        footprint(b, { x, y }, z, "old-tree", 2, 2);
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ] as const) {
          clear[(y + dy) * w + x + dx] = 1;
        }
        continue;
      }
      const chances = GROWTH[g];
      if (!chances) continue;
      const id = pick(chances, hash(x, y, 2));
      if (!id) continue;
      if (b.tilesById[id]?.walkable === false && besideDrop(b, x, y, z)) continue;
      stack.push(tile(id));
    }
  }
}

/** A cell next to a change of level, where a plant that blocks could wall in the foot of a cliff. */
function besideDrop(b: Builder, x: number, y: number, z: number): boolean {
  const { island } = b;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (island.level[(y + dy) * island.width + x + dx] !== z) return true;
    }
  }
  return false;
}

function fits2x2(b: Builder, x: number, y: number, z: number, clear: Uint8Array): boolean {
  const { island, board } = b;
  for (const [dx, dy] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const) {
    const i = (y + dy) * island.width + x + dx;
    if (
      clear[i] ||
      island.level[i] !== z ||
      island.ground[i] !== Ground.DeepWoods ||
      besideDrop(b, x + dx, y + dy, z)
    )
      return false;
    const stack = board.get(x + dx, y + dy, z);
    if (!stack || stack.length !== 1) return false;
  }
  return true;
}
