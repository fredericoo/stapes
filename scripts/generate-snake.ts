import { PNG } from "pngjs";
import type { TileDef } from "../app/lib/types";
import {
  type Beast,
  FACINGS,
  FRAME_PX,
  facingFrames,
  paintBeast,
  posesOf,
  walkOf,
  writePreview,
} from "./quadruped-caster";
import { SNAKE } from "./snake-model";
import { writeTileset } from "./tileset-output";

const TILESET_ID = "snake";

const sheet = new PNG({
  width: posesOf(SNAKE).length * FRAME_PX,
  height: FACINGS.length * FRAME_PX,
});
sheet.data.fill(0);
paintBeast(sheet, SNAKE, 0);

/** Only the drawing: the snake's brain, battler and respawn are authored in `tiles.json`. */
const snake = {
  id: SNAKE.id,
  name: SNAKE.name,
  type: "directional",
  anchor: { tilesetId: TILESET_ID, x: 0, y: 0 },
  sprites: facingFrames(0, [0], SNAKE.stepMs * 2),
  states: { moving: { sprites: facingFrames(0, walkOf(SNAKE), SNAKE.stepMs) } },
} as TileDef;

if (process.env.PREVIEW) {
  await writePreview(process.env.PREVIEW, TILESET_ID, sheet, [SNAKE] as Beast<string>[]);
} else {
  await writeTileset(TILESET_ID, "Snake", sheet, [snake]);
}
