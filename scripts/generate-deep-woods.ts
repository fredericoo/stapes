import { PNG } from "pngjs";
import { scatterSeedMatching } from "../app/lib/scatter";
import {
  CELL_SIZE,
  HEIGHT_PER_LEVEL,
  type TileDef,
  type TileHeight,
  type TileSprite,
} from "../app/lib/types";
import {
  add,
  castSprite,
  type Hit,
  normalise,
  type Projection,
  scale,
  type Vec3,
} from "./limb-caster";
import { castModel } from "./model-caster";
import { paint, writeTileset } from "./tileset-output";

const TILESET_ID = "deep-woods";
const CELL = CELL_SIZE;

/** Palette indices. */
const NIGHT = 0;
const SLATE = 4;
const EARTH = 3;
const RUST = 11;
const NAVY = 5;
const PINE = 6;
const MAUVE = 8;
const MOSS = 15;
const GREEN = 16;
const DUSK = 22;
const ASH = 25;

const LEAF_RAMP = [NIGHT, NAVY, PINE, MOSS];
const LEAF_STEPS = [0.14, 0.34, 0.6];
const BARK_RAMP = [NIGHT, SLATE, MAUVE, DUSK];
const BARK_STEPS = [0.2, 0.42, 0.78];
const ROOT_RAMP = [NIGHT, SLATE, MAUVE];
const EARTH_RAMP = [NIGHT, EARTH, RUST];
const EARTH_STEPS = [0.35, 0.7];
const ROOT_STEPS = [0.4, 0.86];
/** `grass-2` is MOSS, so a fern's lit side skips it or the fern sinks into the grass. */
const FROND_RAMP = [NAVY, PINE, GREEN];
const FROND_STEPS = [0.28, 0.8];

/** From above, the west and a little south, as `generate-apple-trees.ts` lights its crowns. */
const LIGHT = normalise([-0.6, 0.35, 0.75]);
const AMBIENT = 0.2;

type Part = "bark" | "log" | "root" | "earth" | "leaf" | "frond";
/** `facing` is the outward direction of the crown a leaf bundle sits on. */
type Limb = {
  from: Vec3;
  to: Vec3;
  radiusFrom: number;
  radiusTo: number;
  part: Part;
  occlusion: number;
  facing?: Vec3;
  tone?: number;
};

function limb(
  from: Vec3,
  to: Vec3,
  radiusFrom: number,
  radiusTo: number,
  part: Part,
  occlusion = 0,
): Limb {
  return { from, to, radiusFrom, radiusTo, part, occlusion };
}

/** A capsule of zero length divides by zero in the caster, so a ball is a very short one. */
function ball(at: Vec3, radius: number, occlusion: number, facing?: Vec3): Limb {
  return { ...limb(at, [at[0], at[1], at[2] + 0.01], radius, radius, "leaf", occlusion), facing };
}

/** Mulberry32: the same seed draws the same plant on every run. */
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

function step(intensity: number, ramp: readonly number[], steps: readonly number[]): number {
  let i = 0;
  while (i < steps.length && intensity > steps[i]!) i++;
  return ramp[i]!;
}

function lambert(normal: Vec3, wrap: boolean): number {
  const dot = normal[0] * LIGHT[0] + normal[1] * LIGHT[1] + normal[2] * LIGHT[2];
  return AMBIENT + (1 - AMBIENT) * (wrap ? dot / 2 + 0.5 : Math.max(0, dot));
}

/** Moss grows in patches along the top of the log, where it faces up. */
function mossy(normal: Vec3, at: Vec3): boolean {
  return normal[2] > 0.6 && Math.sin(at[0] * 1.3 + 1) + Math.sin(at[0] * 0.55) > -0.2;
}

