import { describe, expect, it } from "vitest";
import type { DialogDef, DialogEffectDef } from "../lib/dialog";
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
    // A partner with nothing on them and nowhere to put anything, unless a
    // test says otherwise; effects run and succeed until one says they refuse.
    carries: () => false,
    roomFor: () => false,
    hasTag: () => false,
    hasStatus: () => false,
    attempt: () => true,
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

describe("a topic that asks and does", () => {
  const price: DialogEffectDef = {
    effect: "trade",
    take: [{ tileId: "shard", count: 14 }],
    give: [{ tileId: "potion", count: 1 }],
  };
  const shop: DialogDef = {
    ...seller,
    topics: [
      {
        hear: ["potion"],
        say: "Fourteen shards. Deal?",
        then: [
          {
            hear: ["yes"],
            if: { cond: "carries", tileId: "shard", count: 14 },
            do: [price],
            say: "Here you go.",
            else: "That's not fourteen shards.",
          },
        ],
      },
      {
        hear: ["secret"],
        if: { combinator: "and", not: true, rules: [{ cond: "has_tag", tag: "told" }] },
        do: [{ effect: "tag", tag: "told" }],
        say: "Just this once: the crystals remember the light.",
        else: "I told you already.",
      },
      { hear: ["quiet"], if: { cond: "has_status", statusId: "luminous" } , say: "You're glowing." },
    ],
  };

  function engagedIn(overrides: Partial<DialogView> = {}) {
    const view = room({ ann: near }, overrides);
    const memory = initialDialogMemory();
    view.heardLines.push({ speakerId: "ann", text: "hi" });
    converse(shop, memory, TICK_MS, view);
    return { view, memory };
  }

  function said(view: ReturnType<typeof room>, memory: ReturnType<typeof initialDialogMemory>, text: string) {
    view.heardLines.splice(0, view.heardLines.length, { speakerId: "ann", text });
    return converse(shop, memory, TICK_MS, view);
  }

  it("says the else line when the condition fails, and runs nothing", () => {
    const attempts: unknown[] = [];
    const { view, memory } = engagedIn({ attempt: (_id, effects) => (attempts.push(effects), true) });
    said(view, memory, "potion");
    expect(said(view, memory, "yes")).toEqual(["That's not fourteen shards."]);
    expect(attempts).toEqual([]);
    // The question is still open: the follow-ups stay live for another try.
    expect(memory.path).toEqual([0]);
  });

  it("runs the effects on the partner when the condition holds", () => {
    const attempts: Array<[string, readonly DialogEffectDef[]]> = [];
    const { view, memory } = engagedIn({
      carries: (id, tileId, count) => id === "ann" && tileId === "shard" && count === 14,
      attempt: (id, effects) => (attempts.push([id, effects]), true),
    });
    said(view, memory, "potion");
    expect(said(view, memory, "yes")).toEqual(["Here you go."]);
    expect(attempts).toEqual([["ann", [price]]]);
    expect(memory.path).toEqual([]);
  });

  it("says the else line when the effects are refused", () => {
    const { view, memory } = engagedIn({ carries: () => true, attempt: () => false });
    said(view, memory, "potion");
    expect(said(view, memory, "yes")).toEqual(["That's not fourteen shards."]);
  });

  it("composes conditions, and reads a tag its own effect wrote", () => {
    const tags = new Set<string>();
    const { view, memory } = engagedIn({
      hasTag: (_id, tag) => tags.has(tag),
      attempt: (_id, effects) => {
        for (const effect of effects) if (effect.effect === "tag") tags.add(effect.tag);
        return true;
      },
    });
    expect(said(view, memory, "secret")).toEqual(["Just this once: the crystals remember the light."]);
    expect(said(view, memory, "secret")).toEqual(["I told you already."]);
  });

  it("asks about a status", () => {
    const { view, memory } = engagedIn({ hasStatus: (_id, statusId) => statusId === "luminous" });
    expect(said(view, memory, "quiet")).toEqual(["You're glowing."]);
  });

  it("says nothing for a refusal with no else line", () => {
    const { view, memory } = engagedIn();
    const quietShop = { ...shop, topics: [{ hear: ["quiet"], if: { cond: "has_status" as const, statusId: "luminous" }, say: "You're glowing." }] };
    view.heardLines.splice(0, 1, { speakerId: "ann", text: "quiet" });
    expect(converse(quietShop, memory, TICK_MS, view)).toEqual([]);
  });
});
