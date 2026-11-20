import type { Component, ComponentRegistry } from "../build";
import { forest } from "./forest";
import { group } from "./group";
import { house } from "./house";
import { island } from "./island";
import { river } from "./river";
import { road } from "./road";
import { tile } from "./tile";

const all: ReadonlyArray<Component<never>> = [
  group,
  island,
  forest,
  house,
  road,
  river,
  tile,
] as never;

export const COMPONENTS: ComponentRegistry = Object.fromEntries(all.map((c) => [c.type, c]));
