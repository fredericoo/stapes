import { PNG } from "pngjs";
import type { TileDef } from "../app/lib/types";
import {
  type Beast,
  FACINGS,
  FRAME_PX,
  facingFrames,
  paintBeast,
  POSES_PER_BEAST,
  writePreview,
} from "./quadruped-caster";
import { writeTileset } from "./tileset-output";

const TILESET_ID = "forest-beasts";

type BoarPart = "coat" | "ridge" | "snout" | "disc" | "leg" | "hoof" | "ear";

/**
 * A wild boar: a wedge, deepest at the shoulders under a dark bristled ridge,
 * narrowing through a low-slung head to a long snout with a flat disc at the
 * end. The rump is lower and smaller than the shoulders, and the legs are
 * short and thin under all that weight.
 */
const BOAR: Beast<BoarPart> = {
  id: "boar",
  name: "Boar",
  size: 1,
  topPx: 11,
  trunk: [
    { part: "coat", at: [-3.4, 0, 4.4], radii: [2.6, 2.4, 1.9] },
    { part: "coat", at: [-1, 0, 5.0], radii: [3.0, 2.7, 2.3] },
    {
      part: "coat",
      at: [1.8, 0, 5.6],
      radii: [2.6, 2.7, 2.9],
      marking: (_along, across, up) => (up > 7.2 && Math.abs(across) < 1.2 ? "ridge" : null),
    },
    { part: "coat", at: [4.4, 0, 4.3], radii: [1.9, 1.9, 2.0] },
    { part: "ear", at: [3.7, -1.3, 6.4], radii: [0.6, 0.6, 0.8] },
    { part: "ear", at: [3.7, 1.3, 6.4], radii: [0.6, 0.6, 0.8] },
    { part: "snout", at: [6.3, 0, 3.5], radii: [1.5, 1.05, 1.05] },
    { part: "disc", at: [7.6, 0, 3.5], radii: [0.45, 0.95, 0.9] },
  ],
  legs: [
    [2.2, 1.5],
    [2.2, -1.5],
    [-3.4, 1.5],
    [-3.4, -1.5],
  ],
  hipUp: 4.2,
  thigh: 1.15,
  knee: 0.8,
  foot: 0.8,
  footShare: 0.25,
  fur: "leg",
  footPart: "hoof",
  stride: 1.3,
  shade: (part, band) => {
    if (part === "disc") return 14;
    if (part === "hoof") return 0;
    if (part === "ridge") return [0, 0, 0][band]!;
    if (part === "snout") return [22, 8, 4][band]!;
    if (part === "ear" || part === "leg") return [2, 0, 0][band]!;
    return [22, 8, 2][band]!;
  },
  marks: [
    { at: [4.8, 1.2, 5.1], index: 0, side: [0.5, 1, 0.3] },
    { at: [4.8, -1.2, 5.1], index: 0, side: [0.5, -1, 0.3] },
    { at: [6.6, 1.2, 3.9], index: 28, side: [0.2, 1, 0.3] },
    { at: [6.6, -1.2, 3.9], index: 28, side: [0.2, -1, 0.3] },
  ],
  stepMs: 110,
};

type RaccoonPart =
  | "coat"
  | "tail"
  | "belly"
  | "face"
  | "mask"
  | "muzzle"
  | "nose"
  | "ear"
  | "leg"
  | "paw"
  | "ring";

/** The ringed tail: a dark band every this many pixels along it. */
const RING_PX = 1.2;

function ringed(along: number): RaccoonPart | null {
  return Math.floor(-along / RING_PX) % 2 === 0 ? "ring" : null;
}

/**
 * A raccoon: a hunched grey body higher at the rump than the shoulders, a
 * broad head with a pale muzzle and the black mask across the eyes, and a
 * bushy tail as long as the body in dark rings. Lower than the boar, about a
 * cat's size.
 */
