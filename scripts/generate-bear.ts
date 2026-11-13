import path from "node:path";
import { PNG } from "pngjs";
import { CELL_SIZE, type TileDef } from "../app/lib/types";
import { normalise, type Vec3 } from "./limb-caster";
import { castModel, writeCast } from "./model-caster";
import { paint, paletteRgba, writeTileset } from "./tileset-output";

const TILESET_ID = "bear";

/**
 * Four cells square with the bear standing on the third, as the cyclops is: a
 * body longer than a cell overhangs it at both ends, and its back leans up and
 * to the left a further cell.
 */
const FRAME_CELLS = 4;
const BASE_CELL = 2;
const FRAME_PX = FRAME_CELLS * CELL_SIZE;
const PROJECTION = { spritePx: FRAME_PX, groundPx: BASE_CELL * CELL_SIZE, topPx: 10 };

const OUTLINE = 0;
const FUR_RAMP = [11, 3, 2];
const MUZZLE_RAMP = [18, 13, 11];
const PAW_RAMP = [3, 2, 2];
const NOSE = 0;
const EYE = 0;

type Facing = "n" | "e" | "s" | "w";

/** The way a facing looks on the ground: x is east and y is south. */
const AHEAD: Record<Facing, [number, number]> = {
  n: [0, -1],
  e: [1, 0],
  s: [0, 1],
  w: [-1, 0],
};

type Part = "fur" | "ear" | "muzzle" | "paw" | "nose";

/** Along the bear, across it to its right, and up, from the middle of its cell on the ground. */
type Ellipsoid = { part: Part; at: Vec3; radii: Vec3 };

const HEAD_AT: Vec3 = [4.3, 0, 3.3];

const TRUNK: Ellipsoid[] = [
  { part: "fur", at: [-3.6, 0, 3.5], radii: [3.6, 3.3, 2.4] },
  { part: "fur", at: [0.4, 0, 3.9], radii: [3.7, 3.5, 2.7] },
  { part: "fur", at: HEAD_AT, radii: [2.6, 2.7, 2.3] },
  { part: "ear", at: [3.6, -2, 5.3], radii: [1.1, 1.1, 1.1] },
  { part: "ear", at: [3.6, 2, 5.3], radii: [1.1, 1.1, 1.1] },
  { part: "muzzle", at: [6.6, 0, 2.7], radii: [1.4, 1.25, 1.1] },
  { part: "nose", at: [7.7, 0, 3], radii: [0.7, 0.7, 0.7] },
];

/**
 * Front right, front left, hind right, hind left. All four stand inside the
 * bear's own cell, so the cell it occupies is the one its feet are drawn on
 * and only the body above them overhangs the neighbours.
 */
const LEGS: [number, number][] = [
  [2, 1.9],
  [2, -1.9],
  [-2, 1.9],
  [-2, -1.9],
];
/** The model below is drawn this many times larger. */
const SIZE = 1.15;

const LEG_RADIUS = 1.4;
const LEG_TOP = 2.8;
const PAW_TOP = 0.9;

/**
 * How far along the bear each leg has swung, in the order of `LEGS`. A walking
 * bear moves a front leg with the hind leg on the other side.
 */
type Pose = [number, number, number, number];
const STRIDE = 1.1;
const POSES: Pose[] = [
  [0, 0, 0, 0],
  [STRIDE, -STRIDE, -STRIDE, STRIDE],
  [-STRIDE, STRIDE, STRIDE, -STRIDE],
];

type Hit = { part: Part; normal: Vec3 };

function sampler(facing: Facing, pose: Pose) {
  const [ax, ay] = AHEAD[facing];
  const centre = CELL_SIZE / 2;
  return (p: Vec3, scale: number): Hit | null => {
    const x = (p[0] / scale - centre) / SIZE;
    const y = (p[1] / scale - centre) / SIZE;
    const along = x * ax + y * ay;
    const across = -x * ay + y * ax;
    const up = p[2] / scale / SIZE;
    const toWorld = (n: Vec3): Vec3 =>
      normalise([n[0] * ax - n[1] * ay, n[0] * ay + n[1] * ax, n[2]]);

    for (let i = TRUNK.length - 1; i >= 0; i--) {
      const { part, at, radii } = TRUNK[i]!;
      const d: Vec3 = [along - at[0], across - at[1], up - at[2]];
      if ((d[0] / radii[0]) ** 2 + (d[1] / radii[1]) ** 2 + (d[2] / radii[2]) ** 2 > 1) continue;
      return {
        part,
        normal: toWorld([d[0] / radii[0] ** 2, d[1] / radii[1] ** 2, d[2] / radii[2] ** 2]),
      };
    }
    if (up < 0 || up > LEG_TOP) return null;
    for (let i = 0; i < LEGS.length; i++) {
      const da = along - LEGS[i]![0] - pose[i]!;
      const dc = across - LEGS[i]![1];
      if (Math.hypot(da, dc) > LEG_RADIUS) continue;
      return { part: up < PAW_TOP ? "paw" : "fur", normal: toWorld([da, dc, 0.2]) };
    }
    return null;
  };
}

