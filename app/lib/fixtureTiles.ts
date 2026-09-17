/**
 * The tile catalogue the unit suite runs against.
 *
 * `data/tiles.json` is authored content, edited from the tile editor as much
 * as by hand, and a test that read it went red on content edits that had
 * nothing to do with the code. This is a snapshot of the shapes that file
 * has, under the ids `fixtureTown` and the generator tests place, carrying
 * only the fields the code under test reads: heights, `lightPassing`,
 * `intangible`, `walkable`, the emitter light on a torch and a lamppost, a
 * brain and a battler on the animals, and the item blocks a kit is built
 * from. Art is one placeholder frame per face, except the torch, which has
 * two so its light flickers.
 *
 * Tests whose subject is the shipped content — the balance between the real
 * weapons and creatures, or that a consumable does what it is authored to do —
 * still read `data/tiles.json`, because a fixture would test the fixture.
 */
import { AUTOTILE_SLICE_COUNT, normalizeTileDef } from "./types";
import type {
  AutotileSlice,
  Frame,
  LightDef,
  Octant,
  TileDef,
  TileSprite,
} from "./types";
import type { BattlerDef } from "./battler";
import type { BrainDef } from "./brain";
import type { Masteries, WeaponMastery } from "./mastery";
import { tilesByIdFromList } from "./validation";

/** The sheet every fixture tile is cut from. No such file exists. */
export const FIXTURE_TILESET_ID = "fixture-tiles";

const DIRECTIONS: Octant[] = ["n", "e", "s", "w"];
const OCTANTS: Octant[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

/** Frame length of a tile that does not say otherwise. */
const FIXTURE_FRAME_MS = 200;

function frame(durationMs: number, light?: LightDef): Frame {
  return {
    sprite: { rect: { x: 0, y: 0, w: 1, h: 1 }, base: { x: 0, y: 0 } },
    durationMs,
    ...(light ? { light } : {}),
  };
}

/** One frame per light given; one unlit frame when none is. */
function sprite(lights: Array<LightDef | undefined>, durationMs: number): TileSprite {
  return { frames: lights.map((light) => frame(durationMs, light)) };
}

export type FixtureTileInput = Partial<Omit<TileDef, "id" | "height">> &
  Pick<TileDef, "id" | "height"> & {
    /**
     * An emitter on every frame, for the torch and the lamppost. A list makes
     * one frame per entry, so two entries at different intensities flicker.
     */
    light?: LightDef | LightDef[];
    /** How long each frame shows. */
    frameMs?: number;
  };

/**
 * One tile in the current encoding, with placeholder art for its type.
 *
 * Defaults are a simple, walkable, solid prop named after its id. Anything
 * passed in wins, so a test that needs one odd field sets only that.
 */
export function fixtureTile(input: FixtureTileInput): TileDef {
  const { light, frameMs = FIXTURE_FRAME_MS, ...rest } = input;
  const lights = Array.isArray(light) ? light : [light];
  const type = rest.type ?? "simple";
  const art: Partial<TileDef> = {};
  if (type === "directional" || type === "directional8") {
    const sprites: Partial<Record<Octant, TileSprite>> = {};
    for (const o of type === "directional" ? DIRECTIONS : OCTANTS) {
      sprites[o] = sprite(lights, frameMs);
    }
    art.sprites = sprites;
  } else if (type === "autotile") {
    const slices: Partial<Record<AutotileSlice, TileSprite>> = {};
    for (let i = 0; i < AUTOTILE_SLICE_COUNT; i++) slices[i] = sprite(lights, frameMs);
    art.slices = slices;
  } else if (type === "scatter") {
    art.scatter = [sprite(lights, frameMs), sprite(lights, frameMs)];
  } else if (type === "variant") {
    art.variants = rest.variants ?? { default: sprite(lights, frameMs) };
  } else {
    art.sprite = sprite(lights, frameMs);
  }
  return normalizeTileDef({
    name: rest.id,
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: FIXTURE_TILESET_ID, x: 0, y: 0 },
    ...art,
    ...rest,
    type,
  });
}

