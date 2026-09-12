/**
 * Renders the tree sprites from small 3D models, in the game's own projection.
 * Run: bun run generate:trees
 *
 * A tree drawn pixel by pixel in this projection comes out as a billboard
 * skewed up-left: the crown is where a crown would be, but nothing about its
 * shading says it is round, and the trunk is a diagonal stroke rather than a
 * post seen from above. Modelling each species as a handful of solids —
 * ellipsoids for crown lobes, tapered segments for trunks, branches and a
 * conifer's tiers — and projecting them the way `app/lib/geometry.ts` projects the world
 * gets the perspective right for free, and the pixel art is then only a matter
 * of quantising the shading to the palette.
 *
 * The projection is the one every tile is drawn in: the ground is seen from
 * straight above, and height moves a point up and left on screen, one screen
 * pixel per world pixel of height on each axis (`levelScreenOffset` and
 * `elevationScreenOffset`). A screen pixel therefore sees the world along the
 * line `(sx + t, sy + t, t)`, and the surface it shows is the one with the
 * largest `t`. Each solid is intersected with that line analytically; there is
 * no rasteriser and no depth buffer, and nothing here needs a GPU.
 *
 * Every pixel of the output is an entry of `STAPES_PALETTE`. The shading is
 * quantised to a short ramp per material rather than matched to the nearest
 * palette entry, because the nearest entry to a mid-lit leaf is whatever green
 * the palette happens to have there, and a crown lit through a continuous
 * ramp reads as a render, not a sprite. Three levels per material, with the
 * lit/shadowed thresholds chosen by eye, is what the original tree uses.
 *
 * Writes the sprites into `data/tilesets/tiny-ranch-tiles.png` on the rows
 * reserved for them and upserts their entries in `data/tiles.json`. The
 * original `tree` at cell (2,6) is hand-drawn and untouched.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { STAPES_PALETTE } from "../app/lib/palette";

const ROOT = path.resolve(import.meta.dirname, "..");
const SHEET = path.join(ROOT, "data", "tilesets", "tiny-ranch-tiles.png");
const TILES = path.join(ROOT, "data", "tiles.json");
const TILESET_ID = "tiny-ranch-tiles";
const CELL = 8;

/** First sheet row (in cells) the trees occupy. Rows below it are theirs too. */
const SHEET_ROW = 20;

type Vec3 = [number, number, number];

/** Palette entries by the role they play, so a ramp reads as a ramp. */
const C = {
  outline: "#2e222f",
  leafDark: "#165a4c",
  leafMid: "#239063",
  leafLight: "#1ebc73",
  leafPale: "#91db69",
  leafLime: "#d5e04b",
  barkDark: "#6e2727",
  barkMid: "#9e4539",
  barkLight: "#cd683d",
  birchDark: "#313638",
  birchMid: "#c7dcd0",
  birchLight: "#ffffff",
  mapleDark: "#6e2727",
  mapleMid: "#ae2334",
  mapleLight: "#e83b3b",
  mapleTip: "#fb6b1d",
  bloomDark: "#362281",
  bloomMid: "#484a77",
  bloomLight: "#a884f3",
  palmDark: "#45293f",
  palmMid: "#694f62",
  palmLight: "#7f708a",
  cherryDark: "#694f62",
  cherryMid: "#cf657f",
  cherryLight: "#c7dcd0",
} as const;

/**
 * How a surface turns into pixels: a ramp from shadow to light, the colour of
 * its silhouette where it is lit, and how much the shading is jittered per
 * pixel. Leaves are jittered a lot — the dapple is what makes a crown a crown —
 * and bark not at all.
 */
type Material = {
  ramp: readonly string[];
  /** Ramp thresholds on lambert intensity, one fewer than ramp entries. */
  steps: readonly number[];
  outline: string;
  dapple: number;
  /**
   * Half-Lambert: shade on `n·l / 2 + 1/2` instead of `max(0, n·l)`. The
   * camera sees a trunk's south and east faces only, and under plain Lambert
   * everything east of south-east is equally black, so the band comes out
   * two flat stripes and reads as a post with square corners. Wrapped, the
   * gradient runs across the whole visible half and the post is round.
   */
  wrap?: boolean;
};

