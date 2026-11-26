import { growTallTree, TALL_TREES } from "../../app/editor/compose/tallTrees";
import { physicalHeight } from "../../app/lib/types";
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
    ["tuft", 0.02],
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
    ["saguaro", 0.003],
    ["barrel-cactus", 0.002],
    ["prickly-pear", 0.002],
    ["bleached-bones", 0.0015],
    ["dead-tree", 0.0005],
  ],
  [Ground.Basalt]: [["bleached-bones", 0.002]],
  [Ground.Snow]: [
    ["snowy-pine", 0.014],
    ["snowy-rock", 0.007],
    ["ice-spike", 0.002],
  ],
  [Ground.Rock]: [
    ["snowy-rock", 0.018],
    ["snowy-pine", 0.008],
  ],
  [Ground.Beach]: [["driftwood", 0.004]],
};

/** Dunes cover several cells each, so their share is of the cells a dune may start on. */
const DUNES: ReadonlyArray<{ id: string; w: number; d: number; share: number }> = [
  { id: "sand-dune", w: 3, d: 2, share: 0.0012 },
  { id: "sand-dune-crescent", w: 4, d: 3, share: 0.0006 },
];
const DUNE_SALT = 3;

const SWAMP_GROWTH: readonly Chance[] = [
  ["reeds", 0.12],
  ["cattails", 0.08],
  ["duckweed", 0.1],
  ["swamp-lily", 0.04],
];

/** Every tile this plants, so a later pass can tell growth from anything built. */
export const GROWN = new Set<string>([
  ...Object.values(GROWTH).flatMap((chances) => chances!.map(([id]) => id)),
  ...SWAMP_GROWTH.map(([id]) => id),
  ...DUNES.map((dune) => dune.id),
  "old-tree",
  "old-tree-trunk",
  "old-tree-crown",
]);

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
 * are left bare, with a cell's margin round each so nothing walls them in,
 * except the cells of a site `wild` gives back to the land round it.
 */
export function plant(b: Builder, wild: Uint8Array) {
  const { island, plan, board } = b;
  const { width: w, height: h } = island;
  const clear = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!plan.road[i] && !plan.reserved[i] && (!plan.siteOf[i] || wild[i])) continue;
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
      const bare =
        stack.length === 1 ||
        (stack.length === 2 && stack[1]!.tileId === "mud" && g === Ground.Bog);
      if (!bare) continue;
      if (g === Ground.Desert && placeDune(b, x, y, z, clear)) continue;
      if (
        g === Ground.DeepWoods &&
        roll < 0.012 &&
        fits(b, x, y, z, 1, 1, Ground.DeepWoods, clear)
      ) {
        const above = growTallTree(
          TALL_TREES["old-tree"]!,
          Math.floor(hash(x, y, 3) * 4294967296),
          (id) => physicalHeight(b.tilesById[id]!),
          (level) => !b.board.get(x, y, level)?.length,
          z,
        );
        if (above) {
          stack.push(tile("old-tree"));
          above.forEach((pieces, i) => b.board.set(x, y, z + i + 1, pieces));
          clear[i] = 1;
          continue;
        }
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

/** Whether a `w` × `d` footprint from `x`, `y` lies on bare `ground`, on one level, away from any drop. */
function fits(
  b: Builder,
  x: number,
  y: number,
  z: number,
  w: number,
  d: number,
  ground: number,
  clear: Uint8Array,
): boolean {
  const { island, board } = b;
  for (let dy = 0; dy < d; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const i = (y + dy) * island.width + x + dx;
      if (
        clear[i] ||
        island.level[i] !== z ||
        island.ground[i] !== ground ||
        besideDrop(b, x + dx, y + dy, z)
      )
        return false;
      const stack = board.get(x + dx, y + dy, z);
      if (!stack || stack.length !== 1) return false;
    }
  }
  return true;
}

function placeDune(b: Builder, x: number, y: number, z: number, clear: Uint8Array): boolean {
  const dune = pickDune(hash(x, y, DUNE_SALT));
  if (!dune || !fits(b, x, y, z, dune.w, dune.d, Ground.Desert, clear)) return false;
  footprint(b, { x, y }, z, dune.id, dune.w, dune.d);
  for (let dy = 0; dy < dune.d; dy++)
    for (let dx = 0; dx < dune.w; dx++) clear[(y + dy) * b.island.width + x + dx] = 1;
  return true;
}

function pickDune(roll: number) {
  let sum = 0;
  for (const dune of DUNES) {
    sum += dune.share;
    if (roll < sum) return dune;
  }
  return null;
}
