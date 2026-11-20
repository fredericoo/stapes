import type { Component, ComponentRegistry } from "../build";
import { forest } from "./forest";
import { house } from "./house";
import { island } from "./island";
import { river } from "./river";
import { road } from "./road";

const all: ReadonlyArray<Component<never>> = [island, forest, house, road, river] as never;

export const COMPONENTS: ComponentRegistry = Object.fromEntries(all.map((c) => [c.type, c]));