const LEAF: Material = {
  ramp: [C.leafDark, C.leafMid, C.leafLight],
  steps: [0.36, 0.68],
  outline: C.leafDark,
  dapple: 0.22,
};

/** Birch leaves: the same ramp shifted one step lighter, with a lime top. */
const BIRCH_LEAF: Material = {
  ramp: [C.leafMid, C.leafLight, C.leafPale, C.leafLime],
  steps: [0.36, 0.64, 0.88],
  outline: C.leafDark,
  dapple: 0.22,
};

/** Needles: darker than broadleaf, and dappled harder, since a tier is otherwise one flat slope. */
const NEEDLE: Material = {
  ramp: [C.leafDark, C.leafMid, C.leafLight],
  steps: [0.34, 0.72],
  outline: C.leafDark,
  dapple: 0.3,
};

const BARK: Material = {
  ramp: [C.barkDark, C.barkMid, C.barkLight],
  steps: [0.44, 0.64],
  outline: C.outline,
  dapple: 0.05,
  wrap: true,
};

/** Scots pine bark: the orange of the upper trunk, all the way down at this size. */
const PINE_BARK: Material = {
  ramp: [C.barkDark, C.barkMid, C.barkLight],
  steps: [0.4, 0.55],
  outline: C.outline,
  dapple: 0.05,
  wrap: true,
};

/** Birch bark: white, with the dark lenticels as a heavy dapple. */
const BIRCH_BARK: Material = {
  ramp: [C.birchDark, C.birchMid, C.birchMid, C.birchLight],
  steps: [0.2, 0.45, 0.68],
  outline: C.outline,
  dapple: 0.35,
  wrap: true,
};

/** Autumn maple: the palette's reds, tipped with orange where the light hits. */
const MAPLE_LEAF: Material = {
  ramp: [C.mapleDark, C.mapleMid, C.mapleLight, C.mapleTip],
  steps: [0.36, 0.66, 0.9],
  outline: C.mapleDark,
  dapple: 0.22,
};

/** Jacaranda in flower: violet through lilac, dappled like leaves. */
const BLOOM: Material = {
  ramp: [C.bloomDark, C.bloomMid, C.bloomLight],
  steps: [0.34, 0.62],
  outline: C.bloomDark,
  dapple: 0.24,
};

/** Cherry in blossom: mauve shadow, pink, and a pale highlight. */
const BLOSSOM: Material = {
  ramp: [C.cherryDark, C.cherryMid, C.cherryLight],
  steps: [0.34, 0.74],
  outline: C.cherryDark,
  dapple: 0.24,
};

/** Dead wood: bleached grey, no dapple, so the limbs read as one clean silhouette. */
const DEADWOOD: Material = {
  ramp: [C.birchDark, C.palmMid, C.palmLight],
  steps: [0.42, 0.66],
  outline: C.outline,
  dapple: 0,
  wrap: true,
};

/** A palm's fibrous grey trunk. */
const PALM_BARK: Material = {
  ramp: [C.palmDark, C.palmMid, C.palmLight],
  steps: [0.44, 0.64],
  outline: C.outline,
  dapple: 0.08,
  wrap: true,
};

type Solid =
  | { kind: "ellipsoid"; centre: Vec3; radii: Vec3; material: Material; yaw?: number }
  /**
   * A tapered segment from one point to another: `radius` is the radius at
   * `from` and at `to`. A trunk is one standing on the origin, thicker at the
   * foot; a branch is one leaning out of it; a conifer's tier is one that
   * narrows to nothing. Every stick-shaped thing is this.
   */
  | { kind: "segment"; from: Vec3; to: Vec3; radius: [number, number]; material: Material };

/** A vertical segment standing on the ground at `(x, y)`, `bottom` wide at the foot. */
function trunk(x: number, y: number, height: number, bottom: number, top: number, material: Material): Solid {
  return { kind: "segment", from: [x, y, 0], to: [x, y, height], radius: [bottom, top], material };
}

