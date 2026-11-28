import { PNG } from "pngjs";
import type { TileDef } from "../app/lib/types";
import { DEER } from "./deer-model";
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

const TILESET_ID = "deer";
const { px } = frameOf(DEER);
const frame = DEER.frame;

const sheet = new PNG({ width: posesOf(DEER).length * px, height: FACINGS.length * px });
sheet.data.fill(0);
paintBeast(sheet, DEER, 0);

/** Only the drawing: the deer's brain, battler and respawn are authored in `tiles.json`. */
const deer = {
  id: DEER.id,
  name: DEER.name,
  type: "directional",
  anchor: { tilesetId: TILESET_ID, x: 0, y: 0 },
  sprites: facingFrames(0, [0], DEER.stepMs * 2, frame),
  states: { moving: { sprites: facingFrames(0, walkOf(DEER), DEER.stepMs, frame) } },
} as TileDef;

if (process.env.PREVIEW) {
  await writePreview(process.env.PREVIEW, TILESET_ID, sheet, [DEER] as Beast<string>[]);
} else {
  await writeTileset(TILESET_ID, "Deer", sheet, [deer]);
}
