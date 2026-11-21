import type { Component, ComponentRegistry } from "../build";
import { clear } from "./clear";
import { fill } from "./fill";
import { forest } from "./forest";
import { grass } from "./grass";
import { group } from "./group";
import { hill } from "./hill";
import { cellar, floor, house, roof } from "./house";
import { island } from "./island";
import { mask } from "./mask";
import { river } from "./river";
import { road } from "./road";
import { scatter } from "./scatter";
import { sea } from "./sea";
import { tile } from "./tile";

const all: ReadonlyArray<Component<never>> = [
  group,
  sea,
  island,
  hill,
  grass,
  forest,
  house,
  floor,
  cellar,
  roof,
  road,
  river,
  tile,
  fill,
  scatter,
  mask,
  clear,
] as never;

export const COMPONENTS: ComponentRegistry = Object.fromEntries(all.map((c) => [c.type, c]));