function shade({ normal, limb, at }: Hit<Limb>): number {
  if (limb.part === "log" && mossy(normal, at)) return lambert(normal, true) > 0.85 ? GREEN : PINE;
  if (limb.part === "bark" || limb.part === "log")
    return step(lambert(normal, true), BARK_RAMP, BARK_STEPS);
  if (limb.part === "earth") return step(lambert(normal, true), EARTH_RAMP, EARTH_STEPS);
  if (limb.part === "root") return step(lambert(normal, true), ROOT_RAMP, ROOT_STEPS);
  if (limb.tone !== undefined) {
    const dot = normal[0] * LIGHT[0] + normal[1] * LIGHT[1] + normal[2] * LIGHT[2];
    const lift = dot > 0.8 ? 1 : dot < 0.3 ? -1 : 0;
    return LEAF_RAMP[Math.max(0, Math.min(LEAF_RAMP.length - 1, limb.tone + lift))]!;
  }
  /** Each bundle is lit mostly as the crown it belongs to, so the bundles read as texture and not as stripes. */
  const n = limb.facing ? normalise(add(scale(normal, 0.8), scale(limb.facing, 0.2))) : normal;
  const light = lambert(n, false) * (1 - limb.occlusion);
  if (limb.part === "frond") return step(light, FROND_RAMP, FROND_STEPS);
  return step(light, LEAF_RAMP, LEAF_STEPS);
}

/**
 * The old tree stands on the shared corner of a 2×2 footprint, which is the
 * north-west corner of the anchor cell, so its feet are at the origin. The
 * sprite is five cells square to leave the wide crown room to lean into.
 */
const TREE_CELLS = 6;
const TREE_PX = TREE_CELLS * CELL;
const TREE_PROJECTION: Projection = { spritePx: TREE_PX, groundPx: TREE_PX - CELL, topPx: 28 };

/**
 * The crown is a handful of lobes of different sizes round the ends of the
 * limbs, not one ball: the gaps and bulges between them are what make it read
 * as foliage. Each lobe is a dark core under leaf bundles scattered over its
 * upper surface, as the apple tree's crown is.
 */
type Lobe = { centre: Vec3; radius: number; depth: number; bundles: number };

const LOBES: Lobe[] = [
  { centre: [-6.5, 3, 14], radius: 3.8, depth: 2.6, bundles: 12 },
  { centre: [3.5, -6, 15], radius: 3.8, depth: 2.6, bundles: 12 },
  { centre: [4, 4.5, 13.5], radius: 3.4, depth: 2.4, bundles: 10 },
  { centre: [-1.5, -1.5, 18.5], radius: 4.6, depth: 2.8, bundles: 16 },
  { centre: [-5.5, -4, 16.5], radius: 3.6, depth: 2.4, bundles: 11 },
  { centre: [6.5, -0.5, 16], radius: 3.2, depth: 2.2, bundles: 9 },
  { centre: [-2, 5.5, 16], radius: 3.4, depth: 2.4, bundles: 10 },
  { centre: [1, -3, 13.5], radius: 3.6, depth: 2.2, bundles: 10 },
];
const BUNDLE_PX = 2.2;

function crown(seed: number): Limb[] {
  const rand = random(seed);
  const out: Limb[] = [];
  for (const lobe of LOBES) {
    const [cx, cy, cz] = lobe.centre;
    const height = Math.max(0, Math.min(1, (cz - 14) / 4));
    out.push({
      ...limb(
        [cx - 1, cy - 1, cz - 0.5],
        [cx + 1, cy + 1, cz - 0.5],
        lobe.radius - 0.8,
        lobe.radius - 0.8,
        "leaf",
        0,
      ),
      tone: 0,
    });
    for (let i = 0; i < lobe.bundles; i++) {
      const theta = rand() * Math.PI * 2;
      const z = rand() * 1.25 - 0.25;
      const ring = Math.sqrt(Math.max(0, 1 - z * z));
      const d = normalise([Math.cos(theta) * ring, Math.sin(theta) * ring, z]);
      const facing = d[0] * LIGHT[0] + d[1] * LIGHT[1] + d[2] * LIGHT[2];
      const exposure = Math.max(0, Math.min(1, 0.35 + 0.3 * d[2] + 0.3 * facing + 0.25 * height));
      out.push({
        ...ball(
          [cx + d[0] * lobe.radius, cy + d[1] * lobe.radius, cz + d[2] * lobe.depth],
          BUNDLE_PX * (0.8 + rand() * 0.45),
          0,
        ),
        tone: exposure > 0.42 ? 2 : exposure > 0.18 ? 1 : 0,
      });
    }
  }
  return out;
}

/** Buttress roots: each leaves the trunk a little above the ground and dives into it a cell out. */
function roots(seed: number): Limb[] {
  const rand = random(seed);
  const out: Limb[] = [];
  const count = 5;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rand() * 0.5;
    const reach = 5 + rand() * 2;
    const bend = (rand() - 0.5) * 0.6;
    const mid: Vec3 = [Math.cos(a + bend) * reach * 0.55, Math.sin(a + bend) * reach * 0.55, 0.9];
    const end: Vec3 = [Math.cos(a) * reach, Math.sin(a) * reach, -0.2];
    out.push(limb([0, 0, 2.4], mid, 2, 1.3, "root"), limb(mid, end, 1.3, 0.6, "root"));
  }
  return out;
}

