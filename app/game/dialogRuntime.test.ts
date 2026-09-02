import { describe, expect, it } from "vitest";
import type { DialogDef } from "../lib/dialog";
import type { Coord } from "../lib/types";
import type { Utterance } from "./brainRuntime";
import {
  converse,
  initialDialogMemory,
  isTalking,
  type DialogView,
} from "./dialogRuntime";

/**
 * A conversation driven by hand, without a session.
 *
 * `converse` is a pure step over what was heard; these pin its rules — who is
 * answered, which topics are live, and what ends it — against a fixed room.
 */

const TICK_MS = 150;

const seller: DialogDef = {
  cells: 4,
  los: true,
  idleMs: 30_000,
  greet: { hear: ["hi", "hello"], say: "Hello, {partner}." },
  busy: "One moment, I'm with {partner}.",
  bye: { hear: ["bye"], say: "See you, {partner}." },
  topics: [
    { hear: ["recipe", "how"], say: "Ten crystals, one solution." },
    {
      hear: ["potion", "buy"],
      say: "Fourteen shards. Deal?",
      then: [
        { hear: ["yes"], say: "Here you go." },
        { hear: ["no"], say: "Suit yourself." },
      ],
    },
    { hear: ["bottle"], say: "Two shards a bottle." },
  ],
};

/** Everybody on open ground, the seller at the origin. */
function room(
  positions: Record<string, Coord | null>,
  overrides: Partial<DialogView> = {},
): DialogView & { heardLines: Utterance[] } {
  const heardLines: Utterance[] = [];
  return {
    self: { x: 0, y: 0, z: 0 },
    sight: { up: 0, down: 0 },
    positionOf: (id) => positions[id] ?? null,
    canSee: () => true,
    nameOf: (id) => id,
    heard: () => heardLines,
    heardLines,
    ...overrides,
  };
}

/** One tick in which these things were said. */
function tick(
  view: ReturnType<typeof room>,
  memory: ReturnType<typeof initialDialogMemory>,
  ...lines: Array<[string, string]>
): string[] {
  view.heardLines.splice(0, view.heardLines.length, ...lines.map(([speakerId, text]) => ({ speakerId, text })));
  return converse(seller, memory, TICK_MS, view);
}

const near = { x: 2, y: 0, z: 0 };
const far = { x: 9, y: 0, z: 0 };

describe("starting a conversation", () => {
  it("answers a greeting from somebody in earshot, and takes them as partner", () => {
    const view = room({ ann: near });
    const memory = initialDialogMemory();
    expect(tick(view, memory, ["ann", "Hi there"])).toEqual(["Hello, ann."]);
    expect(memory.partnerId).toBe("ann");
    expect(isTalking(memory)).toBe(true);
  });

  it("ignores a greeting shouted from too far away", () => {
    const view = room({ ann: far });
    const memory = initialDialogMemory();
    expect(tick(view, memory, ["ann", "hi"])).toEqual([]);
    expect(isTalking(memory)).toBe(false);
  });

  it("ignores a greeting through a wall when line of sight is asked for", () => {
    const view = room({ ann: near }, { canSee: () => false });
    const memory = initialDialogMemory();
    expect(tick(view, memory, ["ann", "hi"])).toEqual([]);
  });

  it("hears through a wall when it is not", () => {
    const view = room({ ann: near }, { canSee: () => false });
    const memory = initialDialogMemory();
    expect(converse({ ...seller, los: false }, memory, TICK_MS, view)).toEqual([]);
    view.heardLines.push({ speakerId: "ann", text: "hi" });
    expect(converse({ ...seller, los: false }, memory, TICK_MS, view)).toEqual(["Hello, ann."]);
  });

  it("ignores a topic word from somebody who has not greeted", () => {
    const view = room({ ann: near });
    const memory = initialDialogMemory();
    expect(tick(view, memory, ["ann", "potion"])).toEqual([]);
  });

  it("takes the first of two greeters, and tells the second it is busy", () => {
    const view = room({ ann: near, bob: near });
    const memory = initialDialogMemory();
    expect(tick(view, memory, ["ann", "hi"], ["bob", "hello"])).toEqual([
      "Hello, ann.",
      "One moment, I'm with ann.",
    ]);
  });
});

