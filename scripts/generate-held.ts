import path from "node:path";
import { HANDS } from "../app/lib/heldPlacement";
import { LAYERS, partsOn, type HeldPartId } from "../app/lib/humanParts";
import {
  DEFAULT_LOOK,
  FRAME_PX,
  SHEET_FACINGS,
  SHEET_POSES,
  composeSheet,
  splitBlocks,
  type LayerBlocks,
} from "../app/lib/humanSprite";
import { cast, outline, shade } from "./human-parts/cast";
import {
  type Axes,
  type Solid,
  type Vec,
  add,
  at,
  axesFor,
  box,
  capsule,
  cross,
  ellipsoid,
  normalise,
  scale,
  sphere,
} from "./human-parts/model";
import { BLOCK_H, BLOCK_W, OUTLINE, read, writeIndexed, writePreview } from "./human-parts/sheet";

const PREVIEW = process.env.PREVIEW;
const FILE = "human_held.png";

/** Every model fits in a sphere this wide about the point this far above the grip; rays are marched only inside it. */
const BOUND_R = 6.5;
const BOUND_LIFT = 1.5;
/** The pixel centre of a frame that a hand's grip is drawn about; `HELD_PLACEMENT` moves it to the hand. */
const GRIP: Vec = [8.5, 8.5, 0];
/** How far below that point and ahead of it the grip is. Changing either redraws every part on other pixels. */
const HAND_DROP = 0.3;
const HAND_AHEAD = 0.6;

const STEEL = ["#7f708a", "#9babb2", "#c7dcd0", "#ffffff"];
const IRON = ["#3e3546", "#7f708a", "#9babb2", "#c7dcd0"];
const WOOD = ["#6e2727", "#9e4539", "#cd683d"];
const PLANK = ["#9e4539", "#cd683d", "#e6904e"];
const GOLD = ["#f79617", "#fbb954"];
const STRING = ["#c7dcd0"];
const ORB = ["#a884f3", "#ffffff"];

/**
 * A thing's solids around the `grip` a hand holds it by. Both hands draw the
 * same frames, so a model does not know which holds it. A shafted thing is
 * held upright, which this projection draws as one straight diagonal.
 */
type HeldModel = (grip: Vec, x: Axes) => Solid[];

/** A one-pixel shaft covers less than half of most pixels it crosses, so it is weighted to take them. */
const THIN = 3;

/**
 * A shield held square to its bearer is edge-on in two facings, so it is
 * turned a little towards the viewer's side in all of them.
 */
function shieldAxes(x: Axes): Axes {
  const seen: Vec = x.fw[0] === 0 ? [1, 0, 0] : [0, 1, 0];
  const fw = normalise(add(x.fw, scale(seen, 0.7)));
  return { fw, lat: cross(x.up, fw), up: x.up };
}

