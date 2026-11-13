import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { STAPES_PALETTE } from "../app/lib/palette";
import { CELL_SIZE, HEIGHT_PER_LEVEL, type TileDef } from "../app/lib/types";
import { paintRgba, type Rgba, writeTileset } from "./tileset-output";

const TILESET_ID = "apple-trees";
const FRAME_MS = 200;
const CELL = CELL_SIZE;

type Vec3 = [number, number, number];

const C = {
  outline: "#2e222f",
  leafDark: "#165a4c",
  leafMid: "#239063",
  leafLight: "#1ebc73",
  leafPale: "#91db69",
  barkDark: "#6e2727",
  barkMid: "#9e4539",
  barkLight: "#cd683d",
} as const;

/**
 * `steps` are thresholds on the light intensity between the ramp's entries.
 * `wrap` shades half-Lambert, so a trunk's shadowed side lands on the mid entry
 * rather than the dark one; leaves are not wrapped, so each bundle gets a dark
 * crescent on its shadowed side.
 */
type Material = {
  ramp: readonly string[];
  steps: readonly number[];
  outline: string;
  wrap: boolean;
};

const LEAF: Material = {
  ramp: [C.leafDark, C.leafMid, C.leafLight, C.leafPale],
  steps: [0.24, 0.46, 0.76],
  outline: C.leafDark,
  wrap: false,
};

const BARK: Material = {
  ramp: [C.barkDark, C.barkMid, C.barkLight],
  steps: [0.44, 0.64],
  outline: C.outline,
  wrap: true,
};

/** A `segment` is a cone frustum from `from` to `to`, `radius` wide at each end: a trunk or limb. */
type Solid =
  | {
      kind: "ellipsoid";
      centre: Vec3;
      radii: Vec3;
      material: Material;
      yaw: number;
      occlusion?: number;
    }
  | { kind: "segment"; from: Vec3; to: Vec3; radius: [number, number]; material: Material };

function trunk(height: number, bottom: number, top: number): Solid {
  return {
    kind: "segment",
    from: [0, 0, 0],
    to: [0, 0, height],
    radius: [bottom, top],
    material: BARK,
  };
}

function limb(from: Vec3, to: Vec3, thick: number, thin: number): Solid {
  return { kind: "segment", from, to, radius: [thick, thin], material: BARK };
}

/** Bumped by `main` when a face fails its checks, so the rebuilt face has new clumps. */
let variation = 0;

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

/** Leaf bundles this far apart, centre to centre, over a crown's surface. */
const BUNDLE_SPACING = 3.2;

/**
 * A crown built the way pixel artists draw one: a dark core under a shell of
 * leaf bundles of one size, evenly spaced, each shaded as its own little ball
 * so it gets a lit cap and a shadowed crescent. A bundle is darkened by how far
 * it faces down and away from the light, so the crown's underside sinks into
 * shadow while its top-left catches the light.
 */
function crown(centre: Vec3, radii: Vec3, bundle: number, seed: number): Solid[] {
  const rand = random(seed + variation * 1013);
  const out: Solid[] = [
    {
      kind: "ellipsoid",
      centre,
      radii: [radii[0] * 0.75, radii[1] * 0.75, radii[2] * 0.75],
      material: LEAF,
      yaw: 0,
      occlusion: 0.6,
    },
  ];
  const mean = (radii[0] * radii[1] + radii[0] * radii[2] + radii[1] * radii[2]) / 3;
  const count = Math.round((4 * Math.PI * mean) / BUNDLE_SPACING ** 2);
  const spin = rand() * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    /** Fibonacci sphere: evenly spread points, so the bundles keep one spacing as the articles ask. */
    const z = 1 - (2 * (i + 0.5)) / count;
    const ring = Math.sqrt(1 - z * z);
    const theta = i * 2.399963 + spin + (rand() - 0.5) * 0.5;
    const d = normalise([
      Math.cos(theta) * ring,
      Math.sin(theta) * ring,
      z + (rand() - 0.5) * 0.15,
    ]);
    if (d[2] < -0.55) continue;
    const exposure = Math.max(
      0,
      Math.min(1, 0.55 + 0.35 * d[2] + 0.3 * (d[0] * LIGHT[0] + d[1] * LIGHT[1] + d[2] * LIGHT[2])),
    );
    const size = bundle * (0.9 + rand() * 0.2);
    out.push({
      kind: "ellipsoid",
      centre: [
        centre[0] + d[0] * radii[0],
        centre[1] + d[1] * radii[1],
        centre[2] + d[2] * radii[2],
      ],
      radii: [size, size, size * 0.85],
      material: LEAF,
      yaw: 0,
      occlusion: (1 - exposure) * 0.4,
    });
  }
  return out;
}

