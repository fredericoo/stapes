import { PNG } from "pngjs";
import { CELL_SIZE, HEIGHT_PER_LEVEL, type TileDef } from "../app/lib/types";
import { paint, writeTileset } from "./tileset-output";

const TILESET_ID = "swamp-trees";
const FRAME_MS = 200;

const CELL = CELL_SIZE;
const SPRITE_CELLS = 3;
const SPRITE_PX = SPRITE_CELLS * CELL;
/** The ground cell is the sprite's south-east one, so the tree has two cells to lean and spread into. */
const GROUND_PX = SPRITE_PX - CELL;
const CANOPY_TOP_PX = SPRITE_PX - 2;

const SUPERSAMPLE = 3;
const MARCH_STEP_PX = 1 / 32;

/** Palette indices. */
const DUSK = 22;
const PLUM = 8;
const AUBERGINE = 2;
const NIGHT = 0;
const LICHEN = 27;
const SAGE = 25;

const BARK_RAMP = [DUSK, PLUM, AUBERGINE, NIGHT];
const MOSS_RAMP = [LICHEN, SAGE, SAGE, SAGE];

type Vec3 = [number, number, number];
/** `mossy` limbs grow moss strands; a `strand` is one. */
type Limb = {
  from: Vec3;
  to: Vec3;
  radiusFrom: number;
  radiusTo: number;
  mossy: boolean;
  strand: boolean;
};
type Bounded = Limb & { low: number; high: number };

/**
 * A tree grows from the middle of its cell: a trunk of `kinks` bends that wander
 * by `wander`, then `forks` limbs at each joint above `forkFrom`, each shorter
 * and thinner, to `depth` generations. `moss` hangs strands from the limbs.
 */
type Species = {
  tileId: string;
  name: string;
  seed: number;
  trunkHeightPx: number;
  trunkRadiusPx: number;
  lean: [number, number];
  kinks: number;
  wander: number;
  forks: number;
  depth: number;
  moss: boolean;
};

const SPECIES: Species[] = [
  {
    tileId: "dead-tree",
    name: "Dead tree",
    seed: 7,
    trunkHeightPx: 6,
    trunkRadiusPx: 1.8,
    lean: [0, 0],
    kinks: 3,
    wander: 0.35,
    forks: 2,
    depth: 3,
    moss: false,
  },
  {
    tileId: "dead-tree-twisted",
    name: "Dead tree (twisted)",
    seed: 31,
    trunkHeightPx: 6,
    trunkRadiusPx: 2,
    lean: [0.35, 0.2],
    kinks: 4,
    wander: 0.6,
    forks: 2,
    depth: 3,
    moss: false,
  },
  {
    tileId: "mossy-dead-tree",
    name: "Mossy dead tree",
    seed: 12,
    trunkHeightPx: 7,
    trunkRadiusPx: 1.9,
    lean: [-0.15, 0.1],
    kinks: 3,
    wander: 0.3,
    forks: 2,
    depth: 3,
    moss: true,
  },
  {
    tileId: "dead-snag",
    name: "Dead snag",
    seed: 5,
    trunkHeightPx: 5,
    trunkRadiusPx: 2,
    lean: [0.1, -0.1],
    kinks: 2,
    wander: 0.3,
    forks: 1,
    depth: 1,
    moss: false,
  },
];