function oldTreeLimbs(): Limb[] {
  return [
    ...crown(4021),
    limb([0, 0, 0], [0.2, 0.2, 11], 3.4, 2.4, "bark"),
    limb([0.2, 0.2, 9], [-4.5, 2, 14.5], 1.6, 0.9, "bark"),
    limb([0.2, 0.2, 9.5], [3, -4, 14.5], 1.5, 0.8, "bark"),
    limb([0.2, 0.2, 9.5], [2.5, 3.5, 14], 1.3, 0.7, "bark"),
    ...roots(77),
  ];
}

const COVER_CELLS = 2;
const COVER_PX = COVER_CELLS * CELL;
const COVER_PROJECTION: Projection = { spritePx: COVER_PX, groundPx: CELL, topPx: 8 };
const COVER_CENTRE = CELL / 2;

/** A frond rises from the clump's heart, arches over and droops at its tip, in three pieces. */
function fern(seed: number, trodden: boolean): Limb[] {
  const rand = random(seed);
  const lift = trodden ? 0.25 : 1;
  const out: Limb[] = [];
  const count = 9;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rand() * 0.6;
    const reach = 3.8 + rand() * 1.6;
    const along = (t: number, z: number): Vec3 => [
      COVER_CENTRE + Math.cos(a) * reach * t,
      COVER_CENTRE + Math.sin(a) * reach * t,
      z * lift + 0.4,
    ];
    const peak = 2.6 + rand() * 1.2;
    const base = along(0, 0.3);
    const knee = along(0.35, peak * 0.85);
    const crest = along(0.7, peak);
    const tip = along(1, peak * 0.45);
    out.push(
      limb(base, knee, 0.6, 0.8, "frond", 0.2),
      limb(knee, crest, 0.9, 0.7, "frond"),
      limb(crest, tip, 0.7, 0.35, "frond"),
    );
  }
  return out;
}

/** Low brush: a few bare twigs with a handful of small leaf clusters caught on them. */
function brush(seed: number): Limb[] {
  const rand = random(seed);
  const out: Limb[] = [];
  for (let i = 0; i < 5; i++) {
    const a = rand() * Math.PI * 2;
    const from: Vec3 = [COVER_CENTRE + (rand() - 0.5) * 3, COVER_CENTRE + (rand() - 0.5) * 3, 0];
    const to: Vec3 = [from[0] + Math.cos(a) * 3, from[1] + Math.sin(a) * 3, 2 + rand() * 1.5];
    out.push(limb(from, to, 0.45, 0.3, "bark"));
    out.push(ball(to, 1.2 + rand() * 0.4, 0, [0, 0, 1]));
  }
  for (let i = 0; i < 6; i++) {
    const at: Vec3 = [COVER_CENTRE + (rand() - 0.5) * 6, COVER_CENTRE + (rand() - 0.5) * 6, 1.2];
    out.push(ball(at, 1.3 + rand() * 0.5, 0.1, [0, 0, 1]));
  }
  return out;
}

/** Roots breaking the ground across the cell: two or three snaking cords half sunk into it. */
function surfaceRoots(seed: number): Limb[] {
  const rand = random(seed);
  const out: Limb[] = [];
  for (let i = 0; i < 3; i++) {
    /** East–west or along the screen's rising diagonal: a root running north–south draws as an upright post. */
    const a = rand() < 0.5 ? (rand() - 0.5) * 0.8 : (3 * Math.PI) / 4 + (rand() - 0.5) * 0.6;
    const offset = (rand() - 0.5) * 4;
    const nx = -Math.sin(a);
    const ny = Math.cos(a);
    let prev: Vec3 = [
      COVER_CENTRE - Math.cos(a) * 4 + nx * offset,
      COVER_CENTRE - Math.sin(a) * 4 + ny * offset,
      -0.2,
    ];
    for (let s = 1; s <= 3; s++) {
      const wiggle = (rand() - 0.5) * 2;
      const next: Vec3 = [
        COVER_CENTRE + Math.cos(a) * (-4 + (8 * s) / 3) + nx * (offset + wiggle),
        COVER_CENTRE + Math.sin(a) * (-4 + (8 * s) / 3) + ny * (offset + wiggle),
        s === 3 ? -0.2 : 0.3,
      ];
      out.push(limb(prev, next, 0.95, 0.85, "root"));
      prev = next;
    }
  }
  return out;
}