const RACCOON: Beast<RaccoonPart> = {
  id: "raccoon",
  name: "Raccoon",
  size: 1.2,
  topPx: 9,
  trunk: [
    { part: "tail", at: [-7.0, 0, 4.4], radii: [1.0, 1.0, 1.0], marking: ringed },
    { part: "tail", at: [-5.6, 0, 4.0], radii: [1.3, 1.2, 1.2], marking: ringed },
    { part: "tail", at: [-4.0, 0, 3.5], radii: [1.4, 1.3, 1.3], marking: ringed },
    { part: "coat", at: [-1.5, 0, 3.1], radii: [2.1, 1.9, 1.8] },
    {
      part: "coat",
      at: [0.9, 0, 2.8],
      radii: [1.9, 1.8, 1.7],
      marking: (_along, _across, up) => (up < 1.6 ? "belly" : null),
    },
    {
      part: "face",
      at: [2.9, 0, 3.0],
      radii: [1.4, 1.6, 1.4],
      marking: (along, _across, up) => (along > 3.0 && up > 2.7 && up < 3.6 ? "mask" : null),
    },
    { part: "ear", at: [2.5, -1.1, 4.3], radii: [0.5, 0.5, 0.6] },
    { part: "ear", at: [2.5, 1.1, 4.3], radii: [0.5, 0.5, 0.6] },
    { part: "muzzle", at: [4.2, 0, 2.6], radii: [0.9, 0.75, 0.7] },
    { part: "nose", at: [5.0, 0, 2.7], radii: [0.4, 0.4, 0.4] },
  ],
  legs: [
    [1.2, 1.1],
    [1.2, -1.1],
    [-2.3, 1.1],
    [-2.3, -1.1],
  ],
  hipUp: 2.4,
  thigh: 0.85,
  knee: 0.6,
  foot: 0.6,
  footShare: 0.35,
  fur: "leg",
  footPart: "paw",
  stride: 0.9,
  shade: (part, band) => {
    if (part === "nose" || part === "mask" || part === "paw") return 0;
    if (part === "ring") return [1, 0, 0][band]!;
    if (part === "tail") return [27, 25, 22][band]!;
    if (part === "muzzle" || part === "face") return [28, 27, 25][band]!;
    if (part === "ear") return [22, 4, 1][band]!;
    if (part === "belly") return [22, 8, 4][band]!;
    if (part === "leg") return [4, 1, 0][band]!;
    return [22, 8, 4][band]!;
  },
  marks: [],
  stepMs: 90,
};

const PREY = { type: "slot", data: { name: "prey" } };

/**
 * The boar roots about its patch and leaves people alone unless they come
 * within a few cells, when it goes for them. A target that backs off past
 * three cells gets charged, as the bear charges, and the charge leaves it
 * winded so it cannot charge again at once.
 */
const BOAR_BRAIN = {
  initial: "rooting",
  states: {
    rooting: {
      do: [
        { action: "wait", ms: 1500 },
        { action: "walk_n_steps", steps: 2 },
      ],
    },
    goring: {
      onEnter: [{ effect: "noise", text: "GRUNT", style: "shake" }],
      do: [{ action: "attack", of: PREY }, { action: "step_toward", of: PREY }, { action: "hold" }],
    },
    charging: {
      band: "danger",
      do: [{ action: "cast", spell: 1 }, { action: "step_toward", of: PREY }, { action: "hold" }],
    },
  },
  triggers: [
    {
      band: "danger",
      if: {
        combinator: "and",
        rules: [
          { cond: "out_of_range", of: PREY, cells: 3 },
          { cond: "in_los", of: PREY, cells: 8 },
          { combinator: "and", not: true, rules: [{ cond: "status", id: "winded" }] },
        ],
      },
      to: "charging",
    },
  ],
  transitions: [{ from: "charging", if: { cond: "after", ms: 0 }, to: "goring" }],
  traits: [
    { trait: "evades-the-unreachable", with: {} },
    { trait: "fights-back", with: { fight: "goring", target: "prey", calm: 10 } },
    {
      trait: "hunts-on-sight",
      with: { prey: ["player"], within: 3, fight: "goring", target: "prey", calm: 10 },
    },
    {
      trait: "eats-when-hungry",
      with: { food: ["apple", "berry", "rotten-apple", "stale-berry"], cry: "snf" },
    },
    { trait: "forages", with: { bush: ["bush"], berry: "berry" } },
    { trait: "returns-home", with: { leash: 12 } },
    { trait: "unsticks", with: {} },
  ],
};

/** Between the rat (Sharp 4, Toughness 3) and the wolf (Sharp 30, Toughness 22), and slower and heavier than either. */
const BOAR_BATTLER = {
  baseHp: 24,
  masteries: { blunt: 18, arcane: 4, toughness: 22, agility: 10 },
  naturalWeapon: {
    type: "weapon",
    name: "Tusks",
    damage: 3,
    def: 0,
    accuracy: 82,
    variance: 40,
    spd: 42,
    reach: { cells: 1.5, height: 2 },
    mastery: "blunt",
  },
  sight: { up: 0, down: 0 },
  immuneTo: ["food-poisoning"],
  kit: [
    {
      slot: "bag",
      tileId: "basic-bag",
      chance: 100,
      contents: [
        { tileId: "boar-tusk", chance: 70 },
        { tileId: "raw-meat", chance: 100 },
        { tileId: "raw-meat", chance: 40 },
        { tileId: "skin", chance: 50 },
      ],
    },
  ],
  spells: [
    {
      type: "stone",
      name: "Charge",
      effect: {
        kind: "bolt",
        on: "caster",
        statuses: [
          { id: "charging", chance: 100 },
          { id: "winded", chance: 100 },
        ],
      },
      cooldownMs: 10000,
      sound: "snort",
    },
  ],
};