/** The light a torch or a lamppost casts: the radius the bake is budgeted at. */
export const FIXTURE_LIGHT: LightDef = { radius: 8, intensity: 1, color: "#ffcc88" };

/**
 * The torch's two frames, the same radius at two intensities, so it flickers
 * its light and nothing else. That is what the phase-keyed bake is tested on.
 */
export const FIXTURE_FLICKER: LightDef[] = [FIXTURE_LIGHT, { ...FIXTURE_LIGHT, intensity: 0.95 }];

/** Length of each torch frame. */
export const FIXTURE_FLICKER_FRAME_MS = 180;

/** A brain that stands still, for a body that only has to be a body. */
const HOLDING_BRAIN: BrainDef = {
  initial: "idle",
  states: { idle: { do: [{ action: "hold" }] } },
  transitions: [],
};

function battlerOf(baseHp: number, masteries: Masteries, weapon: string): BattlerDef {
  const mastery: WeaponMastery = "sharp";
  return {
    baseHp,
    masteries,
    naturalWeapon: {
      type: "weapon",
      name: weapon,
      damage: 2,
      def: 0,
      accuracy: 80,
      variance: 30,
      spd: 60,
      reach: { cells: 1.5, height: 2 },
      mastery,
    },
    sight: { up: 0, down: 0 },
  };
}

/**
 * The catalogue, in the order `data/tiles.json` groups things: ground, walls
 * and roofs, doors, props, lights, bodies, items.
 */