/** A tier of a conifer: a cone on the trunk's axis, `radius` wide at `z0`, a point at `z1`. */
function tier(radius: number, z0: number, z1: number, material: Material): Solid {
  return { kind: "segment", from: [0, 0, z0], to: [0, 0, z1], radius: [radius, 0], material };
}

/** A branch, `thick` at its root and `thin` at its tip. */
function branch(from: Vec3, to: Vec3, thick: number, thin: number, material: Material): Solid {
  return { kind: "segment", from, to, radius: [thick, thin], material };
}

type Species = {
  id: string;
  name: string;
  /** Size of the sprite in cells. */
  w: number;
  h: number;
  /** Where the trunk stands, as a cell within the rect. */
  base: { x: number; y: number };
  /** Model, in world pixels, with the trunk foot at the origin and z up. */
  solids: Solid[];
};

/**
 * The models. World units are pixels, so a cell is 8 across; z is height in
 * pixels, so a whole level is 8 and `height: 4` props top out around there.
 * The trunk foot is the origin and sits at the centre of the base cell.
 */
const SPECIES: Species[] = [
  {
    id: "oak",
    name: "English Oak",
    w: 3,
    h: 3,
    base: { x: 2, y: 2 },
    solids: [
      // The crown sits north-west of the trunk as well as above it, so its
      // south-east lobes clear the foot on screen and the trunk stays visible.
      trunk(0, 0, 10, 2.6, 1.7, BARK),
      branch([0, 0, 7], [6, -2, 9.5], 1.1, 0.5, BARK),
      branch([0, 0, 6], [2, 6, 9], 1, 0.5, BARK),
      { kind: "ellipsoid", centre: [-2, -2, 10.5], radii: [5.5, 5, 3.6], material: LEAF },
      { kind: "ellipsoid", centre: [-7, 0.5, 8], radii: [4.2, 3.8, 3], material: LEAF },
      { kind: "ellipsoid", centre: [2.5, -6, 8.5], radii: [4, 3.8, 3], material: LEAF },
      { kind: "ellipsoid", centre: [-4.5, 4, 8], radii: [3.8, 3.4, 2.8], material: LEAF },
      { kind: "ellipsoid", centre: [1, 1, 10], radii: [2.8, 2.6, 2.2], material: LEAF },
    ],
  },
  {
    id: "silver-birch",
    name: "Silver Birch",
    w: 3,
    h: 3,
    base: { x: 2, y: 2 },
    solids: [
      trunk(0, 0, 10, 1.9, 1.2, BIRCH_BARK),
      { kind: "ellipsoid", centre: [-0.5, -0.5, 12], radii: [4, 3.8, 3.8], material: BIRCH_LEAF },
      { kind: "ellipsoid", centre: [-4, 2, 9.5], radii: [2.8, 2.8, 2.6], material: BIRCH_LEAF },
      { kind: "ellipsoid", centre: [3, -3.5, 10], radii: [2.6, 2.6, 2.4], material: BIRCH_LEAF },
    ],
  },
  {
    id: "scots-pine",
    name: "Scots Pine",
    w: 3,
    h: 3,
    base: { x: 2, y: 2 },
    solids: [
      // Tiers shallower than the camera's 35° elevation, so each one's base
      // stands proud of the one above in depth and the crease pass draws it.
      // Steeper cones nest into one smooth hull and the tree reads as a
      // single teardrop.
      trunk(0, 0, 13, 2.4, 1.4, PINE_BARK),
      tier(6.5, 4, 7.5, NEEDLE),
      tier(5.2, 7.5, 11.5, NEEDLE),
      tier(3.8, 12, 16, NEEDLE),
    ],
  },
  {
    id: "autumn-maple",
    name: "Autumn Maple",
    w: 3,
    h: 3,
    base: { x: 2, y: 2 },
    solids: [
      // A dome of small lobes on a short forked trunk, in the palette's reds.
      trunk(0, 0, 6, 2.2, 1.4, BARK),
      branch([0, 0, 5], [-4, -1, 8.5], 1, 0.5, BARK),
      branch([0, 0, 5], [3, -3, 8], 0.9, 0.5, BARK),
      { kind: "ellipsoid", centre: [-2.5, -2.5, 9], radii: [5, 4.6, 3.4], material: MAPLE_LEAF },
      { kind: "ellipsoid", centre: [-7.5, 0.5, 7], radii: [3.6, 3.2, 2.6], material: MAPLE_LEAF },
      { kind: "ellipsoid", centre: [2, -6.5, 7], radii: [3.4, 3.2, 2.6], material: MAPLE_LEAF },
      { kind: "ellipsoid", centre: [-3.5, 3.5, 6], radii: [3.4, 3, 2.4], material: MAPLE_LEAF },
      { kind: "ellipsoid", centre: [1.5, 1, 6.5], radii: [2.6, 2.4, 2], material: MAPLE_LEAF },
    ],
  },
  {
    id: "jacaranda",
    name: "Jacaranda",
    w: 3,
    h: 3,
    base: { x: 2, y: 2 },
    solids: [
      // A wide, flat, open crown on a trunk that leans and forks, in flower.
      branch([0, 0, 0], [-1.5, -1, 8], 2.1, 1.2, BARK),
      branch([-1, -0.7, 5.5], [-6, 2, 8.5], 1, 0.5, BARK),
      branch([-1, -0.7, 6], [3, -5, 9], 1, 0.5, BARK),
      { kind: "ellipsoid", centre: [-4, -2, 10], radii: [6, 4.5, 2.4], material: BLOOM },
      { kind: "ellipsoid", centre: [3, -6, 9], radii: [3.6, 3, 2], material: BLOOM },
      { kind: "ellipsoid", centre: [-8, 3, 8], radii: [3.6, 3, 2], material: BLOOM },
      { kind: "ellipsoid", centre: [-1, 4, 8.5], radii: [3.2, 2.8, 1.8], material: BLOOM },
    ],
  },
  {
    id: "palm",
    name: "Palm",
    w: 3,
    h: 3,
    base: { x: 2, y: 2 },
    solids: [
      // A tall thin trunk and a ring of fronds: long flat ellipsoids, each
      // yawed to point its own way and hung a little below the crown's heart.
      trunk(0, 0, 12, 1.6, 1.2, PALM_BARK),
      { kind: "ellipsoid", centre: [-1, -1, 13], radii: [2.2, 2.2, 1.6], material: LEAF },
      ...[0, 1, 2, 3, 4, 5, 6].map((i): Solid => {
        const yaw = (i / 7) * Math.PI * 2 + 0.4;
        const reach = 5;
        return {
          kind: "ellipsoid",
          centre: [-1 + Math.cos(yaw) * reach, -1 + Math.sin(yaw) * reach, 12.2 - (i % 2) * 0.8],
          radii: [5.5, 1.5, 0.9],
          material: LEAF,
          yaw,
        };
      }),
    ],
  },
  {
    id: "cherry-blossom",
    name: "Cherry Blossom",
    w: 3,
    h: 3,
    base: { x: 2, y: 2 },
    solids: [
      // A low, wide, open crown of small lobes on a forked trunk.
      trunk(0, 0, 6, 2.2, 1.4, BARK),
      branch([0, 0, 4.5], [-5, 1, 7.5], 1, 0.5, BARK),
      branch([0, 0, 5], [2.5, -4.5, 7.5], 0.9, 0.5, BARK),
      { kind: "ellipsoid", centre: [-3, -2, 8], radii: [4.6, 4, 2.6], material: BLOSSOM },
      { kind: "ellipsoid", centre: [-8, 1, 6.5], radii: [3.4, 3, 2.2], material: BLOSSOM },
      { kind: "ellipsoid", centre: [2.5, -6, 7], radii: [3.2, 3, 2.2], material: BLOSSOM },
      { kind: "ellipsoid", centre: [-3, 4, 5.5], radii: [3, 2.8, 2], material: BLOSSOM },
      { kind: "ellipsoid", centre: [2, 1.5, 6], radii: [2.4, 2.2, 1.8], material: BLOSSOM },
    ],
  },
  {
    id: "dead-tree",
    name: "Dead Tree",
    w: 3,
    h: 3,
    base: { x: 2, y: 2 },
    solids: [
      // Bare: a trunk that flares at the foot and a spread of forking limbs.
      trunk(0, 0, 9, 2.6, 1.1, DEADWOOD),
      branch([0, 0, 4.5], [-5.5, -1.5, 9.5], 1.1, 0.5, DEADWOOD),
      branch([-3.5, -1, 7.5], [-6.5, 2.5, 10], 0.6, 0.35, DEADWOOD),
      branch([0, 0, 6], [4.5, -4, 11], 1, 0.45, DEADWOOD),
      branch([2.5, -2.5, 8.5], [6.5, -1, 10.5], 0.55, 0.3, DEADWOOD),
      branch([0, 0, 7.5], [-1.5, 4.5, 11.5], 0.9, 0.4, DEADWOOD),
      branch([0, 0, 9], [1.5, -1.5, 13.5], 1, 0.4, DEADWOOD),
      branch([0.8, -0.8, 11.5], [-2, -3, 14], 0.5, 0.3, DEADWOOD),
    ],
  },
];

