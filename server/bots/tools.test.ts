import { describe, expect, it } from "bun:test";
import { BOT_TOOLS, parseBotAction } from "./tools";

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
  it("takes the three tools", () => {
    expect(parseBotAction("walk_to", { x: 4, y: -2 })).toEqual({
      tool: "walk_to",
      x: 4,
      y: -2,
    });
    expect(parseBotAction("step", { direction: "n" })).toEqual({
      tool: "step",
      direction: "n",
    });
    expect(parseBotAction("say", { text: "hello" })).toEqual({
      tool: "say",
      text: "hello",
    });
  });

  it("drops a call it cannot make sense of", () => {
    expect(parseBotAction("walk_to", { x: "4", y: 0 })).toBeNull();
    expect(parseBotAction("walk_to", { x: 1.5, y: 0 })).toBeNull();
    expect(parseBotAction("walk_to", {})).toBeNull();
    expect(parseBotAction("step", { direction: "up" })).toBeNull();
    expect(parseBotAction("say", { text: "" })).toBeNull();
    expect(parseBotAction("attack", { actorId: "rat" })).toBeNull();
    expect(parseBotAction("walk_to", null)).toBeNull();
  });

  it("offers exactly the three, each with something to read", () => {
    expect(BOT_TOOLS.map((tool) => tool.name)).toEqual([
      "walk_to",
      "step",
      "say",
    ]);
    for (const tool of BOT_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });
});
