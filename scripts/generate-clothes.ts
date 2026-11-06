import path from "node:path";
import { humanPart, type PartOn } from "../app/lib/humanParts";
import { FRAME_PX, SHEET_FACINGS, SHEET_POSES } from "../app/lib/humanSprite";
import { CELL_SIZE, type Direction } from "../app/lib/types";
import { cast, outline, shade, transpose } from "./human-parts/cast";
import { EQUIPMENT_INK, front, readIcon, writeIcon, writeIconPreview } from "./human-parts/icon";
import {
  type Axes,
  type Sdf,
  type Solid,
  type Vec,
  FACING,
  at,
  axesFor,
  capsule,
  cross,
  dot,
  ellipsoid,
  len,
  normalise,
  scale,
} from "./human-parts/model";
import {
  BLOCK_H,
  BLOCK_W,
  OUTLINE,
  body,
  heads,
  openAt,
  pixel,
  read,
  readColours,
  transposeOffset,
  writeIndexed,
  writePreview,
} from "./human-parts/sheet";

const PREVIEW = process.env.PREVIEW;
const BOUND_MARGIN = 2.5;
const UNLIT = 0.5;

const PELT = ["#3e3546", "#694f62", "#7f708a", "#9babb2"];
const LEATHER = ["#6e2727", "#9e4539", "#e6904e"];

/** `sdf` cut to the trunk, from `overTop` above its top down to `downTo` of the way to its bottom: a pelt hangs from the shoulders and stops above the knees. */
function between(sdf: Sdf, t: Torso, x: Axes, overTop: number, downTo: number): Sdf {
  const floor = at(t.top, [x.up, -t.length * downTo]);
  return (p) =>
    Math.max(
      sdf(p),
      dot([p[0] - t.top[0], p[1] - t.top[1], p[2] - t.top[2]], x.up) - overTop,
      -dot([p[0] - floor[0], p[1] - floor[1], p[2] - floor[2]], x.up),
    );
}

/** The body's trunk in one frame, fitted to the template's pixels: a capsule from `top` to `bottom`. */
type Torso = { top: Vec; bottom: Vec; mid: Vec; r: number; length: number };

/** A solid with `spills` may draw outside the template's silhouette, as a pelt bulging off the back does. */
type ClothSolid = Solid & { spills?: boolean };

type ClothesModel = {
  /** The hand-drawn part whose silhouette, arms and outline the cast part is coloured into. */
  template: PartOn<"clothes">;
  /** The trunk's own cloth, for template pixels the cast does not reach. */
  cloth: readonly string[];
  solids: (torso: Torso, axes: Axes) => ClothSolid[];
  /**
   * Facing north the back fills the frame and the cast pelt can come out
   * shapeless. Mirroring the screen across its diagonal swaps world x and y,
   * so the west frames mirrored are a north view of the same coat.
   */
  northFromWest?: boolean;
  /**
   * The item's icon in `equipment.png`, coloured into the silhouette of the
   * icon at `template` the way a frame is coloured into its template part:
   * a trunk fitted to it is cast from the front, `rise` above, and pixels
   * the trunk does not reach (the sleeves) take `sleeves`.
   */
  icon?: {
    cell: readonly [number, number];
    template: readonly [number, number];
    rise: number;
    sleeves: readonly string[];
  };
};

/**
 * Only the parts listed here are cast; the rest of `human_clothes.png` is
 * drawn by hand and left as it is.
 */
const CLOTHES: Partial<Record<PartOn<"clothes">, ClothesModel>> = {
  "wolfskin-coat": {
    template: "blue-tunic",
    cloth: LEATHER,
    icon: { cell: [13, 4], template: [13, 3], rise: 0.9, sleeves: PELT },
    northFromWest: true,
    solids: (t, x) => {
      const pelt = (sdf: Sdf): Sdf => between(sdf, t, x, 0.35, 0.85);
      return [
        { sdf: capsule(t.top, t.bottom, t.r), ramp: LEATHER },
        {
          sdf: pelt(
            ellipsoid(at(t.top, [x.up, -0.55], [x.fw, -0.15]), [t.r + 0.3, t.r + 0.45, 0.9], x),
          ),
          ramp: PELT,
          spills: true,
        },
        {
          sdf: pelt(
            ellipsoid(
              at(t.mid, [x.fw, -t.r * 0.5], [x.up, t.length * 0.05]),
              [t.r * 0.75, t.r + 0.15, t.length * 0.5],
              x,
            ),
          ),
          ramp: PELT,
          spills: true,
        },
      ];
    },
  },
};

