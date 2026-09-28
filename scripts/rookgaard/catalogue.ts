import type { Direction, PlacedTile } from "../../app/lib/types";
import { FLAG, GROUP, type ItemType } from "./itemTypes";

export type Ground =
  | "grass"
  | "dirt"
  | "mud"
  | "gravel"
  | "paving"
  | "street"
  | "wood"
  | "bridge"
  | "water"
  | "rock"
  | "earth";

export type WallTile = "sw2" | "brick-wall";

/** Which way the wall an item stands in runs, where the item says. A corner piece does not. */
export type Runs = "horizontal" | "vertical" | null;

export type Part =
  | { kind: "ground"; ground: Ground }
  | { kind: "descent" }
  | { kind: "ropeSpot" }
  | { kind: "coast" }
  | { kind: "wall"; tileId: WallTile; runs: Runs }
  | { kind: "window"; runs: Runs }
  | { kind: "door"; open: boolean; runs: Runs }
  | { kind: "rock" }
  | { kind: "stairs"; climb: Direction; tileId: "stone-stairs" | "ramp" }
  | { kind: "ladder" }
  | { kind: "grate" }
  | { kind: "portal" }
  | { kind: "thing"; stack: PlacedTile[] }
  | { kind: "sign" }
  | { kind: "flowers" }
  | { kind: "hanging"; tileId: "torch" | "sign" }
  | { kind: "raisedFloor" }
  | { kind: "roof"; tiled: boolean }
  | { kind: "ignore" }
  | { kind: "unknown"; name: string };

/** What each dry ground becomes at the bottom of a stack. */
export const GROUND_STACK: Record<
  Exclude<Ground, "rock" | "earth" | "water" | "bridge">,
  PlacedTile[]
> = {
  grass: [{ tileId: "grass-2" }],
  dirt: [{ tileId: "dirt" }],
  mud: [{ tileId: "mud" }],
  gravel: [{ tileId: "dirt" }, { tileId: "cobblestone" }],
  paving: [{ tileId: "dirt" }, { tileId: "cobblestone" }],
  street: [{ tileId: "grass-2" }, { tileId: "cobblestone" }],
  wood: [{ tileId: "wooden-floor" }],
};

/**
 * Water is laid on a floor, as every pond and stream in the authored world is.
 * The floor shows through the transparent edges of the shore, and it seals the
 * column: water lets light through, so without it daylight pours through the
 * sea into any cave Tibia runs underneath.
 */
export function waterStack(level: number, bridged = false): PlacedTile[] {
  const stack: PlacedTile[] = [{ tileId: level < 0 ? "dirt" : "grass-2" }, { tileId: "water" }];
  if (bridged) stack.push({ tileId: "wooden-floor" });
  return stack;
}

export const ROCK: PlacedTile[] = [{ tileId: "half-stone" }, { tileId: "half-stone" }];

const GROUND_BY_NAME: Record<string, Ground> = {
  grass: "grass",
  flowers: "grass",
  dirt: "dirt",
  sand: "dirt",
  "earth ground": "dirt",
  "dirt floor": "dirt",
  "small hole": "dirt",
  "muddy floor": "mud",
  swamp: "mud",
  gravel: "gravel",
  "rock soil": "gravel",
  "stone pile": "gravel",
  "cobbled pavement": "street",
  "stone floor": "paving",
  "stone tile": "paving",
  "white marble floor": "paving",
  "black marble floor": "paving",
  "wooden floor": "wood",
  drawbridge: "bridge",
  "shallow water": "water",
  water: "water",
  earth: "earth",
  "dirt wall": "rock",
  "stone wall": "rock",
  mountain: "rock",
};

const TREES = new Set([
  "fir tree",
  "small fir tree",
  "sycamore",
  "willow",
  "plum tree",
  "pear tree",
  "beech",
  "poplar",
  "dwarf tree",
  "dead tree",
  "palm",
  "pine",
  "oak",
  "birch",
  "cypress",
  "jungle tree",
]);

const PLANTS = new Set([
  "bush",
  "dry bush",
  "wheat",
  "shadow plant",
  "branch",
  "mire sprout",
  "moon herb",
  "mud whip",
  "swamp reed",
  "swamp lilly",
  "dusk catcher",
  "bog fingers plant",
  "lady in the fog plant",
  "frog leaf",
  "sludge fern",
  "fern",
  "indoor plant",
  "flower bowl",
  "honey flower",
]);

