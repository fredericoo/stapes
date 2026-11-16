import { describe, expect, it } from "vitest";
import { placeTalkBubble, TalkAnchorChannel, type TalkBubbleRequest } from "./talkBubble";

const base: TalkBubbleRequest = {
  anchor: { x: 300, headY: 400, feetY: 440 },
  view: { width: 600, height: 600 },
  size: { width: 200, height: 100 },
  brickPx: 2,
  marginPx: 16,
  liftPx: 50,
  tailPx: 8,
};

describe("placing the talk bubble", () => {
  it("hangs over the body, centred on it, its tail tip the lift above the head", () => {
    const at = placeTalkBubble(base);
    expect(at).toMatchObject({ left: 200, top: 242, side: "above" });
    expect(at.tail?.lean).toBe("none");
  });

  it("stays inside the margin beside the frame's edge, and leans the tail toward the body", () => {
    const at = placeTalkBubble({ ...base, anchor: { x: 590, headY: 400, feetY: 440 } });
    expect(at.left).toBe(600 - 16 - 200);
    expect(at.tail?.lean).toBe("right");
  });

  it("goes under a body it does not fit over", () => {
    const at = placeTalkBubble({ ...base, anchor: { x: 300, headY: 120, feetY: 160 } });
    expect(at).toMatchObject({ top: 168, side: "below" });
    expect(at.tail).not.toBeNull();
  });

  it("picks its side for the height it will grow to, and hangs at its present height", () => {
    const growing = { ...base, size: { width: 200, height: 40 } };
    expect(placeTalkBubble({ ...growing, settledHeight: 100 })).toMatchObject({
      top: 302,
      side: "above",
    });
    const higher = { ...growing, anchor: { x: 300, headY: 250, feetY: 290 } };
    expect(placeTalkBubble({ ...higher, settledHeight: 250 })).toMatchObject({
      top: 298,
      side: "below",
    });
  });

  it("drops the tail and keeps to the margin when it fits on neither side", () => {
    const tall = { width: 200, height: 568 };
    const at = placeTalkBubble({ ...base, size: tall });
    expect(at).toMatchObject({ top: 16, side: "none", tail: null });
    expect(at.top + tall.height).toBeLessThanOrEqual(600 - 16);
  });

  it("sits in the middle of the frame with no tail when the body is not drawn", () => {
    expect(placeTalkBubble({ ...base, anchor: null })).toEqual({
      left: 200,
      top: 250,
      side: "none",
      tail: null,
    });
  });
});

describe("the talk anchor channel", () => {
  it("hands a new listener the last anchor, and passes on only anchors that moved", () => {
    const channel = new TalkAnchorChannel();
    channel.publish({ x: 1, headY: 2, feetY: 3 });
    const seen: unknown[] = [];
    const stop = channel.listen((anchor) => seen.push(anchor));
    channel.publish({ x: 1, headY: 2, feetY: 3 });
    channel.publish({ x: 4, headY: 2, feetY: 3 });
    channel.publish(null);
    stop();
    channel.publish({ x: 9, headY: 9, feetY: 9 });
    expect(seen).toEqual([{ x: 1, headY: 2, feetY: 3 }, { x: 4, headY: 2, feetY: 3 }, null]);
  });
});