type Design = {
  tileId: string;
  name: string;
  cells: number;
  build: () => Solid[];
};

/**
 * World units are pixels with the trunk's foot at the origin, `z` up. An apple
 * tree is short and spreading: a low trunk forking into two limbs under one
 * crown wider than it is tall, in chunky bundles.
 */
const DESIGNS: Design[] = [
  {
    tileId: "apple-tree",
    name: "Apple tree",
    cells: 3,
    build: () => [
      trunk(2.8, 1.9, 1.4),
      limb([0, 0, 2.4], [-2.6, 1.2, 5], 1, 0.5),
      limb([0, 0, 2.4], [1.2, -2.6, 5.2], 1, 0.5),
      ...crown([-1.4, -1.4, 6.4], [4.4, 4.2, 2.9], 2.4, 2029),
    ],
  },
];

/** From above, the west and a little south: the crown's highlight lands top-left and a trunk keeps a lit side. */
const LIGHT = normalise([-0.6, 0.35, 0.75]);
const AMBIENT = 0.18;
const SUPERSAMPLE = 4;

function normalise(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

type Hit = { t: number; normal: Vec3; material: Material; occlusion?: number };

/**
 * The line `(sx, sy, 0) + t (1, 1, 1)` in an ellipsoid's frame: rotated by
 * `-yaw` about z and scaled into the unit sphere.
 */
function unitFrame(s: { centre: Vec3; radii: Vec3; yaw: number }, sx: number, sy: number) {
  const [cx, cy, cz] = s.centre;
  const [rx, ry, rz] = s.radii;
  const cos = Math.cos(-s.yaw);
  const sin = Math.sin(-s.yaw);
  const lx = (sx - cx) * cos - (sy - cy) * sin;
  const ly = (sx - cx) * sin + (sy - cy) * cos;
  const ldx = cos - sin;
  const ldy = sin + cos;
  return {
    origin: [lx / rx, ly / ry, -cz / rz] as Vec3,
    dir: [ldx / rx, ldy / ry, 1 / rz] as Vec3,
    toWorld: (n: Vec3): Vec3 =>
      normalise([n[0] * cos + n[1] * sin, -n[0] * sin + n[1] * cos, n[2]]),
  };
}

/** The far root of `|o + d t| = radius`, and the near one. */
function sphereRoots(o: Vec3, d: Vec3, radius: number): [number, number] | null {
  const a = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
  const b = 2 * (o[0] * d[0] + o[1] * d[1] + o[2] * d[2]);
  const c = o[0] ** 2 + o[1] ** 2 + o[2] ** 2 - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  return [(-b + Math.sqrt(disc)) / (2 * a), (-b - Math.sqrt(disc)) / (2 * a)];
}

function traceEllipsoid(
  s: Extract<Solid, { kind: "ellipsoid" }>,
  sx: number,
  sy: number,
): Hit | null {
  const { origin: o, dir: d, toWorld } = unitFrame(s, sx, sy);
  const roots = sphereRoots(o, d, 1);
  if (!roots) return null;
  const t = roots[0];
  const [rx, ry, rz] = s.radii;
  const p: Vec3 = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
  return {
    t,
    normal: toWorld([p[0] / rx, p[1] / ry, p[2] / rz]),
    material: s.material,
    occlusion: s.occlusion,
  };
}

/**
 * The line against a cone frustum round `from -> to`, solved in the frame
 * where the axis is `a`: the surface is `|perp|² = (r0 + q·along)²`.
 */
function traceSegment(s: Extract<Solid, { kind: "segment" }>, sx: number, sy: number): Hit | null {
  const A = s.from;
  const L = Math.hypot(s.to[0] - A[0], s.to[1] - A[1], s.to[2] - A[2]);
  const a = normalise([s.to[0] - A[0], s.to[1] - A[1], s.to[2] - A[2]]);
  const [r0, r1] = s.radius;
  const q = (r1 - r0) / L;
  const w: Vec3 = [sx - A[0], sy - A[1], -A[2]];
  const wa = w[0] * a[0] + w[1] * a[1] + w[2] * a[2];
  const Da = a[0] + a[1] + a[2];
  const wp: Vec3 = [w[0] - wa * a[0], w[1] - wa * a[1], w[2] - wa * a[2]];
  const Dp: Vec3 = [1 - Da * a[0], 1 - Da * a[1], 1 - Da * a[2]];
  const m = r0 + q * wa;
  const k = q * Da;
  const qa = Dp[0] ** 2 + Dp[1] ** 2 + Dp[2] ** 2 - k * k;
  const qb = 2 * (wp[0] * Dp[0] + wp[1] * Dp[1] + wp[2] * Dp[2]) - 2 * m * k;
  const qc = wp[0] ** 2 + wp[1] ** 2 + wp[2] ** 2 - m * m;
  const roots: number[] = [];
  if (Math.abs(qa) < 1e-9) {
    if (Math.abs(qb) > 1e-9) roots.push(-qc / qb);
  } else {
    const disc = qb * qb - 4 * qa * qc;
    if (disc >= 0)
      roots.push((-qb + Math.sqrt(disc)) / (2 * qa), (-qb - Math.sqrt(disc)) / (2 * qa));
  }
  let best: Hit | null = null;
  for (const t of roots) {
    const along = wa + Da * t;
    const r = r0 + q * along;
    if (along < 0 || along > L || r < 0 || (best && t <= best.t)) continue;
    const perp: Vec3 = [
      sx + t - A[0] - along * a[0],
      sy + t - A[1] - along * a[1],
      t - A[2] - along * a[2],
    ];
    const normal = normalise([
      perp[0] - r * q * a[0],
      perp[1] - r * q * a[1],
      perp[2] - r * q * a[2],
    ]);
    best = { t, normal, material: s.material };
  }
  if (r1 > 0 && Math.abs(Da) > 1e-9) {
    const t = (L - wa) / Da;
    const d: Vec3 = [sx + t - s.to[0], sy + t - s.to[1], t - s.to[2]];
    if (d[0] ** 2 + d[1] ** 2 + d[2] ** 2 <= r1 * r1 && (!best || t > best.t))
      best = { t, normal: a, material: s.material };
  }
  return best;
}

/** A screen point sees along `(sx + t, sy + t, t)`; the visible surface is the one with the largest `t`. */
function trace(sx: number, sy: number, solids: Solid[]): Hit | null {
  let best: Hit | null = null;
  for (const s of solids) {
    const hit = s.kind === "ellipsoid" ? traceEllipsoid(s, sx, sy) : traceSegment(s, sx, sy);
    if (hit && (!best || hit.t > best.t)) best = hit;
  }
  return best;
}

type Pixel = { colour: string; material: Material; depth: number } | null;

function render(design: Design, solids: Solid[]): Pixel[][] {
  const size = design.cells * CELL;
  const foot = size - CELL / 2;
  const out: Pixel[][] = [];
  for (let py = 0; py < size; py++) {
    const row: Pixel[] = [];
    for (let px = 0; px < size; px++) {
      let hits = 0;
      let shade = 0;
      let depth = 0;
      const byMaterial = new Map<Material, number>();
      for (let j = 0; j < SUPERSAMPLE; j++) {
        for (let i = 0; i < SUPERSAMPLE; i++) {
          const hit = trace(
            px + (i + 0.5) / SUPERSAMPLE - foot,
            py + (j + 0.5) / SUPERSAMPLE - foot,
            solids,
          );
          if (!hit) continue;
          hits++;
          depth = Math.max(depth, hit.t);
          const dot =
            hit.normal[0] * LIGHT[0] + hit.normal[1] * LIGHT[1] + hit.normal[2] * LIGHT[2];
          const lambert = hit.material.wrap ? dot / 2 + 0.5 : Math.max(0, dot);
          shade += (AMBIENT + (1 - AMBIENT) * lambert) * (1 - (hit.occlusion ?? 0));
          byMaterial.set(hit.material, (byMaterial.get(hit.material) ?? 0) + 1);
        }
      }
      if (hits * 2 < SUPERSAMPLE * SUPERSAMPLE) {
        row.push(null);
        continue;
      }
      const material = [...byMaterial].sort((a, b) => b[1] - a[1])[0]![0];
      const intensity = shade / hits;
      let step = 0;
      while (step < material.steps.length && intensity > material.steps[step]!) step++;
      step = Math.max(0, Math.min(material.ramp.length - 1, step));
      row.push({ colour: material.ramp[step]!, material, depth });
    }
    out.push(row);
  }
  tidy(out);
  outline(out);
  return out;
}

/**
 * Every pixel-art guide on foliage says the same: a pixel that matches none of
 * its neighbours reads as noise. Each one takes the colour most of its
 * neighbours share, so the crown is made of clusters only.
 */
function tidy(px: Pixel[][]): void {
  const size = px.length;
  const edits: [number, number, NonNullable<Pixel>][] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = px[y]![x];
      if (!p || p.material !== LEAF) continue;
      const around = [px[y]![x + 1], px[y]![x - 1], px[y + 1]?.[x], px[y - 1]?.[x]].filter(
        (n): n is NonNullable<Pixel> => !!n && n.material === LEAF,
      );
      if (around.length < 3 || around.some((n) => n.colour === p.colour)) continue;
      const votes = new Map<string, number>();
      for (const n of around) votes.set(n.colour, (votes.get(n.colour) ?? 0) + 1);
      const [colour] = [...votes].sort((a, b) => b[1] - a[1])[0]!;
      edits.push([x, y, { ...p, colour }]);
    }
  }
  for (const [x, y, p] of edits) px[y]![x] = p;
}

