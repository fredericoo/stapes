import { PNG } from "pngjs";
import type { TileDef } from "../app/lib/types";
import {
  type Beast,
  FACINGS,
  facingFrames,
  frameOf,
  paintBeast,
  posesOf,
  walkOf,
  writePreview,
} from "./quadruped-caster";
import { writeTileset } from "./tileset-output";
import { CAVE_TROLL, TROLLS } from "./troll-model";

const TILESET_ID = "trolls";
const { px } = frameOf(CAVE_TROLL);
const frame = CAVE_TROLL.frame;

const sheet = new PNG({
  width: posesOf(CAVE_TROLL).length * px,
  height: TROLLS.length * FACINGS.length * px,
});
sheet.data.fill(0);
TROLLS.forEach((troll, i) => paintBeast(sheet, troll, i * FACINGS.length));

/** Only the drawing: each troll's brain, battler and spells are authored in `tiles.json`. */
const tiles = TROLLS.map((troll, i) => {
  const firstRow = i * FACINGS.length;
  return {
    id: troll.id,
    name: troll.name,
    type: "directional",
    anchor: { tilesetId: TILESET_ID, x: 0, y: 0 },
    sprites: facingFrames(firstRow, [0], troll.stepMs * 2, frame),
    states: { moving: { sprites: facingFrames(firstRow, walkOf(troll), troll.stepMs, frame) } },
  } as TileDef;
});

if (process.env.PREVIEW) {
  await writePreview(process.env.PREVIEW, TILESET_ID, sheet, TROLLS as Beast<string>[]);
} else {
  await writeTileset(TILESET_ID, "Trolls", sheet, tiles);
}