/**
 * The body in the art runs steeper down the screen than a vertical line,
 * which this projection draws at 45°, so the trunk is modelled leaning by the
 * least horizontal amount that projects onto the template's main axis.
 */
function fitTorso(mask: [number, number][]): { torso: Torso; down: Vec } {
  const n = mask.length;
  const mx = mask.reduce((s, [x]) => s + x + 0.5, 0) / n;
  const my = mask.reduce((s, [, y]) => s + y + 0.5, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of mask) {
    const dx = x + 0.5 - mx;
    const dy = y + 0.5 - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let u: [number, number] = [Math.cos(angle), Math.sin(angle)];
  if (u[0] + u[1] < 0) u = [-u[0], -u[1]];
  const v: [number, number] = [-u[1], u[0]];
  const along = mask.map(([x, y]) => (x + 0.5 - mx) * u[0] + (y + 0.5 - my) * u[1]);
  const across = mask.map(([x, y]) => (x + 0.5 - mx) * v[0] + (y + 0.5 - my) * v[1]);
  const perScreen = u[0] + u[1];
  const down: Vec = [perScreen * u[0] - 1, perScreen * u[1] - 1, -1];
  const centre: Vec = [mx, my, 0];
  const top = at(centre, [down, Math.min(...along) / perScreen]);
  const bottom = at(centre, [down, Math.max(...along) / perScreen]);
  const r = (Math.max(...across) - Math.min(...across)) / 2;
  const length = len([bottom[0] - top[0], bottom[1] - top[1], bottom[2] - top[2]]);
  return {
    torso: {
      top,
      bottom,
      mid: at(top, [down, (Math.max(...along) - Math.min(...along)) / perScreen / 2]),
      r,
      length,
    },
    down,
  };
}

/** The facing's axes with `up` along the leaning trunk rather than straight up. */
function trunkAxes(facing: Direction, down: Vec): Axes {
  const up = normalise(scale(down, -1));
  const f = FACING[facing];
  const fw = normalise(at(f, [up, -dot(f, up)]));
  return { fw, lat: cross(up, fw), up };
}

function drawFrame(
  model: ClothesModel,
  template: (string | null)[],
  pose: number,
  row: number,
  facing: Direction,
): (string | null)[] {
  const mask: [number, number][] = [];
  template.forEach((c, i) => {
    if (c) mask.push([i % FRAME_PX, Math.floor(i / FRAME_PX)]);
  });
  const { torso, down } = fitTorso(mask);
  const axes = trunkAxes(facing, down);
  const solids = model.solids(torso, axes);
  const cells = cast(
    solids,
    [],
    { centre: torso.mid, r: torso.length / 2 + torso.r + BOUND_MARGIN },
    { width: FRAME_PX, height: FRAME_PX, px: 1, origin: [0, 0] },
  );
  const hits = new Map(cells.map((c) => [c.at, c]));
  /** Behind a figure facing south or east, pelt at shoulder height lands above the shoulders on screen and reads as a collar standing up behind the head, so nothing spills above the template's first row. */
  const firstRow = Math.min(...mask.map(([, y]) => y));
  const shaded: { at: number; ramp: readonly string[]; light: number }[] = [];
  const out: (string | null)[] = Array.from({ length: FRAME_PX * FRAME_PX }, () => null);
  for (let i = 0; i < FRAME_PX * FRAME_PX; i++) {
    const c = template[i];
    const hit = hits.get(i);
    const solid = hit ? solids[hit.part]! : null;
    if (c === OUTLINE) {
      out[i] = OUTLINE;
    } else if (c) {
      const ramp = solid?.ramp ?? model.cloth;
      shaded.push({ at: i, ramp, light: hit?.light ?? UNLIT });
    } else if (solid?.spills && Math.floor(i / FRAME_PX) >= firstRow) {
      shaded.push({ at: i, ramp: solid.ramp, light: hit!.light });
    }
  }
  shade(shaded, FRAME_PX * FRAME_PX).forEach((c, i) => {
    if (c) out[i] = c;
  });
  return outline(out, FRAME_PX, OUTLINE, openAt(pose, row));
}

/** How much of the icon's width is trunk; the rest is sleeves. */
const ICON_TRUNK = 0.55;
const ICON_INK = "#000000";

function drawIcon(model: ClothesModel, icon: NonNullable<ClothesModel["icon"]>): (string | null)[] {
  const template = readIcon(icon.template);
  const mask = template.flatMap((c, i) => (c ? [[i % CELL_SIZE, Math.floor(i / CELL_SIZE)]] : []));
  const xs = mask.map(([x]) => x!);
  const ys = mask.map(([, y]) => y!);
  const cx = (Math.min(...xs) + Math.max(...xs) + 1) / 2;
  const r = ((Math.max(...xs) - Math.min(...xs) + 1) / 2) * ICON_TRUNK;
  const top: Vec = [cx, 0, -Math.min(...ys)];
  const bottom: Vec = [cx, 0, -(Math.max(...ys) + 1)];
  const length = top[2] - bottom[2];
  const torso: Torso = { top, bottom, mid: at(top, [[0, 0, -1], length / 2]), r, length };
  const solids = model.solids(torso, axesFor("s"));
  const cells = cast(
    solids,
    [],
    { centre: torso.mid, r: length / 2 + r + BOUND_MARGIN },
    { width: CELL_SIZE, height: CELL_SIZE, px: 1, origin: [0, 0] },
    front(icon.rise),
  );
  const hits = new Map(cells.map((c) => [c.at, c]));
  const shaded = template.flatMap((c, i) => {
    if (!c || c === ICON_INK) return [];
    const hit = hits.get(i);
    return [
      { at: i, ramp: hit ? solids[hit.part]!.ramp : icon.sleeves, light: hit?.light ?? UNLIT },
    ];
  });
  return shade(shaded, CELL_SIZE * CELL_SIZE).map((c, i) =>
    template[i] === ICON_INK ? ICON_INK : c ? EQUIPMENT_INK[c]! : null,
  );
}

const FILE = "human_clothes.png";
const templateSheet = read(FILE);
const { width, colours: sheet } = readColours(FILE);
const drawn: PartOn<"clothes">[] = [];
for (const [id, model] of Object.entries(CLOTHES) as [PartOn<"clothes">, ClothesModel][]) {
  const block = humanPart(id).block;
  const source = humanPart(model.template).block;
  if ((block + 1) * BLOCK_W > width) throw new Error(`${id}'s block is past the end of ${FILE}`);
  const frames = SHEET_FACINGS.map((facing, row) =>
    SHEET_POSES.map((_, pose) => {
      const template: (string | null)[] = [];
      for (let y = 0; y < FRAME_PX; y++)
        for (let x = 0; x < FRAME_PX; x++)
          template.push(pixel(templateSheet, source, pose, row, x, y));
      return drawFrame(model, template, pose, row, facing);
    }),
  );
  if (model.northFromWest) {
    const west = SHEET_FACINGS.indexOf("w");
    frames[SHEET_FACINGS.indexOf("n")] = SHEET_POSES.map((_, pose) =>
      transpose(frames[west]![pose]!, FRAME_PX, ...transposeOffset(body, 0, pose, "w", "n")),
    );
  }
  frames.forEach((poses, row) =>
    poses.forEach((frame, pose) =>
      frame.forEach((c, i) => {
        const x = block * BLOCK_W + pose * FRAME_PX + (i % FRAME_PX);
        const y = row * FRAME_PX + Math.floor(i / FRAME_PX);
        sheet[y * width + x] = c;
      }),
    ),
  );
  if (model.icon) writeIcon(model.icon.cell, drawIcon(model, model.icon));
  drawn.push(id);
  console.log(`drew ${id}`);
}
writeIndexed(FILE, width, BLOCK_H, sheet);

if (PREVIEW) {
  writeIconPreview(
    path.join(PREVIEW, "clothes-icons.png"),
    drawn.flatMap((id) => (CLOTHES[id]?.icon ? [CLOTHES[id].icon.cell] : [])),
  );
  const shortHair = humanPart("short-hair").block;
  const shoes = read("human_shoes.png");
  const hats = read("human_hats.png");
  writePreview(
    path.join(PREVIEW, "clothes.png"),
    drawn.flatMap((id) => {
      const block = humanPart(id).block;
      const coat = (row: number, x: number, y: number) =>
        sheet[(row * FRAME_PX + y) * width + block * BLOCK_W + FRAME_PX + x] ?? null;
      const base = [
        (row: number, x: number, y: number) => pixel(body, 0, 1, row, x, y),
        (row: number, x: number, y: number) =>
          pixel(shoes, humanPart("wolfskin-boots").block, 1, row, x, y),
        coat,
        (row: number, x: number, y: number) => pixel(heads, shortHair, 1, row, x, y),
      ];
      return [
        base,
        [
          ...base,
          (row: number, x: number, y: number) =>
            pixel(hats, humanPart("wolfskin-hood").block, 1, row, x, y),
        ],
      ];
    }),
  );
}