/** A depth jump towards the camera bigger than this, beyond the slope the surface already has, is a crease. */
const CREASE_DEPTH = 0.6;
/** Below this height a silhouette meets the ground and gets no outline, or the trunk would float. */
const GROUND_DEPTH = 2.5;

function creased(p: NonNullable<Pixel>, a: Pixel, b: Pixel): boolean {
  if (!a) return false;
  const expected = b ? p.depth - b.depth : 0;
  return a.depth - p.depth - expected > CREASE_DEPTH;
}

/**
 * The hand-drawn tree's outline: `#2e222f` on the lower-right edge, the leaf's
 * own dark green on the lit edges, and the same dark green inside the crown
 * wherever one lobe overlaps the one behind it. Bark is outlined down its
 * left side to the ground as well, for contrast against the grass, but keeps
 * the rest of its lit side.
 */
function outline(px: Pixel[][]): void {
  const size = px.length;
  const at = (x: number, y: number) =>
    y < 0 || y >= size || x < 0 || x >= size ? null : px[y]![x]!;
  const edits: [number, number, string][] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = at(x, y);
      if (!p) continue;
      const right = at(x + 1, y);
      const down = at(x, y + 1);
      const left = at(x - 1, y);
      const up = at(x, y - 1);
      const bark = p.material.outline === C.outline;
      const grounded = p.depth < GROUND_DEPTH;
      /** Creases separate one leaf lobe from the next; on bark, where a limb meets the trunk, they leave a lone dark pixel. */
      if ((bark && !left) || ((!right || (!down && !bark)) && !grounded))
        edits.push([x, y, C.outline]);
      else if (
        !bark &&
        (creased(p, right, left) ||
          creased(p, left, right) ||
          creased(p, down, up) ||
          creased(p, up, down))
      )
        edits.push([x, y, p.material.outline]);
      else if ((!left || !up) && !bark) edits.push([x, y, p.material.outline]);
    }
  }
  for (const [x, y, colour] of edits) px[y]![x] = { ...px[y]![x]!, colour };
}

