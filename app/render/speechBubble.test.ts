import { describe, expect, it } from "vitest";
import { CHAT_LIFETIME_MS, MAX_CHAT_LENGTH } from "../net/chat";
import {
  BUBBLE_CLOSE_MS,
  TAIL_PIXELS,
  bubbleClosingMs,
  tailPlacement,
  typedLength,
} from "./speechBubble";

describe("typedLength", () => {
  it("shows the first character the moment the line is said", () => {
    expect(typedLength(5, 0)).toBe(1);
  });

  it("types a short line out one character at a time", () => {
    const lengths = [0, 40, 80, 120, 160, 200].map((ms) => typedLength(5, ms));
    expect(lengths).toEqual([1, 2, 3, 4, 5, 5]);
  });

  it("has the longest line typed out well before it disappears", () => {
    const halfLifeMs = CHAT_LIFETIME_MS / 2;
    expect(typedLength(MAX_CHAT_LENGTH, halfLifeMs)).toBe(MAX_CHAT_LENGTH);
  });
});

describe("tailPlacement", () => {
  const WIDTH_BRICKS = 40;

  it("points straight down at a speaker under the middle of the bubble", () => {
    const { leftBrick, lean } = tailPlacement(WIDTH_BRICKS, WIDTH_BRICKS / 2);
    expect(lean).toBe("none");
    expect(leftBrick + TAIL_PIXELS.none.tipColumn).toBe(WIDTH_BRICKS / 2);
  });

  it("leans toward a speaker off to one side and puts its tip over them", () => {
    const right = tailPlacement(WIDTH_BRICKS, 30);
    expect(right.lean).toBe("right");
    expect(right.leftBrick + TAIL_PIXELS.right.tipColumn).toBe(30);

    const left = tailPlacement(WIDTH_BRICKS, 8);
    expect(left.lean).toBe("left");
    expect(left.leftBrick + TAIL_PIXELS.left.tipColumn).toBe(8);
  });

  it("stays under the bubble when the screen edge pushed the bubble past its speaker", () => {
    const past = tailPlacement(WIDTH_BRICKS, WIDTH_BRICKS + 25);
    const tailWidth = TAIL_PIXELS.right.rows[0]!.length;
    expect(past.lean).toBe("right");
    expect(past.leftBrick + tailWidth).toBeLessThan(WIDTH_BRICKS);
  });
});

describe("bubbleClosingMs", () => {
  const closesAtMs = CHAT_LIFETIME_MS - BUBBLE_CLOSE_MS;

  it("keeps a bubble fully up until its last moments", () => {
    expect(bubbleClosingMs(0)).toBeUndefined();
    expect(bubbleClosingMs(closesAtMs - 1)).toBeUndefined();
  });

  it("is as far into closing as the newest line is into its last moments", () => {
    expect(bubbleClosingMs(closesAtMs)).toBe(0);
    expect(bubbleClosingMs(CHAT_LIFETIME_MS - 1)).toBe(BUBBLE_CLOSE_MS - 1);
  });
});
