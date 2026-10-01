import type { PlacedTile } from "./types";

export type FixtureCell = readonly [x: number, y: number, z: number, stack: PlacedTile[]];

const floor = (...more: PlacedTile[]): PlacedTile[] => [{ tileId: "grass-2" }, ...more];

/**
 * The tutorial's way out, in miniature: a corridor on level -1 from x 0 to 3
 * that ends at a pit, a floor on level -2 from x 4 to 8 with a ladder at its
 * end back up past the pit, and two ramps from x 10 north through a hole to
 * the surface at y -3 and -4. Real tiles, so the movement rules are the
 * game's own.
 */
export function fixtureTutorial({ ladder = true } = {}): FixtureCell[] {
  const cells: FixtureCell[] = [];
  for (let x = 0; x <= 3; x++) cells.push([x, 0, -1, floor()]);
  for (let x = 4; x <= 8; x++) cells.push([x, 0, -2, floor()]);
  if (ladder) {
    cells.push([8, 0, -2, floor({ tileId: "ladder-up" })]);
    cells.push([8, 0, -1, [{ tileId: "wooden-floor" }, { tileId: "ladder-top" }]]);
  }
  for (let x = 9; x <= 10; x++) cells.push([x, 0, -1, floor()]);
  cells.push([10, -1, -1, floor({ tileId: "cobblestone" }, { tileId: "ramp", direction: "s" })]);
  cells.push([10, -2, -1, floor({ tileId: "half-stone" }, { tileId: "ramp", direction: "s" })]);
  for (const y of [-3, -4]) {
    cells.push([10, y, -1, [{ tileId: "dirt" }, { tileId: "cave-wall-sloped" }]]);
    cells.push([10, y, 0, floor()]);
  }
  return cells;
}