// A columnar tree (a cypress, a poplar) was tried and dropped: a tall narrow
// ellipsoid projects to a long diagonal band and reads as a felled log.

/**
 * Towards the light: from above, the west and a little south. The camera sits
 * above and to the south-east, so a vertical trunk only ever shows its south
 * and east faces, and a light from the north-west — the sprite's top-left, where
 * the original tree's highlights are — would leave every trunk in shadow. From
 * here a crown's highlight still lands top-left, and a trunk keeps a lit side.
 */
const LIGHT: Vec3 = normalise([-0.6, 0.35, 0.75]);
const AMBIENT = 0.18;

/** Sub-samples per pixel per axis. Coverage decides alpha; shading is averaged. */
const SS = 4;

function normalise(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

type Hit = { t: number; normal: Vec3; material: Material };

/**
 * The surface a screen point sees. The line through it is `(sx + t, sy + t, t)`;
 * the visible surface is the intersection with the largest `t`.
 */
function trace(sx: number, sy: number, solids: Solid[]): Hit | null {
  let best: Hit | null = null;
  const consider = (t: number, normal: Vec3, material: Material) => {
    if (!best || t > best.t) best = { t, normal, material };
  };
  for (const s of solids) {
    if (s.kind === "ellipsoid") {
      // Rotate the line about z by -yaw, then scale it into the unit sphere's
      // space, and solve there. `yaw` is what lets a frond point somewhere.
      const [cx, cy, cz] = s.centre;
      const [rx, ry, rz] = s.radii;
      const cos = Math.cos(-(s.yaw ?? 0)), sin = Math.sin(-(s.yaw ?? 0));
      const lx = (sx - cx) * cos - (sy - cy) * sin, ly = (sx - cx) * sin + (sy - cy) * cos;
      const ldx = cos - sin, ldy = sin + cos;
      const ox = lx / rx, oy = ly / ry, oz = -cz / rz;
      const dx = ldx / rx, dy = ldy / ry, dz = 1 / rz;
      const a = dx * dx + dy * dy + dz * dz;
      const b = 2 * (ox * dx + oy * dy + oz * dz);
      const c = ox * ox + oy * oy + oz * oz - 1;
      const disc = b * b - 4 * a * c;
      if (disc < 0) continue;
      const t = (-b + Math.sqrt(disc)) / (2 * a);
      // Normal in the local frame, rotated back by +yaw.
      const nx = (lx + ldx * t) / (rx * rx), ny = (ly + ldy * t) / (ry * ry), nz = (t - cz) / (rz * rz);
      consider(t, normalise([nx * cos + ny * sin, -nx * sin + ny * cos, nz]), s.material);
    } else {
      // A tapered segment: the line against a cone frustum around the axis
      // `from -> to`, in the frame where the axis is `a` and everything else
      // is perpendicular to it. Radius grows linearly along the axis, so the
      // surface is `|perp|² = (r0 + q·s)²` with `s` the distance along it.
      const A = s.from, a = normalise([s.to[0] - A[0], s.to[1] - A[1], s.to[2] - A[2]]);
      const L = Math.hypot(s.to[0] - A[0], s.to[1] - A[1], s.to[2] - A[2]);
      const [r0, r1] = s.radius;
      const q = (r1 - r0) / L;
      const w: Vec3 = [sx - A[0], sy - A[1], -A[2]];
      const D: Vec3 = [1, 1, 1];
      const wa = w[0] * a[0] + w[1] * a[1] + w[2] * a[2];
      const Da = D[0] * a[0] + D[1] * a[1] + D[2] * a[2];
      const wp: Vec3 = [w[0] - wa * a[0], w[1] - wa * a[1], w[2] - wa * a[2]];
      const Dp: Vec3 = [D[0] - Da * a[0], D[1] - Da * a[1], D[2] - Da * a[2]];
      const m = r0 + q * wa, k = q * Da;
      const qa = Dp[0] * Dp[0] + Dp[1] * Dp[1] + Dp[2] * Dp[2] - k * k;
      const qb = 2 * (wp[0] * Dp[0] + wp[1] * Dp[1] + wp[2] * Dp[2]) - 2 * m * k;
      const qc = wp[0] * wp[0] + wp[1] * wp[1] + wp[2] * wp[2] - m * m;
      const roots: number[] = [];
      if (Math.abs(qa) < 1e-9) {
        // The line runs parallel to the surface's slope; one crossing at most.
        if (Math.abs(qb) > 1e-9) roots.push(-qc / qb);
      } else {
        const disc = qb * qb - 4 * qa * qc;
        if (disc >= 0) roots.push((-qb + Math.sqrt(disc)) / (2 * qa), (-qb - Math.sqrt(disc)) / (2 * qa));
      }
      for (const t of roots) {
        const along = wa + Da * t;
        if (along < 0 || along > L) continue;
        const r = r0 + q * along;
        if (r < 0) continue;
        const P: Vec3 = [sx + t, sy + t, t];
        const perp: Vec3 = [P[0] - A[0] - along * a[0], P[1] - A[1] - along * a[1], P[2] - A[2] - along * a[2]];
        consider(t, normalise([perp[0] - r * q * a[0], perp[1] - r * q * a[1], perp[2] - r * q * a[2]]), s.material);
      }
      // The far end's cap, for a flat-topped stump; the near end is never seen.
      if (r1 > 0 && Math.abs(Da) > 1e-9) {
        const t = (L - wa) / Da;
        const P: Vec3 = [sx + t, sy + t, t];
        const d: Vec3 = [P[0] - s.to[0], P[1] - s.to[1], P[2] - s.to[2]];
        if (d[0] * d[0] + d[1] * d[1] + d[2] * d[2] <= r1 * r1) consider(t, a, s.material);
      }
    }
  }
  return best;
}

/** `--debug <dir>` also writes each species' unquantised shading, scaled up. */
const DEBUG_DIR = (() => { const i = process.argv.indexOf("--debug"); return i >= 0 ? process.argv[i + 1] : null; })();

async function writeDebug(id: string, shades: (number | null)[][], name = "shade"): Promise<void> {
  if (!DEBUG_DIR) return;
  const S = 8, H = shades.length, W = shades[0]!.length;
  const png = new PNG({ width: W * S, height: H * S });
  for (let y = 0; y < H * S; y++) for (let x = 0; x < W * S; x++) {
    const v = shades[Math.floor(y / S)]![Math.floor(x / S)];
    const i = (y * png.width + x) * 4;
    const g = v === null ? 0x60 : Math.round(v * 255);
    png.data[i] = g; png.data[i + 1] = g; png.data[i + 2] = v === null ? 0x80 : g; png.data[i + 3] = 255;
  }
  await fs.writeFile(path.join(DEBUG_DIR, `${name}-${id}.png`), PNG.sync.write(png));
}

/** Deterministic per-pixel noise in [-1, 1], so a rerun paints the same dapple. */
function noise(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263 + salt * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) % 2001) / 1000 - 1;
}

