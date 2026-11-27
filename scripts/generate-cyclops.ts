import { PNG } from "pngjs";
import type { TileDef } from "../app/lib/types";
import { CYCLOPS } from "./cyclops-model";
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

const TILESET_ID = "cyclops";
const { px } = frameOf(CYCLOPS);
const frame = CYCLOPS.frame;

const sheet = new PNG({ width: posesOf(CYCLOPS).length * px, height: FACINGS.length * px });
sheet.data.fill(0);
paintBeast(sheet, CYCLOPS, 0);

/** Only the drawing: the cyclops's brain, battler, spells and respawn are authored in `tiles.json`. */
const cyclops = {
  id: CYCLOPS.id,
  name: CYCLOPS.name,
  type: "directional",
  anchor: { tilesetId: TILESET_ID, x: 0, y: 0 },
  sprites: facingFrames(0, [0], CYCLOPS.stepMs * 2, frame),
  states: { moving: { sprites: facingFrames(0, walkOf(CYCLOPS), CYCLOPS.stepMs, frame) } },
} as TileDef;

if (process.env.PREVIEW) {
  await writePreview(process.env.PREVIEW, TILESET_ID, sheet, [CYCLOPS] as Beast<string>[]);
} else {
  await writeTileset(TILESET_ID, "Cyclops", sheet, [cyclops]);
}
