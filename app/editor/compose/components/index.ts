import type { Component, ComponentRegistry } from "../build";
import { cave } from "./cave";
import { clear } from "./clear";
import { dungeon, level } from "./dungeon";
import { fill } from "./fill";
import { forest } from "./forest";
import { grass } from "./grass";
import { group } from "./group";
import { hill } from "./hill";
import { cellar, floor, house, porch, roof } from "./house";
import { island } from "./island";
import { mask } from "./mask";
import { river } from "./river";
import { road } from "./road";
import { scatter } from "./scatter";
import { shipwreck } from "./shipwreck";
import { sea } from "./sea";
import { temple } from "./temple";
import { tile } from "./tile";
import { wall } from "./wall";

const all: ReadonlyArray<Component<never>> = [
  group,
  sea,
  island,
  hill,
  cave,
  dungeon,
  level,
  grass,
  forest,
  house,
  floor,
  cellar,
  roof,
  porch,
  temple,
  road,
  wall,
  river,
  tile,
  fill,
  scatter,
  shipwreck,
  mask,
  clear,
] as never;

export const COMPONENTS: ComponentRegistry = Object.fromEntries(all.map((c) => [c.type, c]));