/** Mulberry32: the same seed draws the same tree on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

function normalise(a: Vec3): Vec3 {
  return scale(a, 1 / Math.hypot(...a));
}

const MIN_LIMB_RADIUS_PX = 0.5;

type Growth = { at: Vec3; heading: Vec3; length: number; radius: number; generation: number };

function grow(species: Species): Limb[] {
  const rand = random(species.seed);
  const limbs: Limb[] = [];
  const trunk: Growth = {
    at: [CELL / 2, CELL / 2, 0],
    heading: normalise([species.lean[0], species.lean[1], 1]),
    length: species.trunkHeightPx,
    radius: species.trunkRadiusPx,
    generation: 0,
  };
  const queue = [trunk];
  while (queue.length > 0) {
    const limb = queue.shift()!;
    const end = growLimb(limb, species, rand, limbs);
    if (limb.generation >= species.depth) continue;
    const count = limb.generation === 0 ? species.forks + 1 : species.forks;
    for (let i = 0; i < count; i++) queue.push(fork(limb, end, i, count, rand));
  }
  return limbs;
}

/** Walks one limb in `kinks` straight pieces, turning a little at each, and returns where it ended. */
function growLimb(limb: Growth, species: Species, rand: () => number, limbs: Limb[]): Vec3 {
  const pieces = limb.generation === 0 ? species.kinks : 2;
  const step = limb.length / pieces;
  const tipRadius = limb.radius * 0.55;
  let at = limb.at;
  let heading = limb.heading;
  for (let i = 0; i < pieces; i++) {
    const to = add(at, scale(heading, step));
    const radiusFrom = limb.radius + ((tipRadius - limb.radius) * i) / pieces;
    const radiusTo = limb.radius + ((tipRadius - limb.radius) * (i + 1)) / pieces;
    limbs.push({
      from: at,
      to,
      radiusFrom,
      radiusTo,
      mossy: species.moss && limb.generation > 0,
      strand: false,
    });
    at = to;
    const turn: Vec3 = [(rand() - 0.5) * species.wander, (rand() - 0.5) * species.wander, 0];
    heading = normalise(add(heading, turn));
  }
  return at;
}

/** Children spread evenly round the parent's heading, tilted out from it, with jitter. */
function fork(parent: Growth, at: Vec3, i: number, count: number, rand: () => number): Growth {
  const spin = (2 * Math.PI * (i + rand() * 0.6)) / count + parent.generation;
  const tilt = 1.4 + rand() * 0.8;
  const out: Vec3 = [Math.cos(spin) * tilt, Math.sin(spin) * tilt, 0.2 + rand() * 0.4];
  return {
    at,
    heading: normalise(add(parent.heading, out)),
    length: parent.length * (0.6 + rand() * 0.25),
    radius: Math.max(parent.radius * 0.6, MIN_LIMB_RADIUS_PX),
    generation: parent.generation + 1,
  };
}

const STRAND_RADIUS_PX = 0.3;

/** Spanish moss: short strands hanging straight down from the far end of mossy limbs. */
function strands(limbs: Limb[], seed: number): Limb[] {
  const rand = random(seed + 1);
  return limbs
    .filter((limb) => limb.mossy && rand() < 0.35)
    .map((limb) => {
      const length = 1 + rand() * 2.5;
      const top = limb.to;
      return {
        from: top,
        to: [top[0], top[1], Math.max(0.5, top[2] - length)] as Vec3,
        radiusFrom: STRAND_RADIUS_PX + 0.1,
        radiusTo: STRAND_RADIUS_PX,
        mossy: false,
        strand: true,
      };
    });
}

type Hit = { normal: Vec3; limb: Limb };

/** How far `p` is inside the tapered capsule round a limb; positive is inside. */
function insideLimb(limb: Limb, p: Vec3): { depth: number; axis: Vec3 } {
  const d: Vec3 = [limb.to[0] - limb.from[0], limb.to[1] - limb.from[1], limb.to[2] - limb.from[2]];
  const rel: Vec3 = [p[0] - limb.from[0], p[1] - limb.from[1], p[2] - limb.from[2]];
  const lengthSq = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
  const t = Math.max(0, Math.min(1, (rel[0] * d[0] + rel[1] * d[1] + rel[2] * d[2]) / lengthSq));
  const axis = add(limb.from, scale(d, t));
  const radius = limb.radiusFrom + (limb.radiusTo - limb.radiusFrom) * t;
  const off = Math.hypot(p[0] - axis[0], p[1] - axis[1], p[2] - axis[2]);
  return { depth: radius - off, axis };
}