type Pixel = { colour: string; material: Material; depth: number } | null;

async function renderSpecies(species: Species): Promise<Pixel[][]> {
  const W = species.w * CELL, H = species.h * CELL;
  // The foot stands at the centre of the base cell.
  const footX = species.base.x * CELL + CELL / 2;
  const footY = species.base.y * CELL + CELL / 2;
  const out: Pixel[][] = [];
  const shades: (number | null)[][] = [];
  for (let py = 0; py < H; py++) {
    const row: Pixel[] = [];
    const shadeRow: (number | null)[] = [];
    shades.push(shadeRow);
    for (let px = 0; px < W; px++) {
      let hits = 0, shade = 0, depth = 0;
      const byMaterial = new Map<Material, number>();
      for (let j = 0; j < SS; j++) {
        for (let i = 0; i < SS; i++) {
          const sx = px + (i + 0.5) / SS - footX;
          const sy = py + (j + 0.5) / SS - footY;
          const hit = trace(sx, sy, species.solids);
          if (!hit) continue;
          hits++;
          // The nearest sample, not the mean: a ledge averaged across a pixel
          // is a slope, and the crease pass would never see it.
          depth = Math.max(depth, hit.t);
          const dot = hit.normal[0] * LIGHT[0] + hit.normal[1] * LIGHT[1] + hit.normal[2] * LIGHT[2];
          const lambert = hit.material.wrap ? dot / 2 + 0.5 : Math.max(0, dot);
          shade += AMBIENT + (1 - AMBIENT) * lambert;
          byMaterial.set(hit.material, (byMaterial.get(hit.material) ?? 0) + 1);
        }
      }
      if (hits * 2 < SS * SS) { row.push(null); shadeRow.push(null); continue; }
      shadeRow.push(shade / hits);
      let material: Material = LEAF, most = 0;
      for (const [m, n] of byMaterial) if (n > most) { most = n; material = m; }
      const intensity = shade / hits + material.dapple * noise(px, py, species.id.length);
      let step = 0;
      while (step < material.steps.length && intensity > material.steps[step]!) step++;
      row.push({ colour: material.ramp[step]!, material, depth });
    }
    out.push(row);
  }
  outline(out);
  await writeDebug(species.id, shades);
  await writeDebug(species.id, out.map((r) => r.map((p) => (p ? Math.min(1, p.depth / 20) : null))), "depth");
  return out;
}