describe("mid-conversation", () => {
  function engaged(positions: Record<string, Coord | null> = { ann: near }) {
    const view = room(positions);
    const memory = initialDialogMemory();
    tick(view, memory, ["ann", "hi"]);
    return { view, memory };
  }

  it("answers the first topic whose word it hears, in authored order", () => {
    const { view, memory } = engaged();
    // "buy" and "recipe" are both in the sentence; the recipe topic is first.
    expect(tick(view, memory, ["ann", "how do I buy the recipe"])).toEqual([
      "Ten crystals, one solution.",
    ]);
  });

  it("says nothing to a sentence it has no topic for", () => {
    const { view, memory } = engaged();
    expect(tick(view, memory, ["ann", "nice weather"])).toEqual([]);
    expect(isTalking(memory)).toBe(true);
  });

  it("makes a reply's follow-ups live, and answers one", () => {
    const { view, memory } = engaged();
    tick(view, memory, ["ann", "potion"]);
    expect(memory.path).toEqual([1]);
    expect(tick(view, memory, ["ann", "yes"])).toEqual(["Here you go."]);
    expect(memory.path).toEqual([]);
  });

  it("does not answer a follow-up word before its question", () => {
    const { view, memory } = engaged();
    expect(tick(view, memory, ["ann", "yes"])).toEqual([]);
  });

  it("lets a root topic through while a follow-up is live", () => {
    const { view, memory } = engaged();
    tick(view, memory, ["ann", "potion"]);
    expect(tick(view, memory, ["ann", "bottle"])).toEqual(["Two shards a bottle."]);
    expect(memory.path).toEqual([]);
  });

  it("tries the follow-ups before the root", () => {
    const withClash: DialogDef = {
      ...seller,
      topics: [
        { hear: ["potion"], say: "Deal?", then: [{ hear: ["potion"], say: "Another?" }] },
      ],
    };
    const view = room({ ann: near });
    const memory = initialDialogMemory();
    view.heardLines.push({ speakerId: "ann", text: "hi" });
    converse(withClash, memory, TICK_MS, view);
    view.heardLines.splice(0, 1, { speakerId: "ann", text: "potion" });
    expect(converse(withClash, memory, TICK_MS, view)).toEqual(["Deal?"]);
    expect(converse(withClash, memory, TICK_MS, view)).toEqual(["Another?"]);
  });

  it("only answers the partner", () => {
    const { view, memory } = engaged({ ann: near, bob: near });
    expect(tick(view, memory, ["bob", "potion"])).toEqual([]);
    expect(tick(view, memory, ["bob", "hi"], ["bob", "hello"])).toEqual([
      "One moment, I'm with ann.",
    ]);
  });

  it("stays quiet to a stranger when there is no busy line", () => {
    const view = room({ ann: near, bob: near });
    const memory = initialDialogMemory();
    const quiet = { ...seller, busy: undefined };
    view.heardLines.push({ speakerId: "ann", text: "hi" });
    converse(quiet, memory, TICK_MS, view);
    view.heardLines.splice(0, 1, { speakerId: "bob", text: "hi" });
    expect(converse(quiet, memory, TICK_MS, view)).toEqual([]);
  });

  it("names a partner who has gone as someone", () => {
    const { view, memory } = engaged({ ann: near, bob: near });
    view.nameOf = () => null;
    expect(tick(view, memory, ["bob", "hi"])).toEqual(["One moment, I'm with someone."]);
  });
});

describe("ending a conversation", () => {
  function engaged(positions: Record<string, Coord | null> = { ann: near }) {
    const view = room(positions);
    const memory = initialDialogMemory();
    tick(view, memory, ["ann", "hi"]);
    return { view, memory };
  }

  it("says goodbye when the partner does, and is free again", () => {
    const { view, memory } = engaged({ ann: near, bob: near });
    expect(tick(view, memory, ["ann", "bye"])).toEqual(["See you, ann."]);
    expect(isTalking(memory)).toBe(false);
    expect(tick(view, memory, ["bob", "hi"])).toEqual(["Hello, bob."]);
  });

  it("forgets a partner who falls silent, without a word", () => {
    const { view, memory } = engaged();
    const ticks = Math.ceil(seller.idleMs / TICK_MS);
    for (let i = 0; i < ticks; i++) expect(tick(view, memory)).toEqual([]);
    expect(isTalking(memory)).toBe(false);
  });

  it("keeps a partner who keeps talking", () => {
    const { view, memory } = engaged();
    const ticks = Math.ceil(seller.idleMs / TICK_MS);
    for (let i = 0; i < ticks; i++) tick(view, memory, ["ann", "hm"]);
    expect(isTalking(memory)).toBe(true);
  });

  it("forgets a partner who walks out of earshot", () => {
    const positions: Record<string, Coord | null> = { ann: near };
    const { view, memory } = engaged(positions);
    positions.ann = far;
    expect(tick(view, memory, ["ann", "potion"])).toEqual([]);
    expect(isTalking(memory)).toBe(false);
  });

  it("forgets a partner who left the world", () => {
    const positions: Record<string, Coord | null> = { ann: near };
    const { view, memory } = engaged(positions);
    positions.ann = null;
    tick(view, memory);
    expect(isTalking(memory)).toBe(false);
  });

  it("drops the follow-ups with the conversation", () => {
    const { view, memory } = engaged();
    tick(view, memory, ["ann", "potion"]);
    tick(view, memory, ["ann", "bye"]);
    tick(view, memory, ["ann", "hi"]);
    expect(tick(view, memory, ["ann", "yes"])).toEqual([]);
  });
});