/**
 * Walks the view ray down from above the tallest limb. A point at height `z` is
 * drawn `z` pixels up and to the left of where it stands, so the ray through
 * sprite pixel `u, v` meets `u - GROUND_PX + z, v - GROUND_PX + z` at that height.
 */
function castRay(limbs: Bounded[], u: number, v: number): Hit | null {
  for (let z = CANOPY_TOP_PX; z > 0; z -= MARCH_STEP_PX) {
    const p: Vec3 = [u - GROUND_PX + z, v - GROUND_PX + z, z];
    for (const limb of limbs) {
      if (z < limb.low || z > limb.high) continue;
      const { depth, axis } = insideLimb(limb, p);
      if (depth >= 0)
        return { limb, normal: normalise([p[0] - axis[0], p[1] - axis[1], p[2] - axis[2]]) };
    }
  }
  return null;
}

/** Lit from the south-west, as every other block here: bands across the screen from that edge. */
function shade({ normal, limb }: Hit): number {
  const ramp = limb.strand ? MOSS_RAMP : BARK_RAMP;
  const across = (normal[0] - normal[1]) / Math.SQRT2 - normal[2] * 0.5;
  const band = Math.floor(((across + 1) / 2) * ramp.length);
  return ramp[Math.max(0, Math.min(ramp.length - 1, band))]!;
}

/** A limb thinner than a pixel still draws when a third of the pixel's samples meet it. */
const COVERAGE_SHARE = 1 / 4;

function bounded(limb: Limb): Bounded {
  const reach = Math.max(limb.radiusFrom, limb.radiusTo);
  return {
    ...limb,
    low: Math.min(limb.from[2], limb.to[2]) - reach,
    high: Math.max(limb.from[2], limb.to[2]) + reach,
  };
}

function samplePixel(limbs: Bounded[], u: number, v: number): number | null {
  const votes = new Map<number, number>();
  let hits = 0;
  for (let j = 0; j < SUPERSAMPLE; j++) {
    for (let i = 0; i < SUPERSAMPLE; i++) {
      const hit = castRay(limbs, u + (i + 0.5) / SUPERSAMPLE, v + (j + 0.5) / SUPERSAMPLE);
      if (!hit) continue;
      hits++;
      const index = shade(hit);
      votes.set(index, (votes.get(index) ?? 0) + 1);
    }
  }
  if (hits < SUPERSAMPLE * SUPERSAMPLE * COVERAGE_SHARE) return null;
  return [...votes].sort((a, b) => b[1] - a[1])[0]![0];
}

function treeTile(species: Species, column: number): TileDef {
  return {
    id: species.tileId,
    name: species.name,
    height: HEIGHT_PER_LEVEL,
    type: "simple",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET_ID, x: column * SPRITE_CELLS, y: 0 },
    walkable: false,
    lightPassing: true,
    sprite: {
      frames: [
        {
          sprite: {
            rect: { x: 0, y: 0, w: SPRITE_CELLS, h: SPRITE_CELLS },
            base: { x: SPRITE_CELLS - 1, y: SPRITE_CELLS - 1 },
          },
          durationMs: FRAME_MS,
        },
      ],
    },
  };
}

async function main() {
  const sheet = new PNG({ width: SPECIES.length * SPRITE_PX, height: SPRITE_PX });
  sheet.data.fill(0);
  const tiles = SPECIES.map((species, column) => {
    const trunk = grow(species);
    const limbs = [...trunk, ...strands(trunk, species.seed)].map(bounded);
    for (let v = 0; v < SPRITE_PX; v++) {
      for (let u = 0; u < SPRITE_PX; u++) {
        const index = samplePixel(limbs, u, v);
        if (index !== null) paint(sheet, column * SPRITE_PX + u, v, index);
      }
    }
    return treeTile(species, column);
  });
  await writeTileset(TILESET_ID, "Swamp Trees", sheet, tiles);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