/** Lit from the south-west and above, as every block here: top bright, south side mid, east side dark. */
const LIGHT = normalise([-0.5, 0.45, 0.75]);

function shade(hit: Hit): number {
  if (hit.part === "nose") return NOSE;
  const lit = hit.normal[0] * LIGHT[0] + hit.normal[1] * LIGHT[1] + hit.normal[2] * LIGHT[2];
  const band = lit > 0.45 ? 0 : lit > -0.4 ? 1 : 2;
  if (hit.part === "muzzle") return MUZZLE_RAMP[band]!;
  if (hit.part === "paw" || hit.part === "ear") return PAW_RAMP[band]!;
  return FUR_RAMP[band]!;
}

/** Eyes are smaller than a pixel on the model, so they are put on after the cast, where the model has them. */
const EYES: Vec3[] = [
  [6, 1.4, 4.2],
  [6, -1.4, 4.2],
];

/** An eye shows when its side of the head faces south or east, the two sides the projection draws. */
function eyePixels(facing: Facing): [number, number][] {
  const [ax, ay] = AHEAD[facing];
  const centre = CELL_SIZE / 2;
  const seen: [number, number][] = [];
  for (const [along, across, up] of EYES) {
    const out: Vec3 = [along - HEAD_AT[0], across - HEAD_AT[1], up - HEAD_AT[2]];
    const outX = out[0] * ax - out[1] * ay;
    const outY = out[0] * ay + out[1] * ax;
    if (outX + outY + out[2] <= 0) continue;
    const x = centre + (along * ax - across * ay) * SIZE;
    const y = centre + (along * ay + across * ax) * SIZE;
    seen.push([
      Math.floor(x + PROJECTION.groundPx - up * SIZE),
      Math.floor(y + PROJECTION.groundPx - up * SIZE),
    ]);
  }
  return seen;
}

/** A dark edge all the way round, as the cat and the wolf have. */
function outlined(pixels: Int16Array, size: number): Int16Array {
  const out = pixels.slice();
  const filled = (u: number, v: number) =>
    u >= 0 && v >= 0 && u < size && v < size && pixels[v * size + u]! >= 0;
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      if (filled(u, v)) continue;
      if (filled(u - 1, v) || filled(u + 1, v) || filled(u, v - 1) || filled(u, v + 1)) {
        out[v * size + u] = OUTLINE;
      }
    }
  }
  return out;
}

function castBear(facing: Facing, pose: Pose): Int16Array {
  const pixels = castModel({ sample: sampler(facing, pose), shade }, PROJECTION);
  for (const [u, v] of eyePixels(facing)) {
    if (pixels[v * FRAME_PX + u]! >= 0) pixels[v * FRAME_PX + u] = EYE;
  }
  const edged = outlined(pixels, FRAME_PX);
  const onEdge = (n: number) =>
    n < FRAME_PX ||
    n >= FRAME_PX * (FRAME_PX - 1) ||
    n % FRAME_PX === 0 ||
    n % FRAME_PX === FRAME_PX - 1;
  if (pixels.some((index, n) => index >= 0 && onEdge(n))) {
    throw new Error(`the bear facing ${facing} runs off its frame`);
  }
  return edged;
}

const FACINGS: Facing[] = ["s", "n", "e", "w"];
const STEP_MS = 260;

function frame(pose: number, row: number) {
  return {
    sprite: {
      rect: { x: pose * FRAME_CELLS, y: row * FRAME_CELLS, w: FRAME_CELLS, h: FRAME_CELLS },
      base: { x: BASE_CELL, y: BASE_CELL },
    },
    durationMs: STEP_MS,
  };
}

function facingFrames(poses: readonly number[]) {
  return Object.fromEntries(
    FACINGS.map((facing, row) => [facing, { frames: poses.map((pose) => frame(pose, row)) }]),
  );
}

const FED = { cond: "status", id: "fed" };
const HUNGRY = { combinator: "and", not: true, rules: [FED] };
const AT_DEN = { cond: "in_range", of: { type: "home" }, cells: 2 };
const PREY = { type: "slot", data: { name: "prey" } };

/** Fed left at which the bear stops eating what it can see; raw meat gives 90 to 240 seconds. */
const FULL_MS = 240000;

/**
 * The den is where the bear was placed. Fed, it walks back there and sleeps
 * until the status runs out; hungry, it hunts and forages inside its leash.
 * `sleeps` holds at `rest`, above the `need` that food fires at, so a fed
 * bear in its den does not get up for a meal it can see.
 */
