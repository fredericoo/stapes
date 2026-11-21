import { describe, expect, it } from "vitest";
import type { Bounds } from "../generator";
import { PIN_X, PIN_Y, type Frame } from "./doc";
import { frameBounds, frameFor, pointFor, pointIn } from "./layout";

const parent: Bounds = { minX: -10, minY: 4, maxX: 29, maxY: 33 };
const dragged: Bounds = { minX: -3, minY: 20, maxX: 8, maxY: 26 };

describe("dragging a box writes back a frame that keeps its pins", () => {
  it.each(PIN_X.flatMap((pinX) => PIN_Y.map((pinY) => [pinX, pinY] as const)))(
    "pinned %s and %s",
    (pinX, pinY) => {
      const frame: Frame = { x: 1, y: 1, w: 4, h: 4, pinX, pinY };
      const written = frameFor(frame, dragged, parent);
      expect(written.pinX).toBe(pinX);
      expect(written.pinY).toBe(pinY);
      expect(frameBounds(written, parent)).toEqual(dragged);
      expect(pointIn(pointFor({ x: 0, y: 0, pinX, pinY }, { x: 5, y: 9 }, parent), parent)).toEqual(
        {
          x: 5,
          y: 9,
        },
      );
    },
  );
});