/**
 * The raccoon is a thief, not a fighter: it goes for any food it sees lying
 * about, picks bushes, and runs from anybody rated past it. A player weaker
 * than that it turns on when hit, and it gives up a fight once it is hurt.
 */
const RACCOON_BRAIN = {
  initial: "snuffling",
  states: {
    snuffling: { do: [{ action: "walk_n_steps", steps: 3 }] },
    sniffing: { do: [{ action: "walk_n_steps", steps: 1 }] },
    scratching: {
      onEnter: [{ effect: "noise", text: "hsss" }],
      do: [
        { action: "attack", of: PREY },
        { action: "step_toward", of: PREY, allowDrops: true },
        { action: "hold" },
      ],
    },
  },
  transitions: [
    { from: "snuffling", if: { cond: "stuck" }, to: "sniffing" },
    { from: "sniffing", if: { cond: "after", ms: 900 }, to: "snuffling" },
  ],
  traits: [
    {
      trait: "flees-the-stronger",
      with: { threats: ["player"], sight: 6, below: 16, cry: "chrr!" },
    },
    { trait: "flees-when-hurt", with: { threat: "prey", below: 30, near: 8, cry: "eek" } },
    { trait: "fights-back", with: { fight: "scratching", target: "prey", calm: 8 } },
    { trait: "scavenges", with: { cry: "chitter" } },
    { trait: "forages", with: { bush: ["bush"], berry: "berry" } },
    { trait: "returns-home", with: { leash: 12 } },
  ],
};

/** A step above the rat in every mastery, and quick: hard to hit more than hard-hitting. */
const RACCOON_BATTLER = {
  baseHp: 10,
  masteries: { sharp: 9, arcane: 3, toughness: 8, agility: 26 },
  naturalWeapon: {
    type: "weapon",
    name: "Claws",
    damage: 2,
    def: 0,
    accuracy: 82,
    variance: 60,
    spd: 56,
    reach: { cells: 1.5, height: 2 },
    mastery: "sharp",
  },
  sight: { up: 1, down: 1 },
  immuneTo: ["food-poisoning"],
  kit: [
    { slot: "offhand", tileId: "bread", chance: 10 },
    { slot: "weapon", tileId: "apple", chance: 10 },
    {
      slot: "bag",
      tileId: "basic-bag",
      chance: 100,
      contents: [
        { tileId: "raccoon-tail", chance: 70 },
        { tileId: "skin", chance: 20 },
      ],
    },
  ],
};

function tileOf<P extends string>(
  beast: Beast<P>,
  firstRow: number,
  fields: Partial<TileDef>,
): TileDef {
  return {
    id: beast.id,
    name: beast.name,
    type: "directional",
    kind: "battler",
    attributes: {},
    anchor: { tilesetId: TILESET_ID, x: 0, y: 0 },
    lightPassing: true,
    affectedByGravity: true,
    walkable: false,
    sprites: facingFrames(firstRow, [0], beast.stepMs * 2),
    states: { moving: { sprites: facingFrames(firstRow, [0, 1, 0, 2], beast.stepMs) } },
    ...fields,
  } as TileDef;
}

const tiles = [
  tileOf(BOAR, 0, {
    height: 2,
    walkDurationMs: 170,
    interactions: {
      brain: BOAR_BRAIN,
      battler: BOAR_BATTLER,
      respawn: { fromMs: 150000, toMs: 300000 },
    },
  } as Partial<TileDef>),
  tileOf(RACCOON, FACINGS.length, {
    height: 1,
    walkDurationMs: 150,
    swims: true,
    interactions: {
      brain: RACCOON_BRAIN,
      battler: RACCOON_BATTLER,
      respawn: { fromMs: 90000, toMs: 180000 },
    },
  } as Partial<TileDef>),
];

const BEASTS = [BOAR, RACCOON] as Beast<string>[];

const sheet = new PNG({
  width: POSES_PER_BEAST * FRAME_PX,
  height: BEASTS.length * FACINGS.length * FRAME_PX,
});
sheet.data.fill(0);
BEASTS.forEach((beast, b) => paintBeast(sheet, beast, b * FACINGS.length));

if (process.env.PREVIEW) {
  await writePreview(process.env.PREVIEW, TILESET_ID, sheet, BEASTS);
} else {
  await writeTileset(TILESET_ID, "Forest beasts", sheet, tiles);
}