const FLOWERS = new Set(["moonflowers", "moon flower", "white flower", "heaven blossom"]);

const HANGING_LIGHTS = new Set(["lit wall lamp", "lit torch bearer", "wall lamp", "torch bearer"]);

/**
 * A Tibia chair rotates through four ids a quarter turn at a time. The first
 * id is taken to face south and the turn to go clockwise, which is a guess
 * nothing in the item files confirms.
 */
const CHAIR_FACING: Record<number, Direction> = { 1650: "s", 1651: "w", 1652: "n", 1653: "e" };

const OBJECTS: Record<string, PlacedTile[]> = {
  table: [{ tileId: "table" }],
  "big table": [{ tileId: "table" }],
  "small table": [{ tileId: "table" }],
  bed: [{ tileId: "table" }],
  cot: [{ tileId: "table" }],
  counter: [{ tileId: "counter-top" }],
  bench: [{ tileId: "stool" }],
  stool: [{ tileId: "stool" }],
  wardrobe: [{ tileId: "wooden-shelf" }],
  bookcase: [{ tileId: "wooden-shelf" }],
  drawers: [{ tileId: "wooden-shelf" }],
  cupboard: [{ tileId: "wooden-shelf" }],
  box: [{ tileId: "wooden-box" }],
  crate: [{ tileId: "wooden-box" }],
  chest: [{ tileId: "wooden-box" }],
  "water wheel": [{ tileId: "wooden-box" }],
  barrel: [{ tileId: "barrel" }],
  "water cask": [{ tileId: "barrel" }],
  "wine cask": [{ tileId: "barrel" }],
  "beer cask": [{ tileId: "barrel" }],
  trough: [{ tileId: "barrel" }],
  dustbin: [{ tileId: "barrel" }],
  "draw well": [{ tileId: "barrel" }],
  oven: [{ tileId: "counter-top" }],
  anvil: [{ tileId: "anvil" }],
  "coal basin": [{ tileId: "barrel" }, { tileId: "flame" }],
  "street lamp": [{ tileId: "lamppost" }],
  campfire: [{ tileId: "flame" }],
  "fire field": [{ tileId: "flame" }],
  statue: [{ tileId: "rock-pillar" }],
  "goblin statue": [{ tileId: "rock-pillar" }],
  "marble pillar": [{ tileId: "rock-pillar" }],
  stalagmites: [{ tileId: "rock-pillar" }],
  millstone: [{ tileId: "half-stone" }],
  "blueberry bush": [{ tileId: "bush" }],
  "wooden railing": [{ tileId: "fence" }],
  fence: [{ tileId: "fence" }],
  bars: [{ tileId: "fence" }],
  "stone railing": [{ tileId: "half-wall" }],
};

const IGNORED = new Set([
  "stone archway",
  "buttress",
  "grave",
  "lever",
  "tapestry",
  "red carpet",
  "flag of tibia",
  "rocks",
  "void",
]);

const STAIRS_FLAGS: [number, Direction][] = [
  [FLAG.floorChangeNorth, "n"],
  [FLAG.floorChangeEast, "e"],
  [FLAG.floorChangeSouth, "s"],
  [FLAG.floorChangeWest, "w"],
];

function climbOf(type: ItemType | undefined): Direction | null {
  if (!type) return null;
  for (const [flag, direction] of STAIRS_FLAGS) if (type.flags & flag) return direction;
  return null;
}

/**
 * Sorts one Tibia item into what it becomes here. It reads names rather than
 * ids so one table covers every variant of a thing, and the flags only where a
 * name cannot say it: which way a staircase climbs, whether something is ground.
 */