/**
 * The original tree's outline: the crown's own dark green where the edge faces
 * the light, `#2e222f` along the lower-right edge where it is the tree's own
 * shadow, and `#2e222f` around the trunk. Bark keeps its lit side clear, or a
 * trunk three pixels wide would be nothing but outline.
 *
 * A crease is the same line drawn inside the silhouette: wherever the depth
 * jumps towards the camera between this pixel and a neighbour, this pixel is
 * the surface the nearer one overlaps, and it takes the outline colour. That
 * is what separates one lobe of a crown from the next and one tier of a pine
 * from the one below, and it is why the models can be plain overlapping solids.
 *
 * A jump, not a slope: along a trunk the depth changes by about a pixel per
 * pixel and that is a wall, not an edge. The test is therefore on the second
 * difference — how much the step to one neighbour exceeds the step from the
 * other — which is zero across a flat wall, small across a curve, and the
 * height of the ledge at a ledge.
 */
const CREASE_DEPTH = 0.6;

/** Below this height a surface counts as touching the ground. */
const GROUND_DEPTH = 2.5;

function creased(p: NonNullable<Pixel>, a: Pixel, b: Pixel): boolean {
  if (!a) return false;
  const step = a.depth - p.depth;
  const expected = b ? p.depth - b.depth : 0;
  return step - expected > CREASE_DEPTH;
}

