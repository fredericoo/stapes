import path from "node:path";
import { HUMAN_PARTS, humanPart, type PartOn } from "../app/lib/humanParts";
import { FRAME_PX, SHEET_FACINGS, SHEET_POSES, SKIN_TONES } from "../app/lib/humanSprite";
import type { Direction } from "../app/lib/types";
import { cast, outline, shade, transpose } from "./human-parts/cast";
import { castIcon, writeIcon, writeIconPreview } from "./human-parts/icon";
import {
  type Axes,
  type Sdf,
  type Solid,
  type Vec,
  above,
  add,
  at,
  axesFor,
  below,
  box,
  cone,
  cylinder,
  ellipsoid,
  minus,
  scale,
  sphere,
} from "./human-parts/model";
import {
  BLOCK_H,
  BLOCK_W,
  BALD,
  OUTLINE,
  body,
  headCentre,
  heads,
  openAt,
  pixel,
  readColours,
  transposeOffset,
  writeIndexed,
  writePreview,
} from "./human-parts/sheet";

const PREVIEW = process.env.PREVIEW;

/** The head is a sphere about this many pixels across its radius; the bald head draws it as a 3×3 blob. */
const HEAD_R = 1.55;
/** Every model fits in a sphere this wide about the point this far above the head's centre; rays are marched only inside it. */
const BOUND_R = 5.5;
const BOUND_LIFT = 1.5;
/** Everything a hat models in front of the head and below this height is cut away, so it opens towards the face. */
const BROW = 0.85;
const FACE_BACK = 0.35;

/** Model pixels to each icon pixel: the most the hood fits one cell at. */
const ICON_PX = 0.62;

const BROWN = ["#45293f", "#6e2727", "#9e4539"];
const STEEL = ["#3e3546", "#7f708a", "#9babb2", "#c7dcd0"];
const GREEN = ["#165a4c", "#239063", "#1ebc73", "#91db69"];
const RED = ["#ae2334", "#e83b3b"];
const WOLF = ["#3e3546", "#694f62", "#7f708a", "#9babb2"];
const PALE = ["#7f708a", "#9babb2", "#ffffff"];
const BLACK = [OUTLINE];

type HatModel = {
  solids: (head: Vec, axes: Axes) => Solid[];
  opensToFace: boolean;
  /**
   * Seen face-on the head is three pixels wide, which can lose a hat's whole
   * shape. Mirroring the screen across its diagonal swaps world x and y and
   * keeps the height shear, so the east frames mirrored are a true south view.
   */
  southFromEast?: boolean;
  /** The item's icon in `equipment.png`, cast from the same model; most hat icons are drawn by hand. */
  icon?: readonly [number, number];
};

/**
 * A hat drawn by hand, one picture per facing: `rows` are its pixels from
 * (`left`, `top`) of the frame, one letter of `INK` each and `.` for none. The
 * head sits in the same place in every pose, so one picture serves all three.
 * It is for a hat that has to read as a particular thing at five pixels, which
 * a cast model blurs.
 */
type DrawnHat = {
  drawn: Record<Direction, { left: number; top: number; rows: readonly string[] }>;
};

const INK: Record<string, string> = {
  W: "#ffffff",
  L: "#c7dcd0",
  G: "#9babb2",
  S: "#3e3546",
};

function faceCut(head: Vec, axes: Axes): Sdf {
  const big = 6;
  return box(at(head, [axes.fw, big - FACE_BACK], [axes.up, BROW - big]), [big, big, big], axes);
}