/**
 * The fallen tree lies along x across its two cells, the anchor being the
 * eastern one, with its torn-up root plate standing on edge at the west end
 * and broken branch stubs along the top.
 */
const LOG_CELLS = 3;
const LOG_PX = LOG_CELLS * CELL;
const LOG_PROJECTION: Projection = { spritePx: LOG_PX, groundPx: LOG_PX - CELL, topPx: 12 };

function fallenLogLimbs(): Limb[] {
  const rand = random(911);
  const plate: Vec3 = [-5.6, 3.8, 2.6];
  const out: Limb[] = [
    limb([6.8, 4.4, 1.8], plate, 1.7, 2.4, "log"),
    limb([1, 4.1, 3.6], [2.2, 5.6, 6], 0.75, 0.45, "bark"),
    limb([4.2, 4.3, 3.2], [5.4, 2.2, 4.6], 0.6, 0.4, "bark"),
    limb([-2, 3.9, 4.2], [-1.4, 3.2, 6.4], 0.65, 0.4, "bark"),
  ];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    out.push({
      ...ball([plate[0] - 0.9, plate[1] + Math.cos(a) * 2, plate[2] + 0.6 + Math.sin(a) * 2], 2, 0),
      part: "earth",
    });
  }
  const count = 8;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rand() * 0.4;
    const reach = 4.2 + rand() * 1.4;
    const mid: Vec3 = [
      plate[0] - 0.6,
      plate[1] + Math.cos(a) * reach * 0.55,
      plate[2] + Math.sin(a) * reach * 0.55,
    ];
    const tip: Vec3 = [
      plate[0] - 1.4 - rand(),
      plate[1] + Math.cos(a + 0.3) * reach,
      plate[2] + Math.sin(a + 0.3) * reach,
    ];
    out.push(limb(plate, mid, 1.3, 0.8, "bark"), limb(mid, tip, 0.8, 0.35, "bark"));
  }
  return out;
}

/**
 * The stump is a flat-topped cylinder on flared roots. Its cut top is
 * weathered grey rather than fresh wood, with its rings in a darker grey.
 */
const STUMP_CELLS = 2;
const STUMP_PX = STUMP_CELLS * CELL;
const STUMP_PROJECTION: Projection = { spritePx: STUMP_PX, groundPx: CELL, topPx: 6 };
const STUMP_CENTRE = CELL / 2;
const STUMP_RADIUS = 3.2;
const STUMP_TOP = 2.8;
const STUMP_ROOTS = 4;

type StumpHit = { normal: Vec3; at: Vec3; face: "top" | "side" };

/** The surface normal of a tapered capsule at `p`, or null when `p` is outside it. */
function capsuleNormal(p: Vec3, a: Vec3, b: Vec3, ra: number, rb: number): Vec3 | null {
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const t = Math.max(
    0,
    Math.min(
      1,
      ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) /
        (d[0] ** 2 + d[1] ** 2 + d[2] ** 2),
    ),
  );
  const axis = add(a, scale(d, t));
  const off: Vec3 = [p[0] - axis[0], p[1] - axis[1], p[2] - axis[2]];
  const r = Math.hypot(...off);
  return r <= ra + (rb - ra) * t && r > 0 ? scale(off, 1 / r) : null;
}

function stumpSample(p: Vec3): StumpHit | null {
  const dx = p[0] - STUMP_CENTRE;
  const dy = p[1] - STUMP_CENTRE;
  const r = Math.hypot(dx, dy);
  if (r <= STUMP_RADIUS && p[2] <= STUMP_TOP) {
    if (p[2] > STUMP_TOP - 0.4) return { normal: [0, 0, 1], at: p, face: "top" };
    return { normal: [dx / r, dy / r, 0], at: p, face: "side" };
  }
  for (let i = 0; i < STUMP_ROOTS; i++) {
    const a = (i / STUMP_ROOTS) * Math.PI * 2 + 0.5;
    const from: Vec3 = [STUMP_CENTRE, STUMP_CENTRE, 1.4];
    const to: Vec3 = [STUMP_CENTRE + Math.cos(a) * 5.4, STUMP_CENTRE + Math.sin(a) * 5.4, -0.3];
    const normal = capsuleNormal(p, from, to, 1.6, 0.6);
    if (normal) return { normal, at: p, face: "side" };
  }
  return null;
}

