import { getStack } from "../lib/mapData";
import type { MapFile } from "../lib/types";
import { ResidentIds } from "./actors";

/** The id adoption gave the body standing in a cell, read off the board. */
export function residentAt(session: { getMap(): MapFile }, x: number, y: number, z = 0): string {
  const owner = getStack(session.getMap(), x, y, z).find((placed) => placed.owner)?.owner;
  if (!owner) throw new Error(`nobody stands at ${x}, ${y}, ${z}`);
  return owner;
}

/** The id adoption gives the first body it finds on a board that names nobody yet. */
export function firstResidentId(): string {
  return new ResidentIds(() => false).mint();
}
