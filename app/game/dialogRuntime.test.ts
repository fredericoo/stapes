import { describe, expect, it } from "vitest";
import type { DialogDef, DialogEffectDef } from "../lib/dialog";
import {
  backToRoot,
  chooseOption,
  openConversation,
  type Conversation,
  type PartnerView,
} from "./dialogRuntime";

/**
 * A conversation driven by hand, without a session.
 *
 * The functions are pure steps over (def, where you are, what was pressed);
 * these pin what a press does — where it leads, what is said, what is asked
 * of the partner — against a partner built by hand.
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
      amount: { min: 1, max: 12 },
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

describe("opening and going back", () => {
  it("opens at the root with the opening line, named", () => {
    expect(open()).toEqual({ npcId: "npc:1", tileId: "seller", path: [], line: "Hello, ann." });
  });

  it("names a partner who has gone as someone", () => {
    expect(open(partner({ name: () => null })).line).toBe("Hello, someone.");
  });

  it("goes back to the root with the opening line", () => {
    const view = partner();
    const asked = chooseOption(shop, open(view), 1, undefined, view)!;
    expect(asked.path).toEqual([1]);
    expect(backToRoot(shop, asked, view)).toEqual({ ...asked, path: [], line: "Hello, ann." });
  });
});

describe("pressing a button", () => {
  it("answers with the option's line, and stays at the root when it has no follow-ups", () => {
    const view = partner();
    expect(chooseOption(shop, open(view), 0, undefined, view)).toEqual({
      ...open(view),
      line: "Ten crystals, one solution.",
    });
  });

  it("descends into a reply's follow-ups", () => {
    const view = partner();
    const asked = chooseOption(shop, open(view), 1, undefined, view)!;
    expect(asked.path).toEqual([1]);
    expect(asked.line).toBe("Fourteen shards. Deal?");
    // The buttons on offer are now the follow-ups: index 1 is "No".
    expect(chooseOption(shop, asked, 1, undefined, view)).toEqual({
      ...asked,
      path: [],
      line: "Suit yourself.",
    });
  });

  it("refuses a position nothing is at", () => {
    const view = partner();
    expect(chooseOption(shop, open(view), 9, undefined, view)).toBeNull();
  });

  it("says the else line when the condition fails, and runs nothing", () => {
    const view = partner();
    const asked = chooseOption(shop, open(view), 1, undefined, view)!;
    const refused = chooseOption(shop, asked, 0, undefined, view)!;
    expect(refused.line).toBe("That's not fourteen shards.");
    expect(view.attempts).toEqual([]);
    // The question stays open: the follow-ups are still the buttons on offer.
    expect(refused.path).toEqual([1]);
  });

  it("runs the effects on the partner when the condition holds", () => {
    const view = partner({ carries: (tileId, count) => tileId === "shard" && count === 14 });
    const asked = chooseOption(shop, open(view), 1, undefined, view)!;
    const bought = chooseOption(shop, asked, 0, undefined, view)!;
    expect(bought).toEqual({ ...asked, path: [], line: "Here you go, ann." });
    expect(view.attempts).toEqual([[price]]);
  });

  it("says the else line when the effects are refused", () => {
    const view = partner({ carries: () => true, attempt: () => false });
    const asked = chooseOption(shop, open(view), 1, undefined, view)!;
    expect(chooseOption(shop, asked, 0, undefined, view)!.line).toBe(
      "That's not fourteen shards.",
    );
  });

  it("keeps the last line when a refusal has nothing to say", () => {
    const view = partner();
    const opened = open(view);
    expect(chooseOption(shop, opened, 4, undefined, view)).toEqual(opened);
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
    expect(chooseOption(shop, open(view), 3, undefined, view)!.line).toBe("Just this once.");
    expect(chooseOption(shop, open(view), 3, undefined, view)!.line).toBe("I told you already.");
  });

  it("asks about a status", () => {
    const view = partner({ hasStatus: (id) => id === "luminous" });
    expect(chooseOption(shop, open(view), 4, undefined, view)!.line).toBe("You're glowing.");
  });
});

describe("an amount", () => {
  it("multiplies every count in the condition and the trade", () => {
    const asked: Array<[string, number]> = [];
    const view = partner({
      carries: (tileId, count) => (asked.push([tileId, count]), true),
    });
    chooseOption(shop, open(view), 2, 5, view);
    expect(asked).toEqual([["bottle", 5]]);
    expect(view.attempts).toEqual([
      [
        {
          effect: "trade",
          take: [{ tileId: "bottle", count: 5 }],
          give: [{ tileId: "shard", count: 10 }],
        },
      ],
    ]);
  });

  it("is clamped to the author's range", () => {
    const view = partner({ carries: () => true });
    chooseOption(shop, open(view), 2, 40, view);
    expect(view.attempts[0]![0]).toMatchObject({ take: [{ tileId: "bottle", count: 12 }] });
  });

  it("means one for a button with no stepper, whatever was sent", () => {
    const view = partner({ carries: () => true });
    const asked = chooseOption(shop, open(view), 1, undefined, view)!;
    chooseOption(shop, asked, 0, 3, view);
    expect(view.attempts).toEqual([[price]]);
  });
});