/**
 * A crown edge running straight this long reads as a cut: five along a
 * diagonal, where a projected ellipse's flank makes a clean stair, seven along
 * an axis, since the hand-drawn tree's own underside runs flat for five.
 */
const STRAIGHT_DIAGONAL = 5;
const STRAIGHT_AXIS = 7;
const VARIATIONS = 12;

function longestStraightRun(px: Pixel[][], diagonal: boolean): number {
  const size = px.length;
  const at = (x: number, y: number) =>
    y < 0 || y >= size || x < 0 || x >= size ? null : px[y]![x]!;
  const leaf = (p: Pixel) => p !== null && p.material === LEAF;
  const shapes: [number, number, number, number][] = diagonal
    ? [
        [1, 1, 1, 0],
        [1, 1, 0, 1],
        [1, -1, 1, 0],
        [1, -1, 0, -1],
      ]
    : [
        [1, 0, 0, -1],
        [1, 0, 0, 1],
        [0, 1, -1, 0],
        [0, 1, 1, 0],
      ];
  let longest = 0;
  for (const [dx, dy, ox, oy] of shapes) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let n = 0;
        while (leaf(at(x + n * dx, y + n * dy)) && !at(x + n * dx + ox, y + n * dy + oy)) n++;
        longest = Math.max(longest, n);
      }
    }
  }
  return longest;
}

