import { PNG } from "pngjs";
import type { TileDef } from "../app/lib/types";
import {
  type Beast,
  FACINGS,
  FRAME_PX,
  facingFrames,
  paintBeast,
  posesOf,
  walkOf,
  writePreview,
} from "./quadruped-caster";
import { ANACONDA, COBRA, SNAKE } from "./snake-model";
import { writeTileset } from "./tileset-output";

const TILESET_ID = "snake";

const PREY = { type: "slot", data: { name: "prey" } };

/** Rears and spreads its hood with a hiss, spits venom from a few cells off, then closes to bite. */
const COBRA_BRAIN = {
  initial: "coiled",
  states: {
    coiled: { do: [{ action: "hold" }] },
    slither: { do: [{ action: "walk_n_steps", steps: 2 }] },
    striking: {
      onEnter: [{ effect: "noise", text: "HSSSS" }],
      do: [
        { action: "cast", spell: 1, of: PREY },
        { action: "attack", of: PREY },
        { action: "step_toward", of: PREY },
        { action: "hold" },
      ],
    },
  },
  transitions: [
    { from: "coiled", if: { cond: "after", ms: 3000 }, to: "slither" },
    { from: "slither", if: { cond: "stuck" }, to: "coiled" },
  ],
  traits: [
    {
      trait: "predator",
      with: {
        fight: "striking",
        prey: ["player", "rabbit", "rat"],
        within: 6,
        calm: 12,
        leash: 12,
        target: "prey",
      },
    },
  ],
};

const COBRA_BATTLER = {
  baseHp: 30,
  masteries: { sharp: 40, arcane: 16, toughness: 32, agility: 36 },
  naturalWeapon: {
    type: "weapon",
    name: "Venomous bite",
    damage: 6,
    def: 0,
    accuracy: 90,
    variance: 45,
    spd: 56,
    reach: { cells: 1.5, height: 2 },
    mastery: "sharp",
    statuses: [{ id: "poison", chance: 40, fromMs: 30000, toMs: 90000 }],
  },
  sight: { up: 0, down: 0 },
  elements: ["nature"],
  immuneTo: ["poison"],
  spells: [
    {
      type: "stone",
      name: "Spit venom",
      effect: {
        kind: "bolt",
        on: "target",
        statuses: [
          { id: "poison", chance: 100, fromMs: 20000, toMs: 40000 },
          { id: "dazed", chance: 60, fromMs: 3000, toMs: 5000 },
        ],
      },
      reach: { cells: 4.5, height: 2 },
      cooldownMs: 14000,
      castTimeMs: 600,
      sound: "ptth",
    },
  ],
  kit: [
    {
      slot: "bag",
      tileId: "basic-bag",
      chance: 100,
      contents: [
        { tileId: "essence-nature", chance: 3 },
        { tileId: "snake-fang", chance: 90 },
        { tileId: "snake-fang", chance: 90 },
      ],
    },
  ],
};

/**
 * Lies still where it was placed and takes what comes close: a body it can
 * reach in two cells, or anything that hits it. It squeezes its prey still,
 * crushes it, and goes back to lying in wait once the prey is off its ground.
 */
const ANACONDA_BRAIN = {
  initial: "lying",
  states: {
    lying: { do: [{ action: "hold" }] },
    gliding: { do: [{ action: "walk_n_steps", steps: 1 }] },
    crushing: {
      onEnter: [{ effect: "noise", text: "HHHSSS" }],
      do: [
        { action: "cast", spell: 1, of: PREY },
        { action: "attack", of: PREY },
        { action: "step_toward", of: PREY },
        { action: "hold" },
      ],
    },
  },
  transitions: [
    { from: "lying", if: { cond: "after", ms: 9000 }, to: "gliding" },
    { from: "gliding", if: { cond: "after", ms: 1500 }, to: "lying" },
    { from: "gliding", if: { cond: "stuck" }, to: "lying" },
  ],
  traits: [
    {
      trait: "predator",
      with: {
        fight: "crushing",
        prey: ["player", "deer", "boar", "rabbit", "raccoon"],
        within: 2,
        calm: 9,
        leash: 8,
        target: "prey",
      },
    },
  ],
};

const ANACONDA_BATTLER = {
  baseHp: 170,
  masteries: { blunt: 60, arcane: 12, toughness: 64, agility: 10 },
  naturalWeapon: {
    type: "weapon",
    name: "Coils",
    damage: 9,
    def: 0,
    accuracy: 82,
    variance: 30,
    spd: 30,
    reach: { cells: 1.5, height: 2 },
    mastery: "blunt",
  },
  sight: { up: 0, down: 0 },
  elements: ["nature"],
  immuneTo: ["food-poisoning"],
  spells: [
    {
      type: "stone",
      name: "Constrict",
      effect: {
        kind: "bolt",
        on: "target",
        damage: 12,
        variance: 30,
        statuses: [{ id: "paralysed", chance: 100, fromMs: 3000, toMs: 3500 }],
      },
      cooldownMs: 11000,
      castTimeMs: 800,
      sound: "*creak*",
    },
  ],
  kit: [
    {
      slot: "bag",
      tileId: "basic-bag",
      chance: 100,
      contents: [
        { tileId: "essence-nature", chance: 5 },
        { tileId: "snake-fang", chance: 90 },
        { tileId: "snake-fang", chance: 90 },
      ],
    },
  ],
};

function tileOf<P extends string>(beast: Beast<P>, firstRow: number, fields: Partial<TileDef>) {
  return {
    id: beast.id,
    name: beast.name,
    type: "directional",
    anchor: { tilesetId: TILESET_ID, x: 0, y: 0 },
    sprites: facingFrames(firstRow, [0], beast.stepMs * 2),
    states: { moving: { sprites: facingFrames(firstRow, walkOf(beast), beast.stepMs) } },
    ...fields,
  } as TileDef;
}

const creature = { kind: "battler", attributes: {}, lightPassing: true, affectedByGravity: true };

/**
 * Only the snake's drawing is generated; its brain, battler and respawn are
 * authored in `tiles.json`. For the cobra and the anaconda the ones here are
 * what a new tile starts with, and a re-run leaves those in `tiles.json` alone.
 */
const tiles = [
  tileOf(SNAKE, 0, {}),
  tileOf(COBRA, FACINGS.length, {
    ...creature,
    height: 1,
    walkDurationMs: 260,
    swims: true,
    interactions: {
      brain: COBRA_BRAIN,
      battler: COBRA_BATTLER,
      respawn: { fromMs: 90000, toMs: 300000 },
    },
  } as Partial<TileDef>),
  tileOf(ANACONDA, 2 * FACINGS.length, {
    ...creature,
    height: 2,
    walkable: false,
    walkDurationMs: 360,
    swims: true,
    interactions: {
      brain: ANACONDA_BRAIN,
      battler: ANACONDA_BATTLER,
      respawn: { fromMs: 240000, toMs: 420000 },
    },
  } as Partial<TileDef>),
];

const BEASTS = [SNAKE, COBRA, ANACONDA] as Beast<string>[];

const sheet = new PNG({
  width: Math.max(...BEASTS.map((beast) => posesOf(beast).length)) * FRAME_PX,
  height: BEASTS.length * FACINGS.length * FRAME_PX,
});
sheet.data.fill(0);
BEASTS.forEach((beast, b) => paintBeast(sheet, beast, b * FACINGS.length));

if (process.env.PREVIEW) {
  await writePreview(process.env.PREVIEW, TILESET_ID, sheet, BEASTS);
} else {
  await writeTileset(TILESET_ID, "Snakes", sheet, tiles);
}
