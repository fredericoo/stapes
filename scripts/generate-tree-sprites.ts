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
 * reserved for them and upserts their entries in `data/tiles.json`. `tree`
 * itself is one of them now: its first face is the hand-drawn original
 * rebuilt as a model, and the pixels of that original are still on the sheet
 * at cell (2,6), unreferenced.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { STAPES_PALETTE } from "../app/lib/palette";

const ROOT = path.resolve(import.meta.dirname, "..");
const SHEET = path.join(ROOT, "data", "tilesets", "tiny-ranch-tiles.png");
const TILES = path.join(ROOT, "data", "tiles.json");
const TILESETS = path.join(ROOT, "data", "tilesets.json");
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
 * its silhouette where it is lit, and how densely it is speckled. Leaves are
 * speckled a lot — the dapple is what makes a crown a crown — and bark barely.
 */
type Material = {
  ramp: readonly string[];
  /** Ramp thresholds on lambert intensity, one fewer than ramp entries. */
  steps: readonly number[];
  outline: string;
  /**
   * Speckle density, 0..1: the share of pixels pushed a step down the ramp
   * (a leaf in shadow) and, where lit, a step up (a leaf catching the light).
   */
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

/**
 * Leaves are wrapped like bark, so the side of a crown that faces away from
 * the light lands on the mid entry rather than the dark one; the dark entry
 * is then the speckle and the outline, which is how the hand-drawn tree uses
 * it. Under plain Lambert a clumped crown — facets pointing every way, most of
 * the visible ones away from the light — came out almost entirely dark.
 */
const LEAF: Material = {
  ramp: [C.leafDark, C.leafMid, C.leafLight],
  // The light entry is for the facets that face the light squarely; the
  // hand-drawn tree is a sixth light, a third mid and a third dark.
  steps: [0.4, 0.86],
  outline: C.leafDark,
  dapple: 0.45,
  wrap: true,
};

/** The small tree's leaves: the same ramp, dappled harder, since at 16px a crown is few pixels. */
const TREE_LEAF: Material = { ...LEAF, dapple: 0.65 };

/** Birch leaves: the same ramp shifted one step lighter, with a lime top. */
const BIRCH_LEAF: Material = {
  ramp: [C.leafMid, C.leafLight, C.leafPale, C.leafLime],
  steps: [0.42, 0.74, 0.92],
  outline: C.leafDark,
  dapple: 0.45,
  wrap: true,
};

/** Needles: darker than broadleaf, and dappled harder, since a tier is otherwise one flat slope. */
const NEEDLE: Material = {
  ramp: [C.leafDark, C.leafMid, C.leafLight],
  steps: [0.42, 0.82],
  outline: C.leafDark,
  dapple: 0.3,
  wrap: true,
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
  steps: [0.42, 0.74, 0.92],
  outline: C.mapleDark,
  dapple: 0.42,
  wrap: true,
};

/** Jacaranda in flower: violet through lilac, dappled like leaves. */
const BLOOM: Material = {
  ramp: [C.bloomDark, C.bloomMid, C.bloomLight],
  steps: [0.42, 0.82],
  outline: C.bloomDark,
  dapple: 0.42,
  wrap: true,
};

/** Cherry in blossom: mauve shadow, pink, and a pale highlight. */
const BLOSSOM: Material = {
  ramp: [C.cherryDark, C.cherryMid, C.cherryLight],
  steps: [0.44, 0.88],
  outline: C.cherryDark,
  dapple: 0.42,
  wrap: true,
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
   * An ellipsoid whose surface is pushed in and out by smooth 3D noise:
   * `amp` is the displacement as a fraction of the radius, `freq` the
   * number of noise cells across a radius. A crown lobe. Its silhouette and
   * shading are irregular everywhere by construction, which a smooth
   * ellipsoid with clumps on it never quite managed: whatever the clumps
   * missed came out as a straight run, and the straight run read as a cut.
   */
  | { kind: "blob"; centre: Vec3; radii: Vec3; material: Material; yaw?: number; amp: number; freq: number; seed: number }
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

/** A crown lobe: an ellipsoid of leaves at `centre`. */
function lobe(centre: Vec3, radii: Vec3, material: Material): Solid {
  return { kind: "ellipsoid", centre, radii, material };
}

/**
 * A lobe with leaf clumps on it: the lobe, plus `count` small ellipsoids set
 * just under its surface on the side the camera and the light see. A smooth
 * ellipsoid shades as one gradient and reads as a balloon; the clumps give the
 * silhouette its lumps and the crease pass its lines, which is what the
 * hand-drawn tree has. Placement is seeded so a rerun paints the same tree.
 */
/**
 * Advanced by the generator when a face fails the straight-run check, and
 * read by `leafy` when the face is rebuilt: the clump seeds and the lobe's
 * yaw move on, the model does not. Deterministic, so a rerun paints the
 * same tree.
 */
let variation = 0;

function leafy(centre: Vec3, radii: Vec3, material: Material, count = 7, seed = 1, yaw = 0): Solid[] {
  seed += variation * 1013;
  yaw += variation * 0.37;
  // The lobe is a noise-displaced blob, yawed and a little longer one way
  // than the other. A round lobe projects to an ellipse whose axes lie
  // exactly on the 45° diagonal, and its flanks come out as clean 1:1
  // stair-steps that read as a cut; tilted off the diagonal and dented by
  // noise, no part of the edge runs straight.
  const rx = radii[0] * 1.1, ry = radii[1] * 0.92, rz = radii[2];
  // The dent has to be more than a pixel or it quantises away, and these
  // lobes are three to five pixels in radius, so it is a large fraction of
  // one: sized for about a pixel and a half whatever the lobe.
  const amp = Math.max(0.25, Math.min(0.5, 1.4 / Math.min(rx, ry, rz)));
  const out: Solid[] = [{ kind: "blob", centre, radii: [rx, ry, rz], material, yaw, amp, freq: 2.8, seed }];
  let state = (seed * 2654435761 + centre[0] * 97 + centre[1] * 89 + centre[2] * 83) >>> 0;
  const rand = () => { state = (Math.imul(state ^ (state >>> 15), 2246822519) + 1) >>> 0; return state / 4294967296; };
  const clump = Math.max(1.1, Math.min(radii[0], radii[1]) * 0.42);
  for (let i = 0; i < count; i++) {
    // Spaced round the lobe's equator by the golden angle, with a little
    // jitter, and only a little above or below it. The silhouette is the
    // equator: an ellipsoid projects to an ellipse stretched along the
    // diagonal whose long flanks are almost straight 45° lines, and clumps
    // sitting high on the lobe or bunched on the camera's side leave those
    // flanks smooth, where they read as a cut.
    // The first two clumps sit on the north-east and south-west of the
    // equator, which is where the projected ellipse's two long flanks come
    // from — the silhouette of a sphere along the view line is a great circle
    // through exactly those points — and the rest go round by the golden
    // angle. Spread by angle alone, those two flanks were missed one time in
    // three and came out as straight 45° runs.
    // On the lobe's own surface: the angle is in the lobe's frame, then
    // scaled by its true radii and rotated by its yaw. Placing clumps on the
    // unstretched, unrotated sphere buried the ones along the long axis.
    const flank = i === 0 ? -Math.PI / 4 : i === 1 ? (3 * Math.PI) / 4 : null;
    let theta = flank !== null ? flank - yaw + (rand() - 0.5) * 0.5 : i * 2.399963 + (rand() - 0.5) * 0.7;
    // Never on the south-east: that is the quadrant that hangs over the
    // trunk on screen, and a clump there is what buries the foot.
    const world = ((theta + yaw) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    if (Math.abs(world - Math.PI / 4) < 0.75) theta += Math.PI;
    // Spread in height too. A ring of clumps all at one height lines their
    // bottoms up on one screen row, and the crown's underside comes out flat.
    const lift = flank !== null ? (rand() - 0.5) * 0.6 : rand() * 1.5 - 0.6;
    const flat = Math.sqrt(Math.max(0, 1 - lift * lift));
    const lx = Math.cos(theta) * flat * rx * 0.95, ly = Math.sin(theta) * flat * ry * 0.95;
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    out.push(lobe(
      [centre[0] + lx * cos - ly * sin, centre[1] + lx * sin + ly * cos, centre[2] + lift * rz * 0.95],
      [clump, clump, clump * 0.85],
      material,
    ));
  }
  return out;
}

/**
 * One face of a species: its model, and the rect it is drawn in when that
 * differs from the species' default. A tall variant of a small tree needs a
 * taller rect than its siblings, and a scatter tile's faces may each have
 * their own.
 */
type Face = { w: number; h: number; base: { x: number; y: number }; build: () => Solid[] };

/** A face on its own rect, the trunk foot in the bottom-right cell. */
function face(w: number, h: number, build: () => Solid[]): Face {
  return { w, h, base: { x: w - 1, y: h - 1 }, build };
}

/**
 * The same model moved sideways: the trunk foot lands `dx, dy` from the
 * centre of its cell. Every face of a species standing on exactly the same
 * spot lines the trunks of a wood up into a grid, which is the first thing
 * that reads as mechanical.
 */
function shift(solids: Solid[], dx: number, dy: number): Solid[] {
  return solids.map((s) => {
    if (s.kind === "segment") {
      return { ...s, from: [s.from[0] + dx, s.from[1] + dy, s.from[2]] as Vec3, to: [s.to[0] + dx, s.to[1] + dy, s.to[2]] as Vec3 };
    }
    return { ...s, centre: [s.centre[0] + dx, s.centre[1] + dy, s.centre[2]] as Vec3 };
  });
}

type Species = {
  id: string;
  name: string;
  /** Size of a face in cells, unless the face says otherwise. */
  w: number;
  h: number;
  /** Where the trunk stands, as a cell within the rect. */
  base: { x: number; y: number };
  /**
   * One model per face, in world pixels, with the trunk foot at the origin and
   * z up. One face is a `simple` tile; more make a `scatter` tile, and every
   * placement wears the face its coordinates hash to, so a wood of one tile
   * never repeats a run. A builder rather than a list, because a face that
   * fails the straight-run check is rebuilt with `variation` advanced.
   */
  faces: (Face | (() => Solid[]))[];
  /** Straight edges on the leaves are meant: a palm's fronds are straight. */
  straightLeaves?: boolean;
};

/**
 * The models. World units are pixels, so a cell is 8 across; z is height in
 * pixels, so a whole level is 8 and `height: 4` props top out around there.
 * The trunk foot is the origin and sits at the centre of the base cell.
 */
const SPECIES: Species[] = [
  {
    id: "tree",
    name: "Tree",
    w: 2,
    h: 2,
    base: { x: 1, y: 1 },
    faces: [
      // The first face is the hand-drawn original rebuilt as a model: one
      // round crown about six pixels up, a stubby trunk. The rest vary it —
      // leaning, bushier, younger — so a stand of `tree` reads as several.
      // Four small faces on 2×2 and four tall on 3×3, from a sapling to a
      // two-headed tree twice its height, each standing a pixel or two off
      // its cell's centre. One size class and one crown height, with every
      // trunk on the same spot, read as a mechanical repeat however varied
      // the crowns were.
      //
      // Small crowns held high: on a 2×2 rect a crown much wider than this
      // cannot sit high enough to clear its own foot on screen, and its
      // south-east tip buries the trunk.
      () => [trunk(0, 0, 4.5, 1.7, 1.3, BARK), ...leafy([-0.3, -0.3, 5.8], [3.4, 3.2, 2.9], TREE_LEAF, 8, 1, 0.5)],
      () => shift([
        trunk(0, 0, 4.5, 1.7, 1.3, BARK),
        ...leafy([-0.6, 1, 5], [3, 2.8, 2.5], TREE_LEAF, 6, 2, -0.6),
        ...leafy([1.4, -1.2, 5.4], [2.7, 2.5, 2.3], TREE_LEAF, 5, 3, 0.9),
      ], -1, 0.5),
      () => shift([
        // Low and bushy.
        trunk(0, 0, 3.2, 1.8, 1.3, BARK),
        ...leafy([-0.2, -0.2, 4.4], [3.6, 3.3, 2.5], TREE_LEAF, 8, 8, 0.6),
        ...leafy([-2.4, 2, 3.6], [2.2, 2, 1.7], TREE_LEAF, 4, 9, -0.3),
      ], 1, -0.8),
      () => shift([
        // A sapling.
        trunk(0, 0, 3.6, 1.2, 0.9, BARK),
        ...leafy([-0.4, -0.2, 4.6], [2.4, 2.3, 2.1], TREE_LEAF, 6, 6, 0.4),
      ], -1.2, 1),
      face(3, 3, () => shift([
        // Tall.
        trunk(0, 0, 8, 2, 1.3, BARK),
        ...leafy([-0.5, -0.5, 9.5], [3.8, 3.6, 3.2], TREE_LEAF, 8, 31, -0.4),
      ], 0.5, 0.5)),
      face(3, 3, () => shift([
        // Tall and two-headed, with a limb.
        trunk(0, 0, 8.5, 2, 1.2, BARK),
        branch([0, 0, 5.5], [3.5, -1.5, 8], 0.9, 0.5, BARK),
        ...leafy([-1.5, 1, 7.8], [3, 2.8, 2.6], TREE_LEAF, 6, 32, 0.7),
        ...leafy([1.8, -2.2, 10], [2.8, 2.6, 2.4], TREE_LEAF, 6, 33, -0.5),
      ], -1, -0.5)),
      face(3, 3, () => shift([
        // Wide, two lobes side by side, middling height.
        trunk(0, 0, 6, 2.1, 1.4, BARK),
        ...leafy([-3, 0.5, 6.8], [3.2, 3, 2.6], TREE_LEAF, 6, 34, -0.6),
        ...leafy([1.5, -3.2, 7.4], [3, 2.8, 2.5], TREE_LEAF, 6, 35, 0.8),
      ], 1.2, 0.8)),
      face(3, 3, () => shift([
        // Leaning, tall, with a bare limb showing under the crown.
        branch([0, 0, 0], [-1.6, 1.2, 8.5], 1.7, 1.1, BARK),
        branch([-0.8, 0.6, 5], [-4.5, 3.5, 7.5], 0.8, 0.45, BARK),
        ...leafy([-2.2, 1.4, 9.6], [3.4, 3.2, 2.9], TREE_LEAF, 8, 36, 0.3),
      ], -0.5, -1)),
    ],
  },
  {
    id: "oak",
    name: "English Oak",
    w: 3,
    h: 3,
    base: { x: 2, y: 2 },
    faces: [() => [
      // The crown sits north-west of the trunk as well as above it, so its
      // south-east lobes clear the foot on screen and the trunk stays visible.
      trunk(0, 0, 10, 2.6, 1.7, BARK),
      branch([0, 0, 7], [6, -2, 9.5], 1.1, 0.5, BARK),
      branch([0, 0, 6], [2, 6, 9], 1, 0.5, BARK),
      { kind: "ellipsoid", centre: [-2, -2, 10.5], radii: [5.5, 5, 3.6], material: LEAF },
      { kind: "ellipsoid", centre: [-5.5, 0.5, 7.5], radii: [4, 3.8, 3], material: LEAF },
      { kind: "ellipsoid", centre: [2.5, -6, 8.5], radii: [4, 3.8, 3], material: LEAF },
      { kind: "ellipsoid", centre: [-4.5, 4, 8], radii: [3.8, 3.4, 2.8], material: LEAF },
      { kind: "ellipsoid", centre: [1, 1, 10], radii: [2.8, 2.6, 2.2], material: LEAF },
    ]],
  },
  {
    id: "silver-birch",
    name: "Silver Birch",
    w: 3,
    h: 3,
    base: { x: 2, y: 2 },
    faces: [() => [
      trunk(0, 0, 10, 1.9, 1.2, BIRCH_BARK),
      { kind: "ellipsoid", centre: [-0.5, -0.5, 12], radii: [4, 3.8, 3.8], material: BIRCH_LEAF },
      { kind: "ellipsoid", centre: [-4, 2, 9.5], radii: [2.8, 2.8, 2.6], material: BIRCH_LEAF },
      { kind: "ellipsoid", centre: [3, -3.5, 10], radii: [2.6, 2.6, 2.4], material: BIRCH_LEAF },
    ]],
  },
  {
    id: "scots-pine",
    name: "Scots Pine",
    w: 3,
    h: 3,
    base: { x: 2, y: 2 },
    faces: [() => [
      // Tiers shallower than the camera's 35° elevation, so each one's base
      // stands proud of the one above in depth and the crease pass draws it.
      // Steeper cones nest into one smooth hull and the tree reads as a
      // single teardrop.
      trunk(0, 0, 13, 2.4, 1.4, PINE_BARK),
      tier(6.5, 4, 7.5, NEEDLE),
      tier(5.2, 7.5, 11.5, NEEDLE),
      tier(3.8, 12, 16, NEEDLE),
    ]],
  },
  {
    id: "autumn-maple",
    name: "Autumn Maple",
    w: 3,
    h: 3,
    base: { x: 2, y: 2 },
    faces: [() => [
      // A dome of small lobes on a short forked trunk, in the palette's reds.
      trunk(0, 0, 6, 2.2, 1.4, BARK),
      branch([0, 0, 5], [-4, -1, 8.5], 1, 0.5, BARK),
      branch([0, 0, 5], [3, -3, 8], 0.9, 0.5, BARK),
      ...leafy([-2.5, -2.5, 9], [5, 4.6, 3.4], MAPLE_LEAF, 6, 17, -0.35),
      ...leafy([-4.5, 0.5, 6.5], [3.6, 3.2, 2.6], MAPLE_LEAF, 3, 12, -0.6),
      ...leafy([2, -6.5, 7], [3.4, 3.2, 2.6], MAPLE_LEAF, 3, 13, 0.8),
      ...leafy([-3.5, 3.5, 6], [3.4, 3, 2.4], MAPLE_LEAF, 5, 16, -0.4),
      ...leafy([1.5, 1, 6.5], [2.6, 2.4, 2], MAPLE_LEAF, 2, 15, 0.6),
    ]],
  },
  {
    id: "jacaranda",
    name: "Jacaranda",
    w: 3,
    h: 3,
    base: { x: 2, y: 2 },
    faces: [() => [
      // A wide, flat, open crown on a trunk that leans and forks, in flower.
      branch([0, 0, 0], [-1.5, -1, 8], 2.1, 1.2, BARK),
      branch([-1, -0.7, 5.5], [-6, 2, 8.5], 1, 0.5, BARK),
      branch([-1, -0.7, 6], [3, -5, 9], 1, 0.5, BARK),
      ...leafy([-2, -1.5, 9], [5, 4.3, 2.6], BLOOM, 6, 27, -0.4),
      ...leafy([3, -5.5, 8.5], [3.4, 3, 2.2], BLOOM, 3, 28, 0.5),
      ...leafy([-4.8, 3, 7], [3.2, 3, 2.2], BLOOM, 3, 29, -0.7),
      ...leafy([-1, 4, 8.5], [3, 2.8, 2], BLOOM, 3, 30, 0.3),
    ]],
  },
  {
    id: "palm",
    name: "Palm",
    straightLeaves: true,
    // A cell wider than the others: the fronds reach further sideways than
    // any crown, and a fourth row is not available on the sheet.
    w: 4,
    h: 3,
    base: { x: 3, y: 2 },
    faces: [() => [
      // A tall thin trunk and a ring of fronds: long flat ellipsoids, each
      // yawed to point its own way and hung a little below the crown's heart.
      trunk(0, 0, 9, 1.6, 1.2, PALM_BARK),
      { kind: "ellipsoid", centre: [-0.5, -0.5, 10], radii: [2.2, 2.2, 1.6], material: LEAF },
      ...[0, 1, 2, 3, 4, 5, 6].map((i): Solid => {
        const yaw = (i / 7) * Math.PI * 2 + 0.4;
        const reach = 4;
        return {
          kind: "ellipsoid",
          centre: [-0.5 + Math.cos(yaw) * reach, -0.5 + Math.sin(yaw) * reach, 9.3 - (i % 2) * 0.8],
          radii: [5.6, 1.5, 0.9],
          material: LEAF,
          yaw,
        };
      }),
    ]],
  },
  {
    id: "cherry-blossom",
    name: "Cherry Blossom",
    w: 3,
    h: 3,
    base: { x: 2, y: 2 },
    faces: [() => [
      // A low, wide, open crown of small lobes on a forked trunk.
      trunk(0, 0, 6, 2.2, 1.4, BARK),
      branch([0, 0, 4.5], [-5, 1, 7.5], 1, 0.5, BARK),
      branch([0, 0, 5], [2.5, -4.5, 7.5], 0.9, 0.5, BARK),
      { kind: "ellipsoid", centre: [-3, -2, 8], radii: [4.6, 4, 2.6], material: BLOSSOM },
      { kind: "ellipsoid", centre: [-8, 1, 6.5], radii: [3.4, 3, 2.2], material: BLOSSOM },
      { kind: "ellipsoid", centre: [2.5, -6, 7], radii: [3.2, 3, 2.2], material: BLOSSOM },
      { kind: "ellipsoid", centre: [-3, 4, 5.5], radii: [3, 2.8, 2], material: BLOSSOM },
      { kind: "ellipsoid", centre: [2, 1.5, 6], radii: [2.4, 2.2, 1.8], material: BLOSSOM },
    ]],
  },
  {
    id: "dead-tree",
    name: "Dead Tree",
    w: 3,
    h: 3,
    base: { x: 2, y: 2 },
    faces: [() => [
      // Bare: a trunk that flares at the foot and a spread of forking limbs.
      trunk(0, 0, 9, 2.6, 1.1, DEADWOOD),
      branch([0, 0, 4.5], [-5.5, -1.5, 9.5], 1.1, 0.5, DEADWOOD),
      branch([-3.5, -1, 7.5], [-6.5, 2.5, 10], 0.6, 0.35, DEADWOOD),
      branch([0, 0, 6], [4.5, -4, 11], 1, 0.45, DEADWOOD),
      branch([2.5, -2.5, 8.5], [6.5, -1, 10.5], 0.55, 0.3, DEADWOOD),
      branch([0, 0, 7.5], [-1.5, 4.5, 11.5], 0.9, 0.4, DEADWOOD),
      branch([0, 0, 9], [1.5, -1.5, 13.5], 1, 0.4, DEADWOOD),
      branch([0.8, -0.8, 11.5], [-2, -3, 14], 0.5, 0.3, DEADWOOD),
    ]],
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

/** Smooth 3D value noise in [-1, 1], two octaves, seeded. */
function noise3(x: number, y: number, z: number, seed: number): number {
  const lattice = (ix: number, iy: number, iz: number) => {
    let h = (ix * 374761393 + iy * 668265263 + iz * 2147483647 + seed * 1274126177) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return ((h >>> 0) % 65536) / 32768 - 1;
  };
  const octave = (x: number, y: number, z: number) => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = x - ix, fy = y - iy, fz = z - iz;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    return lerp(
      lerp(lerp(lattice(ix, iy, iz), lattice(ix + 1, iy, iz), sx), lerp(lattice(ix, iy + 1, iz), lattice(ix + 1, iy + 1, iz), sx), sy),
      lerp(lerp(lattice(ix, iy, iz + 1), lattice(ix + 1, iy, iz + 1), sx), lerp(lattice(ix, iy + 1, iz + 1), lattice(ix + 1, iy + 1, iz + 1), sx), sy),
      sz,
    );
  };
  return (octave(x, y, z) + 0.5 * octave(x * 2.1 + 7.3, y * 2.1 + 1.9, z * 2.1 + 4.7)) / 1.5;
}

/**
 * The blob's surface function in its unit-sphere frame: negative inside.
 * The noise is sampled in that frame too, so it stretches with the lobe.
 */
function blobField(s: Extract<Solid, { kind: "blob" }>, x: number, y: number, z: number): number {
  const r = Math.hypot(x, y, z);
  if (r === 0) return -1;
  return r - 1 - s.amp * noise3((x / r) * s.freq, (y / r) * s.freq, (z / r) * s.freq, s.seed);
}

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
    } else if (s.kind === "blob") {
      // Same frame as the ellipsoid; then, because the noise makes the
      // surface non-analytic, march down the line from the far end of the
      // bounding ellipsoid (radius 1 + amp) until the field goes negative,
      // and bisect. Sprites are tiny, so the cost is nothing.
      const [cx, cy, cz] = s.centre;
      const [rx, ry, rz] = s.radii;
      const cos = Math.cos(-(s.yaw ?? 0)), sin = Math.sin(-(s.yaw ?? 0));
      const lx = (sx - cx) * cos - (sy - cy) * sin, ly = (sx - cx) * sin + (sy - cy) * cos;
      const ldx = cos - sin, ldy = sin + cos;
      const ox = lx / rx, oy = ly / ry, oz = -cz / rz;
      const dx = ldx / rx, dy = ldy / ry, dz = 1 / rz;
      const bound = 1 + s.amp;
      const a = dx * dx + dy * dy + dz * dz;
      const b = 2 * (ox * dx + oy * dy + oz * dz);
      const c = ox * ox + oy * oy + oz * oz - bound * bound;
      const disc = b * b - 4 * a * c;
      if (disc < 0) continue;
      const tHi = (-b + Math.sqrt(disc)) / (2 * a), tLo = (-b - Math.sqrt(disc)) / (2 * a);
      const f = (t: number) => blobField(s, ox + dx * t, oy + dy * t, oz + dz * t);
      const steps = 48;
      let hit: number | null = null;
      let prev = tHi, prevF = f(tHi);
      for (let i = 1; i <= steps; i++) {
        const t = tHi + ((tLo - tHi) * i) / steps;
        const ft = f(t);
        if (ft <= 0) {
          // Bisect between the last outside sample and this inside one.
          let hi = prev, lo = t;
          for (let k = 0; k < 6; k++) { const m = (hi + lo) / 2; if (f(m) <= 0) lo = m; else hi = m; }
          hit = lo;
          break;
        }
        prev = t; prevF = ft;
      }
      void prevF;
      if (hit === null) continue;
      // Normal from the field's gradient in the local frame, mapped back to
      // world the way the ellipsoid's is.
      const px = ox + dx * hit, py = oy + dy * hit, pz = oz + dz * hit, e = 0.02;
      const gx = (blobField(s, px + e, py, pz) - blobField(s, px - e, py, pz)) / rx;
      const gy = (blobField(s, px, py + e, pz) - blobField(s, px, py - e, pz)) / ry;
      const gz = (blobField(s, px, py, pz + e) - blobField(s, px, py, pz - e)) / rz;
      consider(hit, normalise([gx * cos + gy * sin, -gx * sin + gy * cos, gz]), s.material);
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

async function renderFace(species: Species, solids: Solid[], face: number, rect: Face): Promise<Pixel[][]> {
  const W = rect.w * CELL, H = rect.h * CELL;
  // The foot stands at the centre of the base cell.
  const footX = rect.base.x * CELL + CELL / 2;
  const footY = rect.base.y * CELL + CELL / 2;
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
          const hit = trace(sx, sy, solids);
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
      const intensity = shade / hits;
      let step = 0;
      while (step < material.steps.length && intensity > material.steps[step]!) step++;
      // Dapple as two speckle layers, the way the hand-drawn tree is drawn:
      // dark pixels scattered through the whole crown, where leaves overlap
      // and gaps show, and light pixels scattered where the light reaches.
      // Jittering the intensity instead can only ever move a lit pixel one
      // step down, so a lit crown never gets a dark speckle and reads flat.
      const salt = species.id.length + face * 31;
      const dark = (noise(px, py, salt) + 1) / 2, light = (noise(px, py, salt + 7) + 1) / 2;
      const lit = Math.max(0, Math.min(1, (intensity - 0.4) / 0.5));
      // Denser dark speckles on the shaded side and denser light ones on the
      // lit side: the gradient is dithered rather than banded, which is how
      // the hand-drawn crown carries its shadow while staying mid-green.
      const shadow = 1 - lit;
      if (dark < material.dapple * (0.06 + 0.1 * shadow)) step -= 2;
      else if (dark < material.dapple * (0.3 + 0.3 * shadow)) step -= 1;
      else if (light < material.dapple * 0.5 * lit) step += 1;
      step = Math.max(0, Math.min(material.ramp.length - 1, step));
      row.push({ colour: material.ramp[step]!, material, depth });
    }
    out.push(row);
  }
  outline(out);
  const tag = species.faces.length > 1 ? `${species.id}-${face}` : species.id;
  await writeDebug(tag, shades);
  await writeDebug(tag, out.map((r) => r.map((p) => (p ? Math.min(1, p.depth / 20) : null))), "depth");
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

/**
 * A crown silhouette running straight this long reads as a cut: five along a
 * diagonal, where a projected ellipse's flank makes a clean stair, and seven
 * along an axis, which is looser because the hand-drawn tree's own underside
 * runs flat for five.
 */
const STRAIGHT_DIAGONAL = 5;
const STRAIGHT_AXIS = 7;

/** How many variations of a face's clumps and yaws to try before giving up. */
const VARIATIONS = 12;

/**
 * The longest run of silhouette pixels along either diagonal, with the
 * transparent side kept on one hand throughout — the stair-step a projected
 * ellipse's flank makes. Only pixels `counts` accepts are looked at.
 */
function longestStraightRun(px: Pixel[][], counts: (p: NonNullable<Pixel>) => boolean, diagonal: boolean): number {
  const H = px.length, W = px[0]!.length;
  const at = (x: number, y: number) => (y < 0 || y >= H || x < 0 || x >= W ? null : px[y]![x]);
  let longest = 0;
  // Each direction with the two sides that can be the open one.
  const shapes: [number, number, number, number][] = diagonal
    ? [[1, 1, 1, 0], [1, 1, 0, 1], [1, -1, 1, 0], [1, -1, 0, -1]]
    : [[1, 0, 0, -1], [1, 0, 0, 1], [0, 1, -1, 0], [0, 1, 1, 0]];
  for (const [dx, dy, ox, oy] of shapes) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let n = 0;
        while (true) {
          const p = at(x + n * dx, y + n * dy);
          if (!p || !counts(p) || at(x + n * dx + ox, y + n * dy + oy)) break;
          n++;
        }
        longest = Math.max(longest, n);
      }
    }
  }
  return longest;
}

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

  const original = PNG.sync.read(await fs.readFile(SHEET));
  const tiles = JSON.parse(await fs.readFile(TILES, "utf8")) as any[];
  const tilesets = JSON.parse(await fs.readFile(TILESETS, "utf8")) as any[];

  // A face is a builder on the species' rect, or its own rect.
  const facesOf = (sp: Species): Face[] =>
    sp.faces.map((f) => (typeof f === "function" ? { w: sp.w, h: sp.h, base: sp.base, build: f } : f));

  // Lay the species out first, left to right from SHEET_ROW, wrapping when
  // the next one would run off the sheet's right edge, to know how many
  // rows they need. The sheet grows to fit: the rows from SHEET_ROW down are
  // this script's, and `tilesets.json` carries the size the renderer maps
  // its texture coordinates with, so it is rewritten with the PNG.
  const layout: { species: Species; faces: Face[]; cx: number; cy: number }[] = [];
  {
    let cx = 0, cy = SHEET_ROW, rowH = 0;
    for (const species of SPECIES) {
      const faces = facesOf(species);
      const width = faces.reduce((a, f) => a + f.w, 0), height = Math.max(...faces.map((f) => f.h));
      if (width * CELL > original.width) throw new Error(`${species.id} is wider than the sheet`);
      if ((cx + width) * CELL > original.width) { cx = 0; cy += rowH; rowH = 0; }
      layout.push({ species, faces, cx, cy });
      cx += width;
      rowH = Math.max(rowH, height);
    }
    var neededHeight = (cy + rowH) * CELL;
  }
  const sheet = new PNG({ width: original.width, height: Math.max(original.height, neededHeight) });
  original.data.copy(sheet.data, 0, 0, original.width * Math.min(original.height, SHEET_ROW * CELL) * 4);
  // What every species shares with the tree the world already had.
  const HEIGHT = 4, DURATION_MS = 200;

  // Everything from the reserved row down is regenerated: the new sheet is
  // the old one above that row and blank below it, so a species that shrank
  // leaves no stray pixels behind.

  // A species dropped from the table leaves its tile behind, pointing at art
  // that now belongs to whatever moved into its cells. The rows from SHEET_ROW
  // down are this script's, so a tile anchored there that it did not render
  // is stale and goes.
  const ids = new Set(SPECIES.map((sp) => sp.id));
  for (let i = tiles.length - 1; i >= 0; i--) {
    const t = tiles[i];
    if (t.anchor?.tilesetId === TILESET_ID && t.anchor.y >= SHEET_ROW && !ids.has(t.id)) {
      console.log(`Removed stale ${t.id}`);
      tiles.splice(i, 1);
    }
  }

  const clipped: string[] = [];
  for (const { species, faces, cx, cy } of layout) {
    // A species' faces sit side by side, so one anchor and a rect per face.
    const sprites: unknown[] = [];
    let faceX = 0;
    for (let face = 0; face < faces.length; face++) {
      const rect = faces[face]!;
      // Rebuild the face with the clump seeds and yaws advanced until it
      // neither runs straight nor touches the rect's top or left edge, up to
      // a limit. Clipping is mostly geometry, but a clump can tip it either
      // way, so a variation that clips is passed over like one that runs.
      const leaves = (p: NonNullable<Pixel>) => p.material.outline !== C.outline;
      let pixels: Pixel[][] = [];
      let diagonal = 0, axis = 0, clippedTop = 0, clippedLeft = 0;
      for (variation = 0; variation < VARIATIONS; variation++) {
        pixels = await renderFace(species, rect.build(), face, rect);
        diagonal = species.straightLeaves ? 0 : longestStraightRun(pixels, leaves, true);
        axis = species.straightLeaves ? 0 : longestStraightRun(pixels, leaves, false);
        // A crown that reaches the rect's top or left edge is cut flat there,
        // and a flat top on a tree is the first thing anybody sees.
        clippedTop = pixels[0]!.filter((p) => p).length;
        clippedLeft = pixels.filter((r) => r[0]).length;
        if (diagonal < STRAIGHT_DIAGONAL && axis < STRAIGHT_AXIS && !clippedTop && !clippedLeft) break;
      }
      if (variation > 0 && variation < VARIATIONS) console.log(`  ${species.id} face ${face} settled on variation ${variation}`);
      variation = 0;
      if (clippedTop || clippedLeft) {
        clipped.push(`${species.id} face ${face}: ${clippedTop}px on the top edge, ${clippedLeft}px on the left`);
      }
      // A silhouette that runs straight along a diagonal for several pixels
      // reads as a cut, whatever made it. Leaves only: a trunk or a bare limb
      // is meant to be straight.
      if (diagonal >= STRAIGHT_DIAGONAL) clipped.push(`${species.id} face ${face}: a straight ${diagonal}px diagonal on the crown's edge`);
      if (axis >= STRAIGHT_AXIS) clipped.push(`${species.id} face ${face}: a straight ${axis}px flat on the crown's edge`);
      const ox = (cx + faceX) * CELL, oy = cy * CELL;
      for (let y = 0; y < pixels.length; y++) {
        for (let x = 0; x < pixels[y]!.length; x++) {
          const p = pixels[y]![x];
          if (!p) continue;
          const i = ((oy + y) * sheet.width + ox + x) * 4;
          const [r, g, b] = hexToRgb(p.colour);
          sheet.data[i] = r; sheet.data[i + 1] = g; sheet.data[i + 2] = b; sheet.data[i + 3] = 255;
        }
      }
      sprites.push({
        frames: [
          {
            sprite: { rect: { x: faceX, y: 0, w: rect.w, h: rect.h }, base: rect.base },
            durationMs: DURATION_MS,
          },
        ],
      });
      faceX += rect.w;
    }

    const shared = {
      id: species.id,
      name: species.name,
      height: HEIGHT,
      kind: "prop",
      attributes: {},
      anchor: { tilesetId: TILESET_ID, x: cx, y: cy },
      walkable: false,
    };
    const def = sprites.length > 1
      ? { ...shared, type: "scatter", scatter: sprites }
      : { ...shared, type: "simple", sprite: sprites[0] };
    const existing = tiles.findIndex((t) => t.id === species.id);
    if (existing >= 0) {
      // Keep whatever else the tile has authored on it; replace the art and
      // the type, and drop the other type's sprite field so the two never
      // coexist.
      const { sprite: _sprite, scatter: _scatter, ...kept } = tiles[existing];
      tiles[existing] = { ...kept, ...def };
    } else {
      tiles.splice(tiles.findIndex((t) => t.id === "tree") + SPECIES.indexOf(species), 0, def);
    }

    console.log(`Rendered ${species.id} at cell (${cx},${cy}), ${faces.length} face(s)`);
  }

  if (clipped.length && !process.argv.includes("--force")) {
    throw new Error(`Faces that would ship a cut, nothing written (--force writes anyway, to look):\n  ${clipped.join("\n  ")}`);
  }
  for (const line of clipped) console.warn(`Forced: ${line}`);

  await fs.writeFile(SHEET, PNG.sync.write(sheet));
  await fs.writeFile(TILES, JSON.stringify(tiles, null, 2) + "\n");
  const entry = tilesets.find((t) => t.id === TILESET_ID);
  if (!entry) throw new Error(`tilesets.json has no ${TILESET_ID}`);
  if (entry.width !== sheet.width || entry.height !== sheet.height) {
    console.log(`Sheet is now ${sheet.width}x${sheet.height}`);
    entry.width = sheet.width; entry.height = sheet.height;
    await fs.writeFile(TILESETS, JSON.stringify(tilesets, null, 2) + "\n");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
