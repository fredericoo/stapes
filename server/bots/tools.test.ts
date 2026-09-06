import { describe, expect, it } from "bun:test";
import {
  BOT_TOOLS,
  MAX_GOAL_LENGTH,
  describeCall,
  parseBotCall,
} from "./tools";

/**
 * What a model is allowed to have asked for.
 *
 * The boundary, and it is a real one: a fast model producing a coordinate as a
 * string, or a fifth direction, or a tool that does not exist, is ordinary
 * rather than exceptional. What matters is that none of it reaches the world —
 * the frames a *parsed* action produces are checked against the protocol itself
 * in `./runner.test.ts`, which is the other half of this.
 */

describe("parsing a tool call", () => {
  it("takes the four tools", () => {
    expect(parseBotCall("walk_to", { x: 4, y: -2 })).toEqual({
      tool: "walk_to",
      x: 4,
      y: -2,
    });
    expect(parseBotCall("step", { direction: "n" })).toEqual({
      tool: "step",
      direction: "n",
    });
    expect(parseBotCall("say", { text: "hello" })).toEqual({
      tool: "say",
      text: "hello",
    });
    expect(parseBotCall("set_goal", { text: "find the shop" })).toEqual({
      tool: "set_goal",
      text: "find the shop",
    });
  });

  it("drops a call it cannot make sense of", () => {
    expect(parseBotCall("walk_to", { x: "4", y: 0 })).toBeNull();
    expect(parseBotCall("walk_to", { x: 1.5, y: 0 })).toBeNull();
    expect(parseBotCall("walk_to", {})).toBeNull();
    expect(parseBotCall("step", { direction: "up" })).toBeNull();
    expect(parseBotCall("say", { text: "" })).toBeNull();
    expect(parseBotCall("attack", { actorId: "rat" })).toBeNull();
    expect(parseBotCall("walk_to", null)).toBeNull();
  });

  it("refuses a goal too long to pin to every prompt", () => {
    // Refused rather than cut, because a goal is paid for on every decision for
    // as long as it stands and half a sentence is worse than none.
    expect(parseBotCall("set_goal", { text: "x".repeat(MAX_GOAL_LENGTH) })).not
      .toBeNull();
    expect(
      parseBotCall("set_goal", { text: "x".repeat(MAX_GOAL_LENGTH + 1) }),
    ).toBeNull();
  });

  it("offers exactly the four, each with something to read", () => {
    expect(BOT_TOOLS.map((tool) => tool.name)).toEqual([
      "walk_to",
      "step",
      "say",
      "set_goal",
    ]);
    for (const tool of BOT_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });
});

/**
 * The sentence a call is written down as.
 *
 * Written twice — into the event log by `./body`, and into the memory log by
 * `./memory` — so the two must be the same string or one act reads as two, and
 * the memory's own de-duplication stops working.
 */
describe("describing a call", () => {
  it("says what was asked for, in the second person", () => {
    expect(describeCall({ tool: "walk_to", x: 6, y: -1 })).toBe(
      "You set off for (6, -1).",
    );
    expect(describeCall({ tool: "step", direction: "e" })).toBe(
      "You stepped e.",
    );
    expect(describeCall({ tool: "say", text: "is anybody there" })).toBe(
      "You said: is anybody there",
    );
    expect(describeCall({ tool: "set_goal", text: "find the shop" })).toBe(
      "You set your goal: find the shop",
    );
  });
});