function outline(px: Pixel[][]): void {
  const H = px.length, W = px[0]!.length;
  const at = (x: number, y: number) => (y < 0 || y >= H || x < 0 || x >= W ? null : px[y]![x]);
  const edits: [number, number, string][] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = at(x, y);
      if (!p) continue;
      const around = [at(x + 1, y), at(x, y + 1), at(x - 1, y), at(x, y - 1)];
      const [right, down, left, up] = around;
      const bark = p.material.outline === C.outline;
      // A silhouette edge that meets the ground is not an edge: the trunk
      // continues into the floor tile, and a dark line there is a gap.
      const grounded = p.depth < GROUND_DEPTH;
      // A trunk is a diagonal band three pixels wide; outlining its lower edge
      // as well as its right one would leave a single column of bark. A twig
      // one pixel wide has no bark to its left, and keeps its colour.
      const twig = bark && !left;
      if ((!right || (!down && !bark)) && !grounded && !twig) edits.push([x, y, C.outline]);
      else if (creased(p, right, left) || creased(p, left, right) || creased(p, down, up) || creased(p, up, down)) {
        edits.push([x, y, p.material.outline]);
      }
      else if ((!left || !up) && !bark) edits.push([x, y, p.material.outline]);
    }
  }
  for (const [x, y, colour] of edits) px[y]![x] = { ...px[y]![x]!, colour };
}

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