const BRAIN = {
  initial: "lumbering",
  states: {
    lumbering: { do: [{ action: "walk_n_steps", steps: 2 }] },
    mauling: {
      onEnter: [{ effect: "noise", text: "*ROAR*" }],
      do: [{ action: "attack", of: PREY }, { action: "step_toward", of: PREY }, { action: "hold" }],
    },
    denning: {
      band: "errand",
      do: [
        { action: "step_toward", of: { type: "home" } },
        { action: "step_random" },
        { action: "hold" },
      ],
    },
  },
  triggers: [
    {
      band: "errand",
      if: {
        combinator: "and",
        rules: [FED, { cond: "out_of_range", of: { type: "home" }, cells: 2 }],
      },
      to: "denning",
    },
  ],
  transitions: [
    { from: "denning", if: AT_DEN, to: "lumbering" },
    { from: "denning", if: HUNGRY, to: "lumbering" },
  ],
  traits: [
    { trait: "evades-the-unreachable", with: {} },
    { trait: "fights-back", with: { fight: "mauling", target: "prey", calm: 14 } },
    {
      trait: "hunts-on-sight",
      with: {
        prey: ["player", "deer", "rabbit"],
        within: 8,
        fight: "mauling",
        target: "prey",
        calm: 14,
        when: HUNGRY,
      },
    },
    {
      trait: "eats-when-hungry",
      with: {
        food: ["raw-meat", "cooked-meat", "apple", "berry", "apple-pie", "bread", "cheese"],
        full: FULL_MS,
        urge: "danger",
        cry: "snf",
      },
    },
    { trait: "forages", with: { bush: ["bush"], berry: "berry", when: HUNGRY } },
    {
      trait: "sleeps",
      with: { while: { combinator: "and", rules: [FED, AT_DEN] }, spell: 1 },
    },
    { trait: "returns-home", with: { leash: 24 } },
    { trait: "unsticks", with: {} },
  ],
};

/** A step under the cave troll (100 hit points, Blunt 60, Toughness 66, 9 damage), and nature where it is fire. */
const BATTLER = {
  baseHp: 90,
  masteries: { sharp: 54, arcane: 6, toughness: 58, agility: 10 },
  naturalWeapon: {
    type: "weapon",
    name: "Claws",
    damage: 8,
    def: 0,
    accuracy: 82,
    variance: 30,
    spd: 34,
    reach: { cells: 1.5, height: 2 },
    mastery: "sharp",
  },
  sight: { up: 1, down: 1 },
  elements: ["nature"],
  immuneTo: ["food-poisoning"],
  kit: [
    {
      slot: "bag",
      tileId: "basic-bag",
      chance: 100,
      contents: [
        { tileId: "raw-meat", chance: 100 },
        { tileId: "raw-meat", chance: 50 },
        { tileId: "skin", chance: 80 },
      ],
    },
  ],
  spells: [
    {
      type: "stone",
      name: "Curl up",
      effect: { kind: "bolt", on: "caster", statuses: [{ id: "sleep", chance: 100 }] },
      cooldownMs: 1000,
    },
  ],
};

const bear = {
  id: "bear",
  name: "Bear",
  height: 3,
  type: "directional",
  kind: "battler",
  attributes: {},
  anchor: { tilesetId: TILESET_ID, x: 0, y: 0 },
  lightPassing: true,
  affectedByGravity: true,
  walkable: false,
  walkDurationMs: 280,
  sprites: facingFrames([0]),
  states: { moving: { sprites: facingFrames([0, 1, 0, 2]) } },
  interactions: { brain: BRAIN, battler: BATTLER, respawn: { fromMs: 240000, toMs: 420000 } },
} as TileDef;

const sheet = new PNG({ width: POSES.length * FRAME_PX, height: FACINGS.length * FRAME_PX });
sheet.data.fill(0);
FACINGS.forEach((facing, row) => {
  POSES.forEach((pose, column) => {
    castBear(facing, pose).forEach((index, n) => {
      if (index < 0) return;
      const x = column * FRAME_PX + (n % FRAME_PX);
      paint(sheet, x, row * FRAME_PX + Math.floor(n / FRAME_PX), index);
    });
  });
});

const previewDir = process.env.PREVIEW;
if (previewDir) {
  const scale = 8;
  const preview = new PNG({ width: sheet.width * scale, height: sheet.height * scale });
  const backdrop = paletteRgba(15);
  for (let y = 0; y < preview.height; y++) {
    for (let x = 0; x < preview.width; x++) {
      const from = (sheet.width * Math.floor(y / scale) + Math.floor(x / scale)) << 2;
      const to = (preview.width * y + x) << 2;
      const opaque = sheet.data[from + 3]! > 0;
      for (let c = 0; c < 4; c++) {
        preview.data[to + c] = opaque ? sheet.data[from + c]! : backdrop[c]!;
      }
    }
  }
  await Bun.write(path.join(previewDir, "bear.png"), PNG.sync.write(preview));
  const large = 6;
  for (const facing of FACINGS) {
    const cast = castModel({ sample: sampler(facing, POSES[0]!), shade }, PROJECTION, large);
    await writeCast(path.join(previewDir, `bear-${facing}.png`), cast, FRAME_PX * large);
  }
} else {
  await writeTileset(TILESET_ID, "Bear", sheet, [bear]);
}