function touchesTopOrLeft(px: Pixel[][]): boolean {
  return px[0]!.some(Boolean) || px.some((row) => row[0]);
}

function acceptable(px: Pixel[][]): boolean {
  return (
    !touchesTopOrLeft(px) &&
    longestStraightRun(px, true) < STRAIGHT_DIAGONAL &&
    longestStraightRun(px, false) < STRAIGHT_AXIS
  );
}

function rgba(hex: string): Rgba {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
}

function treeTile(design: Design, cellX: number): TileDef {
  return {
    id: design.tileId,
    name: design.name,
    height: HEIGHT_PER_LEVEL,
    type: "simple",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET_ID, x: cellX, y: 0 },
    walkable: false,
    sprite: {
      frames: [
        {
          sprite: {
            rect: { x: 0, y: 0, w: design.cells, h: design.cells },
            base: { x: design.cells - 1, y: design.cells - 1 },
          },
          durationMs: FRAME_MS,
        },
      ],
    },
  };
}

async function writePreview(dir: string, sheet: PNG) {
  const zoom = 12;
  const big = new PNG({ width: sheet.width * zoom, height: sheet.height * zoom });
  for (let y = 0; y < big.height; y++) {
    for (let x = 0; x < big.width; x++) {
      const from = (sheet.width * Math.floor(y / zoom) + Math.floor(x / zoom)) << 2;
      const to = (big.width * y + x) << 2;
      for (let c = 0; c < 4; c++) big.data[to + c] = sheet.data[from + c]!;
    }
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${TILESET_ID}.png`), PNG.sync.write(big));
}

const RANCH_SHEET = path.resolve(
  import.meta.dirname,
  "..",
  "data",
  "tilesets",
  "tiny-ranch-tiles.png",
);
/** The `apple` tile's cell on the ranch sheet. */
const APPLE_CELL = { x: 1, y: 16 };

/**
 * `apple` recoloured as it rots: the reds go to rust and oxblood, the leaf
 * withers to plum, the black outline becomes the palette's own, and the
 * highlight dulls. Any colour not listed is a mistake in the source sprite.
 */
const ROT: Record<string, string> = {
  "#e83b3b": C.barkMid,
  "#981c00": C.barkDark,
  "#fcd8c4": C.barkLight,
  "#1ebc73": "#694f62",
  "#165a4c": "#45293f",
  "#000000": C.outline,
};
/** Bruises on the flesh, in the source sprite's own pixel coordinates. */
const ROT_SPOTS: readonly [number, number][] = [
  [4, 3],
  [2, 4],
];

async function paintRottenApple(sheet: PNG, cellX: number) {
  const ranch = PNG.sync.read(await fs.readFile(RANCH_SHEET));
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const i = (ranch.width * (APPLE_CELL.y * CELL + y) + APPLE_CELL.x * CELL + x) << 2;
      if (ranch.data[i + 3] === 0) continue;
      const hex = `#${[0, 1, 2].map((c) => ranch.data[i + c]!.toString(16).padStart(2, "0")).join("")}`;
      const spot = ROT_SPOTS.some(([sx, sy]) => sx === x && sy === y);
      const colour = spot ? "#45293f" : ROT[hex];
      if (!colour) throw new Error(`apple pixel ${x},${y} is ${hex}, which ROT does not map`);
      paintRgba(sheet, cellX * CELL + x, y, rgba(colour));
    }
  }
}