/** Every part of `HUMAN_PARTS` on the hat layer needs a model here, so a new hat cannot be left undrawn. */
const HATS: Record<PartOn<"hat">, HatModel | DrawnHat> = {
  "leather-cap": {
    opensToFace: true,
    solids: (c, x) => [
      { sdf: above(sphere(at(c, [x.up, 0.35]), HEAD_R + 0.35), c[2] + 0.2), ramp: BROWN },
      {
        sdf: below(ellipsoid(at(c, [x.fw, 1.3], [x.up, 1.05]), [1, 1.3, 0.28], x), c[2] + 1.25),
        ramp: BROWN,
        weight: 1.5,
      },
    ],
  },
  "iron-helmet": {
    opensToFace: true,
    solids: (c, x) => [
      { sdf: above(sphere(at(c, [x.up, 0.3]), HEAD_R + 0.4), c[2]), ramp: STEEL },
      { sdf: cylinder(c, HEAD_R + 0.55, c[2] - 0.15, c[2] + 0.3), ramp: STEEL },
      {
        sdf: box(at(c, [x.fw, HEAD_R + 0.45], [x.up, 0.6]), [0.28, 0.28, 0.6], x),
        ramp: STEEL,
        weight: 2,
      },
    ],
  },
  "robin-hood-hat": {
    opensToFace: true,
    solids: (c, x) => [
      {
        sdf: above(
          ellipsoid(at(c, [x.up, 0.75], [x.fw, 0.2]), [HEAD_R + 0.55, HEAD_R + 0.1, 1.45], x),
          c[2] + 0.25,
        ),
        ramp: GREEN,
      },
      {
        sdf: cone(at(c, [x.up, 1], [x.fw, 0.9]), add(x.fw, scale(x.up, 0.15)), 2.3, 0.6),
        ramp: GREEN,
        weight: 1.5,
      },
      {
        sdf: below(
          ellipsoid(at(c, [x.fw, -0.8], [x.up, 0.55]), [1.3, HEAD_R + 0.3, 0.75], x),
          c[2] + 1.1,
        ),
        ramp: GREEN,
      },
      {
        sdf: cone(
          at(c, [x.fw, -0.9], [x.lat, 1.35], [x.up, 0.9]),
          add(x.up, scale(x.fw, -0.8)),
          3.4,
          0.5,
        ),
        ramp: RED,
        weight: 2,
      },
    ],
  },
  "wolfskin-hood": {
    opensToFace: false,
    southFromEast: true,
    icon: [31, 5],
    solids: (c, x) => [
      { sdf: above(sphere(at(c, [x.up, 0.35]), HEAD_R + 0.45), c[2] + 0.15), ramp: WOLF },
      {
        sdf: ellipsoid(at(c, [x.fw, 2], [x.up, 0.95]), [1.6, 0.85, 0.7], x),
        ramp: PALE,
        weight: 1.3,
      },
      { sdf: sphere(at(c, [x.fw, 3.4], [x.up, 1.05]), 0.45), ramp: BLACK, weight: 2 },
      ...[-1, 1].flatMap((s) => [
        {
          sdf: cone(
            at(c, [x.lat, s * 1.15], [x.up, 1.2], [x.fw, -0.3]),
            add(add(x.up, scale(x.fw, -0.2)), scale(x.lat, s * 0.3)),
            2.7,
            0.75,
          ),
          ramp: WOLF,
          weight: 2,
        },
        {
          sdf: sphere(at(c, [x.fw, 1.4], [x.lat, s * 0.85], [x.up, 1.2]), 0.35),
          ramp: BLACK,
          weight: 2,
        },
      ]),
    ],
  },
  /**
   * The skull item (`skull-player`) cut down to sit a pixel past the head: the
   * shaded crown, the sockets, and the jaw a step down and to the right, as
   * everything lower is in this projection. Facing south it is five pixels
   * wide so that both sockets sit inside the edge, where the outline would
   * swallow one. East keeps the one socket at the front, west is east
   * mirrored, and north is the back of the skull.
   */
  "bone-helm": {
    drawn: {
      s: { left: 4, top: 3, rows: ["LLLLS", "LWWWL", "LWWWL", "LSWSL", ".GWWG"] },
      e: { left: 3, top: 3, rows: ["LLLL", "LWWW", "LWWW", "LWSW", ".GWW"] },
      w: { left: 4, top: 3, rows: ["LLLL", "WWWL", "WWWL", "WSWL", "WWG."] },
      n: { left: 4, top: 3, rows: ["LLLS", "LWWL", "LWWL", "LWWL", ".GG."] },
    },
  },
};

const WITH_HAIR = (["short-hair", "beard", "long-hair"] as const).map((id) => humanPart(id).block);
const SKIN = new Set<string>(SKIN_TONES.default);

/** The skin a hat that opens towards the face leaves showing: the face of every head with hair, not a bald scalp. */
function facePixels(pose: number, row: number): Set<number> {
  const face = new Set<number>();
  for (const block of WITH_HAIR) {
    for (let y = 0; y < FRAME_PX; y++) {
      for (let x = 0; x < FRAME_PX; x++) {
        const c = pixel(heads, block, pose, row, x, y);
        if (c && SKIN.has(c)) face.add(y * FRAME_PX + x);
      }
    }
  }
  return face;
}

function solidsFor(model: HatModel, head: Vec, facing: Direction): Solid[] {
  const axes = axesFor(facing);
  const cut = model.opensToFace ? faceCut(head, axes) : null;
  return model.solids(head, axes).map((s) => (cut ? { ...s, sdf: minus(s.sdf, cut) } : s));
}