export const FIXTURE_TILES: TileDef[] = [
  // Ground.
  fixtureTile({ id: "grass", height: 0 }),
  fixtureTile({ id: "grass-2", name: "Grass", height: 0 }),
  fixtureTile({ id: "dirt", height: 0, type: "autotile", connectsTo: ["half-stone", "hole"] }),
  fixtureTile({ id: "cobblestone", height: 0, type: "scatter" }),
  fixtureTile({ id: "wooden-floor", height: 0, type: "autotile", connectsTo: ["hole"] }),
  fixtureTile({ id: "water", height: 0, type: "autotile", lightPassing: true, walkable: false }),
  fixtureTile({ id: "hole", height: 0, type: "variant", lightPassing: true, intangible: true }),
  fixtureTile({ id: "pressure-plate", height: 0, interactions: { pressurePlate: { tileId: "pressure-plate-pressed", type: "gte", height: 1 }, emit: { value: "off" } } }),
  fixtureTile({ id: "pressure-plate-pressed", height: 0, interactions: { pressurePlate: { tileId: "pressure-plate", type: "lte", height: 0 }, emit: { value: "on" } } }),

  // Walls, at the two heights that divide a level.
  fixtureTile({ id: "half-stone", height: 2 }),
  fixtureTile({ id: "brick-slab", height: 2 }),
  fixtureTile({ id: "stone-wall", height: 4 }),
  fixtureTile({ id: "brick-wall", height: 4, type: "autotile", walkable: false, connectsTo: ["window-1"] }),
  fixtureTile({ id: "sw2", name: "Wall", height: 4, type: "autotile", walkable: false, connectsTo: ["window-1", "half-wall"] }),
  fixtureTile({ id: "half-wall", height: 2, type: "autotile", walkable: false, connectsTo: ["sw2"] }),
  fixtureTile({ id: "window-1", height: 4, type: "directional", lightPassing: true, walkable: false }),

  // Roofs: full-height ones are intangible so a body can stand under them.
  fixtureTile({ id: "roof-1", height: 4, type: "directional", intangible: true }),
  fixtureTile({ id: "roof-4", height: 4, type: "directional", intangible: true }),
  fixtureTile({ id: "roof-3", height: 2, type: "directional" }),
  fixtureTile({ id: "roof-6", height: 2, type: "directional" }),
  fixtureTile({ id: "plaster", height: 2 }),

  // A door, switched between its two tiles.
  fixtureTile({ id: "door-closed", height: 4, type: "directional", walkable: false, interactions: { switch: { targetTileId: "door-open", actionName: "Open" }, receive: { tileId: "door-open", when: "on", mode: "any" } } }),
  fixtureTile({ id: "door-open", height: 4, type: "directional", lightPassing: true, intangible: true, walkable: false, interactions: { switch: { targetTileId: "door-closed", actionName: "Close" }, receive: { tileId: "door-closed", when: "off", mode: "all" } } }),

  // Props.
  fixtureTile({ id: "tree", height: 4, walkable: false }),
  fixtureTile({ id: "small-bush", height: 2, lightPassing: true, walkable: false }),
  fixtureTile({ id: "bush", height: 2, walkable: false, interactions: { extract: { actionName: "Pick", durability: 3, tileId: "small-bush", durationMs: 2000, slots: [{ tileId: "berry", chance: 100 }] } } }),
  fixtureTile({ id: "sign", height: 2, type: "directional", walkable: false }),
  fixtureTile({ id: "barrel", height: 3 }),
  fixtureTile({ id: "wooden-box", height: 2, affectedByGravity: true, interactions: { push: { climb: "half", moveOnTileIds: ["dirt", "pressure-plate", "pressure-plate-pressed"] } } }),

  // Lights.
  fixtureTile({ id: "torch", height: 4, type: "directional", lightPassing: true, intangible: true, light: FIXTURE_FLICKER, frameMs: FIXTURE_FLICKER_FRAME_MS }),
  fixtureTile({ id: "lamppost", height: 4, lightPassing: true, walkable: false, light: FIXTURE_LIGHT }),

  // Bodies.
  fixtureTile({
    id: "player",
    height: 3,
    type: "directional",
    kind: "battler",
    lightPassing: true,
    affectedByGravity: true,
    walkable: false,
    interactions: {
      battler: {
        ...battlerOf(12, { fist: 5, sharp: 5, blunt: 5, ranged: 5, arcane: 5, toughness: 5, agility: 10 }, "Bare hands"),
        kit: [{ slot: "bag", tileId: "basic-bag", chance: 100 }],
      },
    },
  }),
  fixtureTile({ id: "cat", height: 2, kind: "battler", lightPassing: true, affectedByGravity: true, interactions: { brain: HOLDING_BRAIN, battler: battlerOf(8, { sharp: 9, toughness: 7, agility: 28 }, "Claws") } }),
  fixtureTile({ id: "deer", height: 4, type: "directional", kind: "battler", lightPassing: true, affectedByGravity: true, walkable: false, walkDurationMs: 170, interactions: { brain: HOLDING_BRAIN, battler: battlerOf(8, { toughness: 8, agility: 24 }, "Hooves") } }),
  fixtureTile({ id: "rat", height: 1, type: "directional", kind: "battler", lightPassing: true, affectedByGravity: true, walkDurationMs: 150, interactions: { brain: HOLDING_BRAIN, battler: battlerOf(8, { sharp: 4, toughness: 3, agility: 24 }, "Teeth") } }),
  fixtureTile({ id: "wolf", height: 2, type: "directional", kind: "battler", lightPassing: true, affectedByGravity: true, walkable: false, walkDurationMs: 140, interactions: { brain: HOLDING_BRAIN, battler: battlerOf(8, { sharp: 30, toughness: 22, agility: 30 }, "Fangs") } }),

  // Items.
  fixtureTile({ id: "rusty-sword", height: 0, kind: "item", lightPassing: true, intangible: true, affectedByGravity: true, interactions: { item: { type: "weapon", damage: 6, def: 0, accuracy: 86, variance: 40, spd: 52, reach: { cells: 1.5, height: 2 }, mastery: "sharp", requirements: { sharp: 5 } } } }),
  fixtureTile({ id: "basic-bag", height: 0, kind: "item", lightPassing: true, intangible: true, affectedByGravity: true, interactions: { item: { type: "container", size: 4, equippable: true } } }),
  fixtureTile({ id: "berry", height: 0, kind: "item", lightPassing: true, interactions: { item: { type: "consumable", label: "Eat", hp: 0, statuses: [{ id: "fed", fromMs: 10_000, toMs: 30_000 }], pile: 12 } } }),
  fixtureTile({ id: "arrow", height: 0, type: "directional8", lightPassing: true, intangible: true }),
];

export const fixtureTilesById: Record<string, TileDef> = tilesByIdFromList(FIXTURE_TILES);
