import { describe, expect, it } from "vitest";
import type { DialogDef, DialogEffectDef } from "../lib/dialog";
import {
  chooseOption,
  confirmAmount,
  goBack,
  openConversation,
  type Conversation,
  type PartnerView,
} from "./dialogRuntime";

/**
 * A conversation driven by hand, without a session.
 *
 * The functions are pure steps over (def, where you are, what was pressed);
 * these pin what a press does — where it leads, what is said, what is asked
 * of the partner, and what is left to press — against a partner built by hand.
 */

const price: DialogEffectDef = {
  effect: "trade",
  take: [{ tileId: "shard", count: 14 }],
  give: [{ tileId: "potion", count: 1 }],
};

const bottlePrice: DialogEffectDef = {
  effect: "trade",
  take: [{ tileId: "bottle", count: 1 }],
  give: [{ tileId: "shard", count: 2 }],
};

const shop: DialogDef = {
  opening: "Hello, {partner}.",
  options: [
    { label: "Recipe", say: "Ten crystals, one solution." },
    {
      label: "Buy a potion",
      say: "Fourteen shards. Deal?",
      then: [
        {
          label: "Yes",
          if: { cond: "carries", tileId: "shard", count: 14 },
          do: [price],
          say: "Here you go, {partner}.",
          else: "That's not fourteen shards.",
        },
        { label: "No", say: "Suit yourself." },
      ],
    },
    {
      label: "Sell bottles",
      amount: { min: 1, max: 12, prompt: "How many, {partner}?", confirm: "Sell" },
      if: { cond: "carries", tileId: "bottle", count: 1 },
      do: [bottlePrice],
      say: "Ta.",
      else: "You've no bottles.",
    },
    {
      label: "Secret",
      if: { combinator: "and", not: true, rules: [{ cond: "has_tag", tag: "told" }] },
      do: [{ effect: "tag", tag: "told" }],
      say: "Just this once.",
      else: "I told you already.",
    },
    { label: "Quiet", if: { cond: "has_status", statusId: "luminous" }, say: "You're glowing." },
  ],
};

const npc = { id: "npc:1", tileId: "seller" };

/** A partner with nothing on them, unless a test says otherwise. */
function partner(
  overrides: Partial<PartnerView> = {},
): PartnerView & { attempts: DialogEffectDef[][] } {
  const attempts: DialogEffectDef[][] = [];
  return {
    name: () => "ann",
    carries: () => false,
    roomFor: () => false,
    hasTag: () => false,
    hasStatus: () => false,
    attempt: (effects) => (attempts.push([...effects]), true),
    attempts,
    ...overrides,
  };
}

function open(view: PartnerView = partner()): Conversation {
  return openConversation(shop, npc, view);
}

function choose(at: Conversation, index: number, view: PartnerView) {
  return chooseOption(shop, at, index, view)!;
}

describe("opening and going back", () => {
  it("opens at the root with the opening line, named, asking", () => {
    expect(open()).toEqual({
      npcId: "npc:1",
      tileId: "seller",
      path: [],
      line: "Hello, ann.",
      stage: "asking",
    });
  });

  it("names a partner who has gone as someone", () => {
    expect(open(partner({ name: () => null })).line).toBe("Hello, someone.");
  });

  it("goes back one level, saying that reply again, and to the top from one deep", () => {
    const view = partner();
    const asked = choose(open(view), 1, view);
    const refused = choose(asked, 0, view);
    expect(refused).toMatchObject({ path: [1, 0], stage: "answered" });
    expect(goBack(shop, refused, view)).toEqual({ ...asked, path: [1], line: "Fourteen shards. Deal?", stage: "asking" });
    expect(goBack(shop, asked, view)).toEqual({ ...asked, path: [], line: "Hello, ann.", stage: "asking" });
  });

  it("goes back without asking or running anything", () => {
    const view = partner({ carries: () => true });
    const asked = choose(open(view), 1, view);
    const bought = choose(asked, 0, view);
    expect(view.attempts).toHaveLength(1);
    goBack(shop, bought, view);
    expect(view.attempts).toHaveLength(1);
  });
});