export function classify(type: ItemType | undefined): Part {
  if (!type) return { kind: "unknown", name: "" };
  const name = type.name;
  const runs: Runs =
    type.flags & FLAG.vertical ? "vertical" : type.flags & FLAG.horizontal ? "horizontal" : null;

  if (type.group === GROUP.ground) {
    if (type.flags & FLAG.floorChangeDown) return { kind: "descent" };
    if (type.description?.startsWith("There is a hole in the ceiling")) return { kind: "ropeSpot" };
    if (name === "flat roof" || name === "tiled roof")
      return { kind: "roof", tiled: name === "tiled roof" };
    const ground = GROUND_BY_NAME[name];
    return ground ? { kind: "ground", ground } : { kind: "unknown", name };
  }

  if (type.flags & FLAG.alwaysOnTop && type.topOrder === 1) {
    return name === "shallow water" ? { kind: "coast" } : { kind: "ignore" };
  }

  const climb = climbOf(type);
  if (climb) {
    return { kind: "stairs", climb, tileId: name === "ramp" ? "ramp" : "stone-stairs" };
  }

  if (name === "ladder") return { kind: "ladder" };
  if (name === "sewer grate") return { kind: "grate" };
  if (type.group === GROUP.teleport) return { kind: "portal" };
  if (type.group === GROUP.door) return { kind: "door", open: name.startsWith("open"), runs };
  if (name.includes("window")) return { kind: "window", runs };
  if (name === "brick wall") return { kind: "wall", tileId: "brick-wall", runs };
  if (name === "dirt wall" || name === "mountain") return { kind: "rock" };
  if (name.endsWith(" wall")) return { kind: "wall", tileId: "sw2", runs };
  if (name === "wooden floor" && type.flags & FLAG.blockSolid) return { kind: "raisedFloor" };
  if (name === "flat roof" || name === "tiled roof")
    return { kind: "roof", tiled: name === "tiled roof" };

  if (name === "sign") return { kind: "sign" };
  if (name === "blackboard") return { kind: "hanging", tileId: "sign" };
  if (HANGING_LIGHTS.has(name)) return { kind: "hanging", tileId: "torch" };
  if (type.flags & FLAG.hangable) return { kind: "ignore" };

  if (TREES.has(name) || name.endsWith(" tree"))
    return { kind: "thing", stack: [{ tileId: "tree" }] };
  if (PLANTS.has(name)) return { kind: "thing", stack: [{ tileId: "small-bush" }] };
  if (FLOWERS.has(name)) return { kind: "flowers" };
  if (name === "wooden chair" || name === "chair") {
    return { kind: "thing", stack: [{ tileId: "chair", direction: CHAIR_FACING[type.id] ?? "s" }] };
  }
  const object = OBJECTS[name];
  if (object) return { kind: "thing", stack: object };
  if (IGNORED.has(name)) return { kind: "ignore" };

  if (
    (name === "stone" || name === "debris" || name === "mossy stone" || name === "stone pile") &&
    type.flags & FLAG.blockSolid
  ) {
    return { kind: "thing", stack: [{ tileId: "half-stone" }] };
  }
  if (type.flags & (FLAG.pickupable | FLAG.moveable)) return { kind: "ignore" };
  if (!(type.flags & FLAG.blockSolid)) return { kind: "ignore" };
  return { kind: "unknown", name };
}

/**
 * Rookgaard's monsters, each put down as the creature here nearest it in size
 * and threat. The humanoids all become the bog imp, which is the one creature
 * with a weapon and a bag; they live underground, which keeps the campfires it
 * lights at night off the forests.
 */
export const CREATURE_TILES: Record<string, string> = {
  rat: "rat",
  "cave rat": "rat",
  bug: "rat",
  rotworm: "rat",
  snake: "snake",
  spider: "snake",
  "poison spider": "snake",
  wolf: "wolf",
  "war wolf": "wolf",
  bear: "wolf",
  dog: "wolf",
  deer: "deer",
  sheep: "deer",
  rabbit: "rabbit",
  chicken: "rabbit",
  bat: "bat",
  wasp: "bat",
  troll: "bog-imp",
  orc: "bog-imp",
  "orc spearman": "bog-imp",
  goblin: "bog-imp",
  elf: "bog-imp",
  skeleton: "bog-imp",
  ghoul: "bog-imp",
  minotaur: "cave-troll",
};

/** The shopkeepers whose trade matches one of ours. Nobody else has a counterpart. */
export const NPC_TILES: Record<string, string> = {
  Obi: "blacksmith",
  Dixi: "armourer",
  "Al Dee": "torch-salesman",
  Hyacinth: "potion-salesman",
  Willie: "pie-maker",
};
