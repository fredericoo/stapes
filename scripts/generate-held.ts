import path from "node:path";
import { HANDS, type Hand } from "../app/lib/heldPlacement";
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
/** A guard in a skin shade sits at the grip and reads as a hand that does not follow the skin tone. */
const GUARD = ["#3e3546", "#7f708a"];
const IRON = ["#3e3546", "#7f708a", "#9babb2", "#c7dcd0"];
/** Darker than any shade of the default skin, so a shaft crossing the hand is not read as part of it. */
const WOOD = ["#45293f", "#6e2727", "#9e4539"];
const PLANK = ["#9e4539", "#cd683d", "#e6904e"];
const STRING = ["#c7dcd0"];
const ORB = ["#a884f3", "#ffffff"];

/**
 * A thing's solids around the `grip` a hand holds it by. `x.lat` points away
 * from the body on the side of the hand that holds it, so a model built on
 * it comes out mirrored in the other hand. A shafted thing is
 * held upright, which this projection draws as one straight diagonal.
 */
type HeldModel = (grip: Vec, x: Axes) => Solid[];

/** A one-pixel shaft covers less than half of most pixels it crosses, so it is weighted to take them. */
const THIN = 3;

/** How far a shield is turned away from the body when that shows more of its face, and when it shows less. */
const SHIELD_TURN = 0.7;
const SHIELD_TURN_AWAY = 0.25;

/**
 * A shield is turned away from the body, to the side of the hand that holds
 * it. Only the south and east of anything is seen, so a turn to the north or
 * west hides the face and is kept slight.
 */
function shieldAxes(x: Axes): Axes {
  const seen = x.lat[0] + x.lat[1] > 0;
  const fw = normalise(add(x.fw, scale(x.lat, seen ? SHIELD_TURN : SHIELD_TURN_AWAY)));
  return { fw, lat: cross(x.up, fw), up: x.up };
}

/** Every held part of `HUMAN_PARTS` needs a model here, so a new one cannot be left undrawn. */
const HELD: Record<HeldPartId, HeldModel> = {
  sword: (g, x) => [
    { sdf: capsule(at(g, [x.up, 1.1]), at(g, [x.up, 5.8]), 0.32), ramp: STEEL, weight: THIN },
    { sdf: sphere(at(g, [x.up, 0.5]), 0.55), ramp: GUARD, weight: 2 },
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
function drawFacing(model: HeldModel, hand: Hand, row: number): (string | null)[] {
  const facing = axesFor(SHEET_FACINGS[row]!);
  const x: Axes = { ...facing, lat: scale(facing.lat, hand === "weaponHand" ? 1 : -1) };
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
  HANDS.forEach((hand, column) =>
    SHEET_FACINGS.forEach((_, row) =>
      drawFacing(HELD[part.id], hand, row).forEach((c, i) => {
        const x = part.block * BLOCK_W + column * FRAME_PX + (i % FRAME_PX);
        const y = row * FRAME_PX + Math.floor(i / FRAME_PX);
        sheet[y * width + x] = c;
      }),
    ),
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