async function main() {
  const palette = new Set(STAPES_PALETTE);
  for (const c of Object.values(C)) if (!palette.has(c)) throw new Error(`${c} is not in STAPES_PALETTE`);

  const sheet = PNG.sync.read(await fs.readFile(SHEET));
  const tiles = JSON.parse(await fs.readFile(TILES, "utf8")) as any[];
  const template = tiles.find((t) => t.id === "tree");
  if (!template) throw new Error("data/tiles.json has no tree to model the new species on");

  // Everything from the reserved row down is regenerated; clear it first so a
  // species that shrank leaves no stray pixels behind.
  for (let y = SHEET_ROW * CELL; y < sheet.height; y++) {
    for (let x = 0; x < sheet.width; x++) sheet.data.fill(0, (y * sheet.width + x) * 4, (y * sheet.width + x) * 4 + 4);
  }

  // Laid out left to right from SHEET_ROW, wrapping to a new row of cells when
  // the next species would run off the sheet's right edge.
  let cx = 0, cy = SHEET_ROW, rowH = 0;
  for (const species of SPECIES) {
    const pixels = await renderSpecies(species);
    if ((cx + species.w) * CELL > sheet.width) { cx = 0; cy += rowH; rowH = 0; }
    const ox = cx * CELL, oy = cy * CELL;
    if (oy + species.h * CELL > sheet.height) {
      throw new Error(`${species.id} does not fit on the sheet at cell (${cx},${cy})`);
    }
    for (let y = 0; y < pixels.length; y++) {
      for (let x = 0; x < pixels[y]!.length; x++) {
        const p = pixels[y]![x];
        if (!p) continue;
        const i = ((oy + y) * sheet.width + ox + x) * 4;
        const [r, g, b] = hexToRgb(p.colour);
        sheet.data[i] = r; sheet.data[i + 1] = g; sheet.data[i + 2] = b; sheet.data[i + 3] = 255;
      }
    }

    const def = {
      id: species.id,
      name: species.name,
      height: template.height,
      type: "simple",
      kind: "prop",
      attributes: {},
      anchor: { tilesetId: TILESET_ID, x: cx, y: cy },
      walkable: false,
      sprite: {
        frames: [
          {
            sprite: { rect: { x: 0, y: 0, w: species.w, h: species.h }, base: species.base },
            durationMs: template.sprite.frames[0].durationMs,
          },
        ],
      },
    };
    const existing = tiles.findIndex((t) => t.id === species.id);
    if (existing >= 0) tiles[existing] = { ...tiles[existing], ...def };
    else tiles.splice(tiles.findIndex((t) => t.id === "tree") + 1 + SPECIES.indexOf(species), 0, def);

    console.log(`Rendered ${species.id} at cell (${cx},${cy}), ${species.w}x${species.h}`);
    cx += species.w;
    rowH = Math.max(rowH, species.h);
  }

  await fs.writeFile(SHEET, PNG.sync.write(sheet));
  await fs.writeFile(TILES, JSON.stringify(tiles, null, 2) + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
