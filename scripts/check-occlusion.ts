/**
 * PROTOTYPE — does `visibleFrom` actually see what it should?
 *
 * The bench's numbers are worthless if the set is wrong, and "wrong" here has
 * two shapes that both look plausible in a summary: a set that is empty reads
 * as a wonderful saving, and a set that is everything reads as a fast flood.
 * These are the four cases that tell them apart, on maps built by hand.
 */
import { emptyMap, replaceStack } from "../app/lib/mapData";
import { normalizeTileDef, type MapFile, type TileDef } from "../app/lib/types";
import { tilesByIdFromList } from "../app/lib/validation";
import { cellKey3, visibleFrom } from "../app/net/visibleSet";

const TILES: TileDef[] = [
  normalizeTileDef({ id: "grass", name: "grass", tileset: "t", index: 0, height: 0 }),
  normalizeTileDef({ id: "wall", name: "wall", tileset: "t", index: 0, height: 4 }),
];
const tilesById = tilesByIdFromList(TILES);

/** A floor of grass over a square, with anything else laid on top. */
function floor(half: number, extra: Array<[number, number, string]> = []): MapFile {
  let map = emptyMap();
  for (let x = -half; x <= half; x++) {
    for (let y = -half; y <= half; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  for (const [x, y, tileId] of extra) {
    map = replaceStack(map, x, y, 0, [{ tileId: "grass" }, { tileId }]);
  }
  return map;
}

let failures = 0;
function check(what: string, got: boolean, want: boolean) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
}

const here = { x: 0, y: 0, z: 0 };

// 1. Open ground: everything in reach is visible, and the reach binds.
{
  const map = floor(20);
  const { visible } = visibleFrom(map, tilesById, here, 8);
  check("open ground sees its own cell", visible.has(cellKey3(0, 0, 0)), true);
  check("open ground sees 8 cells away", visible.has(cellKey3(8, 0, 0)), true);
  check("open ground stops at the reach", visible.has(cellKey3(9, 0, 0)), false);
}

// 2. A wall: the wall is seen, what is directly behind it is not.
{
  const map = floor(20, [[3, 0, "wall"]]);
  const { visible } = visibleFrom(map, tilesById, here, 8);
  check("the wall itself is seen", visible.has(cellKey3(3, 0, 0)), true);
  check("the cell behind the wall is not", visible.has(cellKey3(4, 0, 0)), false);
  check("beside the wall still is", visible.has(cellKey3(4, 3, 0)), true);
}

// 3. A sealed room: nothing outside it is visible, which is the whole point.
{
  const walls: Array<[number, number, string]> = [];
  for (let d = -2; d <= 2; d++) {
    walls.push([d, -2, "wall"], [d, 2, "wall"], [-2, d, "wall"], [2, d, "wall"]);
  }
  const map = floor(20, walls);
  const { visible } = visibleFrom(map, tilesById, here, 16);
  check("a sealed room sees its own floor", visible.has(cellKey3(1, 1, 0)), true);
  check("a sealed room sees its walls", visible.has(cellKey3(2, 0, 0)), true);
  check("a sealed room sees nothing outside", visible.has(cellKey3(6, 0, 0)), false);
  // The flood cannot leak around a ring, so the whole set is the room.
  check("and nothing else at all", visible.size <= 25, true);
}

// 4. A hole in the floor: you see down it, and not through solid ground.
{
  let map = floor(20);
  // A cave floor under everything...
  for (let x = -6; x <= 6; x++) {
    for (let y = -6; y <= 6; y++) {
      map = replaceStack(map, x, y, -1, [{ tileId: "grass" }]);
    }
  }
  // ...and one cell of the surface taken away, two cells east.
  map = replaceStack(map, 2, 0, 0, []);
  const { visible } = visibleFrom(map, tilesById, here, 8);
  check("the cave under the hole is seen", visible.has(cellKey3(2, 0, -1)), true);
  check("the cave under solid ground is not", visible.has(cellKey3(6, 6, -1)), false);
}

console.log(failures === 0 ? "\nall good\n" : `\n${failures} failed\n`);
if (failures > 0) process.exit(1);