describe("pressing a button", () => {
  it("answers a leaf with its line, and leaves only Back", () => {
    const view = partner();
    expect(choose(open(view), 0, view)).toEqual({
      ...open(view),
      path: [0],
      line: "Ten crystals, one solution.",
      stage: "answered",
    });
  });

  it("descends into a reply's follow-ups", () => {
    const view = partner();
    const asked = choose(open(view), 1, view);
    expect(asked).toMatchObject({ path: [1], line: "Fourteen shards. Deal?", stage: "asking" });
    // The buttons on offer are now the follow-ups: index 1 is "No".
    expect(choose(asked, 1, view)).toMatchObject({ path: [1, 1], line: "Suit yourself.", stage: "answered" });
  });

  it("refuses a position nothing is at, and a press while not asking", () => {
    const view = partner();
    expect(chooseOption(shop, open(view), 9, view)).toBeNull();
    const leaf = choose(open(view), 0, view);
    expect(chooseOption(shop, leaf, 0, view)).toBeNull();
  });

  it("says the else line when the condition fails, runs nothing, and is a leaf", () => {
    const view = partner();
    const asked = choose(open(view), 1, view);
    const refused = choose(asked, 0, view);
    expect(refused).toMatchObject({ path: [1, 0], line: "That's not fourteen shards.", stage: "answered" });
    expect(view.attempts).toEqual([]);
  });

  it("runs the effects on the partner when the condition holds", () => {
    const view = partner({ carries: (tileId, count) => tileId === "shard" && count === 14 });
    const asked = choose(open(view), 1, view);
    expect(choose(asked, 0, view)).toMatchObject({ path: [1, 0], line: "Here you go, ann.", stage: "answered" });
    expect(view.attempts).toEqual([[price]]);
  });

  it("says the else line when the effects are refused", () => {
    const view = partner({ carries: () => true, attempt: () => false });
    const asked = choose(open(view), 1, view);
    expect(choose(asked, 0, view).line).toBe("That's not fourteen shards.");
  });

  it("keeps the last line when a refusal has nothing to say", () => {
    const view = partner();
    const opened = open(view);
    expect(choose(opened, 4, view)).toEqual({ ...opened, path: [4], stage: "answered" });
  });

  it("composes conditions, and reads a tag its own effect wrote", () => {
    const tags = new Set<string>();
    const view = partner({
      hasTag: (tag) => tags.has(tag),
      attempt: (effects) => {
        for (const effect of effects) if (effect.effect === "tag") tags.add(effect.tag);
        return true;
      },
    });
    expect(choose(open(view), 3, view).line).toBe("Just this once.");
    expect(choose(open(view), 3, view).line).toBe("I told you already.");
  });

  it("asks about a status", () => {
    const view = partner({ hasStatus: (id) => id === "luminous" });
    expect(choose(open(view), 4, view).line).toBe("You're glowing.");
  });
});

describe("an amount", () => {
  it("asks first, running nothing, and counts", () => {
    const view = partner();
    const asked = choose(open(view), 2, view);
    expect(asked).toMatchObject({ path: [2], line: "How many, ann?", stage: "counting" });
    expect(view.attempts).toEqual([]);
  });

  it("multiplies every count in the condition and the trade on confirm", () => {
    const counted: Array<[string, number]> = [];
    const view = partner({ carries: (tileId, count) => (counted.push([tileId, count]), true) });
    const asked = choose(open(view), 2, view);
    const sold = confirmAmount(shop, asked, 5, view)!;
    expect(sold).toMatchObject({ path: [2], line: "Ta.", stage: "answered" });
    expect(counted).toEqual([["bottle", 5]]);
    expect(view.attempts).toEqual([
      [{ effect: "trade", take: [{ tileId: "bottle", count: 5 }], give: [{ tileId: "shard", count: 10 }] }],
    ]);
  });

  it("is clamped to the author's range", () => {
    const view = partner({ carries: () => true });
    confirmAmount(shop, choose(open(view), 2, view), 40, view);
    expect(view.attempts[0]![0]).toMatchObject({ take: [{ tileId: "bottle", count: 12 }] });
  });

  it("refuses a confirm when nothing was asked, and a press while counting", () => {
    const view = partner();
    expect(confirmAmount(shop, open(view), 3, view)).toBeNull();
    const asked = choose(open(view), 2, view);
    expect(chooseOption(shop, asked, 0, view)).toBeNull();
  });

  it("says the else line and is a leaf when short", () => {
    const view = partner();
    const asked = choose(open(view), 2, view);
    expect(confirmAmount(shop, asked, 3, view)).toMatchObject({ line: "You've no bottles.", stage: "answered" });
  });
});