/** Every held part of `HUMAN_PARTS` needs a model here, so a new one cannot be left undrawn. */
const HELD: Record<HeldPartId, HeldModel> = {
  sword: (g, x) => [
    { sdf: capsule(at(g, [x.up, 1.1]), at(g, [x.up, 5.8]), 0.32), ramp: STEEL, weight: THIN },
    { sdf: sphere(at(g, [x.up, 0.5]), 0.55), ramp: GOLD, weight: 2 },
  ],
  axe: (g, x) => {
    const top = at(g, [x.up, 4.8]);
    return [
      { sdf: capsule(at(g, [x.up, -0.6]), top, 0.3), ramp: WOOD, weight: THIN },
      {
        sdf: box(at(top, [x.fw, 0.9], [x.up, -0.5]), [0.9, 0.35, 1.1], x),
        ramp: STEEL,
        weight: 2,
      },
    ];
  },
  mace: (g, x) => {
    const top = at(g, [x.up, 4.4]);
    return [
      { sdf: capsule(at(g, [x.up, -0.4]), top, 0.3), ramp: WOOD, weight: THIN },
      { sdf: sphere(top, 1.15), ramp: IRON, weight: 1.5 },
    ];
  },
  bow: (g, x) => {
    const limb = (k: number): Vec =>
      at(g, [x.fw, 2.2 * Math.cos(k) - 0.4], [x.up, 0.6 + 4.2 * Math.sin(k)]);
    const bends = [-1.2, -0.6, 0, 0.6, 1.2];
    return [
      ...bends.slice(1).map((k, i) => ({
        sdf: capsule(limb(bends[i]!), limb(k), 0.32),
        ramp: WOOD,
        weight: THIN,
      })),
      { sdf: capsule(limb(bends[0]!), limb(bends.at(-1)!), 0.15), ramp: STRING, weight: 2 },
    ];
  },
  staff: (g, x) => {
    const top = at(g, [x.up, 5.2]);
    return [
      { sdf: capsule(at(g, [x.up, -3.2]), top, 0.3), ramp: WOOD, weight: THIN },
      { sdf: sphere(at(top, [x.up, 0.6]), 0.9), ramp: ORB, weight: 2 },
    ];
  },
  "wooden-shield": (g, x) => {
    const s = shieldAxes(x);
    const face = at(g, [x.fw, 1], [x.up, 0.4]);
    return [
      { sdf: ellipsoid(face, [0.45, 2.3, 2.5], s), ramp: PLANK },
      { sdf: sphere(at(face, [s.fw, 0.45]), 0.6), ramp: IRON, weight: 2 },
    ];
  },
  "metal-shield": (g, x) => {
    const s = shieldAxes(x);
    const face = at(g, [x.fw, 1], [x.up, 0.4]);
    return [
      { sdf: box(face, [0.4, 2, 2.5], s), ramp: IRON },
      { sdf: box(at(face, [s.fw, 0.2]), [0.4, 0.45, 2.5], s), ramp: STEEL, weight: 1.5 },
    ];
  },
};

/**
 * One facing of a held part, as colours by `y * FRAME_PX + x`, with its grip
 * at `GRIP`. `composeSheet` moves the frame to each hand, so nothing of the
 * figure is cut out of it and it is outlined all round.
 */
function drawFacing(model: HeldModel, row: number): (string | null)[] {
  const x = axesFor(SHEET_FACINGS[row]!);
  const grip = at(GRIP, [x.up, -HAND_DROP], [x.fw, HAND_AHEAD]);
  const solids = model(grip, x);
  const cells = cast(
    solids,
    [],
    { centre: at(grip, [x.up, BOUND_LIFT]), r: BOUND_R },
    { width: FRAME_PX, height: FRAME_PX, px: 1, origin: [0, 0] },
  );
  const colours = shade(
    cells.map((c) => ({ ...c, ramp: solids[c.part]!.ramp })),
    FRAME_PX * FRAME_PX,
  );
  return outline(colours, FRAME_PX, OUTLINE, () => true);
}

const parts = partsOn("weaponHand");
const width = (Math.max(...parts.map((p) => p.block)) + 1) * BLOCK_W;
const sheet: (string | null)[] = Array.from({ length: width * BLOCK_H }, () => null);
for (const part of parts) {
  SHEET_FACINGS.forEach((_, row) =>
    drawFacing(HELD[part.id], row).forEach((c, i) => {
      const x = part.block * BLOCK_W + (i % FRAME_PX);
      const y = row * FRAME_PX + Math.floor(i / FRAME_PX);
      sheet[y * width + x] = c;
    }),
  );
  console.log(`drew ${part.id}`);
}
writeIndexed(FILE, width, BLOCK_H, sheet);

if (PREVIEW) {
  const blocks = Object.fromEntries(
    LAYERS.map((layer) => {
      const png = read(layer.file);
      return [
        layer.id,
        splitBlocks({
          width: png.width,
          height: png.height,
          data: new Uint8ClampedArray(png.data),
        }),
      ];
    }),
  ) as LayerBlocks;
  const sheets = parts.flatMap((part) =>
    HANDS.map((hand) =>
      composeSheet(blocks, { ...DEFAULT_LOOK, parts: { ...DEFAULT_LOOK.parts, [hand]: part.id } }),
    ),
  );
  SHEET_POSES.forEach((name, pose) => {
    writePreview(
      path.join(PREVIEW, `held-${name}.png`),
      sheets.map((composed) => [
        (row: number, x: number, y: number) => {
          const i = ((row * FRAME_PX + y) * BLOCK_W + pose * FRAME_PX + x) * 4;
          if (composed[i + 3] === 0) return null;
          return `#${[composed[i]!, composed[i + 1]!, composed[i + 2]!].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
        },
      ]),
    );
  });
}