function stumpShade({ normal, at, face }: StumpHit): number {
  if (face === "side") return step(lambert(normal, true), BARK_RAMP, BARK_STEPS);
  const ring = Math.hypot(at[0] - STUMP_CENTRE, at[1] - STUMP_CENTRE);
  if (ring > STUMP_RADIUS - 0.6) return MAUVE;
  return Math.floor(ring / 0.8) % 2 === 0 ? ASH : DUSK;
}

function blit(
  sheet: PNG,
  pixels: Int16Array,
  size: number,
  left: number,
  top: number,
  width = size,
) {
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < width; u++) {
      const index = pixels[v * size + u]!;
      if (index >= 0) paint(sheet, left + u, top + v, index);
    }
  }
}

function sprite(
  x: number,
  y: number,
  w: number,
  h: number,
  base: { x: number; y: number },
): TileSprite {
  return { frames: [{ sprite: { rect: { x, y, w, h }, base }, durationMs: 200 }] };
}

function coverSprite(column: number): TileSprite {
  return sprite(column * COVER_CELLS, 0, COVER_CELLS, COVER_CELLS, { x: 1, y: 1 });
}

const COVER_ROW = TREE_CELLS;
const VARIANTS = 2;

type Cover = {
  tileId: string;
  name: string;
  height: TileHeight;
  draw: (variant: number) => Limb[];
  fields: Partial<TileDef>;
};

/**
 * Ferns are swamp-plant style: intangible, so the ground under them keeps its
 * pace, and pressure plates that lie flat while someone stands in them. Brush
 * and roots are solid ground cover at height 0 with their own slower pace,
 * which is how `mud` and `swamp` slow a walk.
 */
const COVERS: Cover[] = [
  {
    tileId: "fern",
    name: "Fern",
    height: 1,
    draw: (v) => fern(300 + v * 17, false),
    fields: { intangible: true },
  },
  {
    tileId: "fern-trodden",
    name: "Fern (trodden)",
    height: 1,
    draw: (v) => fern(300 + v * 17, true),
    fields: { intangible: true },
  },
  {
    tileId: "undergrowth",
    name: "Undergrowth",
    height: 0,
    draw: (v) => brush(500 + v * 23),
    fields: { walkable: true, walkSpeedPercent: -35 },
  },
  {
    tileId: "tree-roots",
    name: "Tree roots",
    height: 0,
    draw: (v) => surfaceRoots(700 + v * 29),
    fields: { walkable: true, walkSpeedPercent: -20 },
  },
];

function castLimbs(limbs: Limb[], projection: Projection): Int16Array {
  const out = new Int16Array(projection.spritePx ** 2).fill(-1);
  castSprite(limbs, projection, shade, (u, v, index) => {
    out[v * projection.spritePx + u] = index;
  });
  return out;
}

const LEAF = new Set([NAVY, PINE, MOSS]);

/** A leaf pixel that matches none of its four neighbours reads as noise, so it takes the colour most of them share. */
function tidy(pixels: Int16Array, size: number): Int16Array {
  const out = pixels.slice();
  for (let v = 1; v < size - 1; v++) {
    for (let u = 1; u < size - 1; u++) {
      const p = pixels[v * size + u]!;
      if (!LEAF.has(p)) continue;
      const around = [
        pixels[v * size + u - 1]!,
        pixels[v * size + u + 1]!,
        pixels[(v - 1) * size + u]!,
        pixels[(v + 1) * size + u]!,
      ].filter((n) => LEAF.has(n));
      if (around.length < 3 || around.includes(p)) continue;
      const votes = new Map<number, number>();
      for (const n of around) votes.set(n, (votes.get(n) ?? 0) + 1);
      out[v * size + u] = [...votes].sort((a, b) => b[1] - a[1])[0]![0];
    }
  }
  return out;
}

/**
 * Outlines the crown as `tree` and `apple-tree` are outlined: night on the
 * shadowed lower-right edge and pine on the lit upper-left one. Only leaf
 * pixels get an edge, so the roots stay on the ground.
 */
