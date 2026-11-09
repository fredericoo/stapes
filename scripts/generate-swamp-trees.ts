import { PNG } from "pngjs";
import { CELL_SIZE, HEIGHT_PER_LEVEL, type TileDef } from "../app/lib/types";
import { add, castSprite, type Hit, normalise, scale, type Vec3 } from "./limb-caster";
import { paint, writeTileset } from "./tileset-output";

const TILESET_ID = "swamp-trees";
const FRAME_MS = 200;

const CELL = CELL_SIZE;
const SPRITE_CELLS = 3;
const SPRITE_PX = SPRITE_CELLS * CELL;
/** The ground cell is the sprite's south-east one, so the tree has two cells to lean and spread into. */
const GROUND_PX = SPRITE_PX - CELL;
const CANOPY_TOP_PX = SPRITE_PX - 2;
const PROJECTION = { spritePx: SPRITE_PX, groundPx: GROUND_PX, topPx: CANOPY_TOP_PX };

/** Palette indices. */
const DUSK = 22;
const PLUM = 8;
const AUBERGINE = 2;
const NIGHT = 0;
const LICHEN = 27;
const SAGE = 25;

const BARK_RAMP = [DUSK, PLUM, AUBERGINE, NIGHT];
const MOSS_RAMP = [LICHEN, SAGE, SAGE, SAGE];

/** `mossy` limbs grow moss strands; a `strand` is one. */
type Limb = {
  from: Vec3;
  to: Vec3;
  radiusFrom: number;
  radiusTo: number;
  mossy: boolean;
  strand: boolean;
};

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

/** Lit from the south-west, as every other block here: bands across the screen from that edge. */
function shade({ normal, limb }: Hit<Limb>): number {
  const ramp = limb.strand ? MOSS_RAMP : BARK_RAMP;
  const across = (normal[0] - normal[1]) / Math.SQRT2 - normal[2] * 0.5;
  const band = Math.floor(((across + 1) / 2) * ramp.length);
  return ramp[Math.max(0, Math.min(ramp.length - 1, band))]!;
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
    const limbs = [...trunk, ...strands(trunk, species.seed)];
    castSprite(limbs, PROJECTION, shade, (u, v, index) =>
      paint(sheet, column * SPRITE_PX + u, v, index),
    );
    return treeTile(species, column);
  });
  await writeTileset(TILESET_ID, "Swamp Trees", sheet, tiles);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