/** One frame of a hat, as colours by `y * FRAME_PX + x`. */
function drawFrame(
  model: HatModel,
  pose: number,
  row: number,
  facing: Direction,
): (string | null)[] {
  const [hx, hy] = headCentre(pose, row);
  const head: Vec = [hx, hy, 0];
  const solids = solidsFor(model, head, facing);
  const cells = cast(
    solids,
    [sphere(head, HEAD_R)],
    { centre: [hx, hy, BOUND_LIFT], r: BOUND_R },
    { width: FRAME_PX, height: FRAME_PX, px: 1, origin: [0, 0] },
  );
  const colours = shade(
    cells.map((c) => ({ ...c, ramp: solids[c.part]!.ramp })),
    FRAME_PX * FRAME_PX,
  );
  if (model.opensToFace) for (const i of facePixels(pose, row)) colours[i] = null;
  return outline(colours, FRAME_PX, OUTLINE, openAt(pose, row));
}

function drawDrawn(hat: DrawnHat, pose: number, row: number, facing: Direction) {
  const { left, top, rows } = hat.drawn[facing];
  const colours: (string | null)[] = Array.from({ length: FRAME_PX * FRAME_PX }, () => null);
  rows.forEach((line, dy) =>
    [...line].forEach((letter, dx) => {
      if (letter !== ".") colours[(top + dy) * FRAME_PX + left + dx] = INK[letter]!;
    }),
  );
  return outline(colours, FRAME_PX, OUTLINE, openAt(pose, row));
}

function drawHat(model: HatModel | DrawnHat): (string | null)[][][] {
  if ("drawn" in model) {
    return SHEET_FACINGS.map((facing, row) =>
      SHEET_POSES.map((_, pose) => drawDrawn(model, pose, row, facing)),
    );
  }
  const frames = SHEET_FACINGS.map((facing, row) =>
    SHEET_POSES.map((_, pose) => drawFrame(model, pose, row, facing)),
  );
  if (!model.southFromEast) return frames;
  const south = SHEET_FACINGS.indexOf("s");
  const east = SHEET_FACINGS.indexOf("e");
  frames[south] = SHEET_POSES.map((_, pose) =>
    transpose(frames[east]![pose]!, FRAME_PX, ...transposeOffset(heads, BALD, pose, "e", "s")),
  );
  return frames;
}

/** The model alone, facing south with no head inside it. */
function drawIcon(model: HatModel): (string | null)[] {
  const head: Vec = [0, 0, 0];
  return castIcon(solidsFor(model, head, "s"), { centre: [0, 0, BOUND_LIFT], r: BOUND_R }, ICON_PX);
}

const blocks = HUMAN_PARTS.filter((p) => p.layer === "hat");
const { width: existingWidth } = readColours("human_hats.png");
const width = Math.max(existingWidth, (Math.max(...blocks.map((p) => p.block)) + 1) * BLOCK_W);
const sheet: (string | null)[] = Array.from({ length: width * BLOCK_H }, () => null);
for (const part of blocks) {
  const model = HATS[part.id];
  drawHat(model).forEach((row, r) =>
    row.forEach((frame, pose) =>
      frame.forEach((c, i) => {
        const x = part.block * BLOCK_W + pose * FRAME_PX + (i % FRAME_PX);
        const y = r * FRAME_PX + Math.floor(i / FRAME_PX);
        sheet[y * width + x] = c;
      }),
    ),
  );
  if ("icon" in model && model.icon) writeIcon(model.icon, drawIcon(model));
  console.log(`drew ${part.id}`);
}
writeIndexed("human_hats.png", width, BLOCK_H, sheet);

if (PREVIEW) {
  const shortHair = humanPart("short-hair").block;
  writePreview(
    path.join(PREVIEW, "hats.png"),
    blocks.map((part) => [
      (row, x, y) => pixel(body, 0, 1, row, x, y),
      (row, x, y) => pixel(heads, shortHair, 1, row, x, y),
      (row, x, y) =>
        sheet[(row * FRAME_PX + y) * width + part.block * BLOCK_W + FRAME_PX + x] ?? null,
    ]),
  );
  writeIconPreview(
    path.join(PREVIEW, "hat-icons.png"),
    blocks.flatMap((p) => {
      const hat = HATS[p.id];
      return "icon" in hat && hat.icon ? [hat.icon] : [];
    }),
  );
}