function rottenAppleTile(cellX: number): TileDef {
  return {
    id: "rotten-apple",
    name: "Rotten Apple",
    height: 0,
    type: "simple",
    kind: "item",
    attributes: {},
    anchor: { tilesetId: TILESET_ID, x: cellX, y: 0 },
    lightPassing: true,
    affectedByGravity: true,
    sprite: {
      frames: [
        {
          sprite: { rect: { x: 0, y: 0, w: 1, h: 1 }, base: { x: 0, y: 0 } },
          durationMs: FRAME_MS,
        },
      ],
    },
  };
}

async function main() {
  const palette = new Set(STAPES_PALETTE);
  for (const hex of [...Object.values(C), ...Object.values(ROT)])
    if (!palette.has(hex)) throw new Error(`${hex} is not in STAPES_PALETTE`);
  const width = (DESIGNS.reduce((sum, d) => sum + d.cells, 0) + 1) * CELL;
  const height = Math.max(...DESIGNS.map((d) => d.cells)) * CELL;
  const sheet = new PNG({ width, height });
  sheet.data.fill(0);
  const tiles: TileDef[] = [];
  let cellX = 0;
  for (const design of DESIGNS) {
    variation = 0;
    let pixels = render(design, design.build());
    for (variation = 1; variation < VARIATIONS && !acceptable(pixels); variation++)
      pixels = render(design, design.build());
    if (!acceptable(pixels)) console.warn(`${design.tileId}: no variation passed the edge checks`);
    pixels.forEach((row, y) =>
      row.forEach((p, x) => p && paintRgba(sheet, cellX * CELL + x, y, rgba(p.colour))),
    );
    tiles.push(treeTile(design, cellX));
    cellX += design.cells;
  }
  await paintRottenApple(sheet, cellX);
  tiles.push(rottenAppleTile(cellX));
  if (process.env.PREVIEW) await writePreview(process.env.PREVIEW, sheet);
  if (process.env.DRY) return;
  await writeTileset(TILESET_ID, "Apple Trees", sheet, tiles);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