function outlineCrown(pixels: Int16Array, size: number): Int16Array {
  const out = pixels.slice();
  const at = (u: number, v: number) =>
    u < 0 || v < 0 || u >= size || v >= size ? -1 : pixels[v * size + u]!;
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      if (at(u, v) >= 0) continue;
      if (LEAF.has(at(u - 1, v)) || LEAF.has(at(u, v - 1))) out[v * size + u] = NIGHT;
      else if (LEAF.has(at(u + 1, v)) || LEAF.has(at(u, v + 1))) out[v * size + u] = PINE;
    }
  }
  return out;
}

async function main() {
  const coverColumns = COVERS.length * VARIANTS;
  const sheet = new PNG({
    width: Math.max(TREE_CELLS + LOG_CELLS + STUMP_CELLS, coverColumns * COVER_CELLS) * CELL,
    height: (TREE_CELLS + COVER_CELLS) * CELL,
  });
  sheet.data.fill(0);
  const tiles: TileDef[] = [];

  const crown = tidy(castLimbs(oldTreeLimbs(), TREE_PROJECTION), TREE_PX);
  blit(sheet, outlineCrown(crown, TREE_PX), TREE_PX, 0, 0);
  tiles.push({
    id: "old-tree",
    name: "Old tree",
    height: HEIGHT_PER_LEVEL,
    type: "simple",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET_ID, x: 0, y: 0 },
    footprint: { w: 2, d: 2 },
    walkable: false,
    sprite: sprite(0, 0, TREE_CELLS, TREE_CELLS, { x: TREE_CELLS - 1, y: TREE_CELLS - 1 }),
    interactions: {
      endure: { durability: 48, suffers: [{ statusId: "burned", tileId: "" }] },
      respawn: { fromMs: 600000, toMs: 1200000 },
    },
  });

  blit(sheet, castLimbs(fallenLogLimbs(), LOG_PROJECTION), LOG_PX, TREE_PX, 0);
  tiles.push({
    id: "fallen-log",
    name: "Fallen log",
    height: 2,
    type: "simple",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET_ID, x: TREE_CELLS, y: 0 },
    footprint: { w: 2, d: 1 },
    walkable: false,
    lightPassing: true,
    sprite: sprite(0, 0, LOG_CELLS, LOG_CELLS, { x: LOG_CELLS - 1, y: LOG_CELLS - 1 }),
    interactions: { endure: { durability: 24, suffers: [{ statusId: "burned", tileId: "" }] } },
  });

  const stump = castModel({ sample: stumpSample, shade: stumpShade }, STUMP_PROJECTION);
  blit(sheet, stump, STUMP_PX, TREE_PX + LOG_PX, 0);
  tiles.push({
    id: "tree-stump",
    name: "Tree stump",
    height: 1,
    type: "simple",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET_ID, x: TREE_CELLS + LOG_CELLS, y: 0 },
    walkable: false,
    lightPassing: true,
    sprite: sprite(0, 0, STUMP_CELLS, STUMP_CELLS, { x: 1, y: 1 }),
    interactions: { endure: { durability: 20, suffers: [{ statusId: "burned", tileId: "" }] } },
  });

  COVERS.forEach((cover, c) => {
    for (let variant = 0; variant < VARIANTS; variant++) {
      const column = c * VARIANTS + variant;
      const cast = castLimbs(cover.draw(variant), COVER_PROJECTION);
      blit(sheet, cast, COVER_PX, column * COVER_PX, COVER_ROW * CELL);
    }
    tiles.push({
      id: cover.tileId,
      name: cover.name,
      height: cover.height,
      type: "scatter",
      kind: "prop",
      attributes: {},
      anchor: { tilesetId: TILESET_ID, x: c * VARIANTS * COVER_CELLS, y: COVER_ROW },
      lightPassing: true,
      ...cover.fields,
      scatter: Array.from({ length: VARIANTS }, (_, v) => coverSprite(v)),
    });
  });

  const fern = tiles.find((t) => t.id === "fern")!;
  const trodden = tiles.find((t) => t.id === "fern-trodden")!;
  fern.interactions = { pressurePlate: { tileId: trodden.id, type: "gte", height: 1 } };
  trodden.interactions = { pressurePlate: { tileId: fern.id, type: "lte", height: 0 } };
  trodden.scatterSeed = scatterSeedMatching(trodden.id, fern.id);

  await writeTileset(TILESET_ID, "Deep Woods", sheet, tiles);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
