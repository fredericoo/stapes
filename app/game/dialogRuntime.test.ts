import { describe, expect, it } from "vitest";
import type { DialogDef } from "../lib/dialog";
import {
  acceptTrade,
  cancelTrade,
  chooseOption,
  MAX_STEPS_PER_PRESS,
  openConversation,
  TRADE_REFUSED,
  waitingOn,
  type Conversation,
  type DialogEffectDef,
  type PartnerView,
} from "./dialogRuntime";

/**
 * A script run by hand, without a session.
 *
 * The interpreter is a pure step over (script, where you are, what was
 * pressed); these pin what it runs, where it waits, and what the transcript
 * says, against a partner built by hand.
 */

const say = (text: string) => ({ kind: "say" as const, text });
const back = { kind: "goto" as const, name: "main" };

const shop: DialogDef = {
  script: [
    say("Hello, {partner}!"),
    { kind: "anchor", name: "main" },
    {
      kind: "choices",
      options: [
        {
          label: "Buy",
          then: [
            say("Fourteen shards each."),
            {
              kind: "request_trade",
              take: [{ tileId: "shard", count: 14 }],
              give: [{ tileId: "potion", count: 1 }],
              min: 1,
              max: 4,
              default: 2,
              traded: [say("Thanks."), back],
              cancel: [say("Stop wasting my time."), back],
            },
          ],
        },
        { label: "How", then: [say("Crystals."), say("Light."), back] },
        { label: "Bless me", then: [{ kind: "add_status", statusId: "luminous" }, { kind: "tag", tag: "blessed" }, say("Shine.")] },
        { label: "Bye", then: [say("Mind the dark.")] },
      ],
    },
  ],
};

const npc = { id: "npc:1", tileId: "seller" };

function partner(attempt: (effects: readonly DialogEffectDef[]) => boolean = () => true) {
  const attempts: DialogEffectDef[][] = [];
  const view: PartnerView & { attempts: DialogEffectDef[][] } = {
    name: () => "ann",
    attempt: (effects) => (attempts.push([...effects]), attempt(effects)),
    attempts,
  };
  return view;
}

const lines = (c: Conversation) => c.transcript.map((e) => `${e.who}: ${e.text}`);

describe("opening", () => {
  it("runs to the first choice, saying everything before it", () => {
    const view = partner();
    const opened = openConversation(shop, npc, view);
    expect(lines(opened)).toEqual(["npc: Hello, ann!"]);
    expect(opened.pc).toEqual([2]);
    expect(waitingOn(shop, opened)?.kind).toBe("choices");
  });

  it("names a partner who has gone as someone", () => {
    const view = partner();
    view.name = () => null;
    expect(lines(openConversation(shop, npc, view))).toEqual(["npc: Hello, someone!"]);
  });

  it("ends at once for a script with nothing to wait on", () => {
    const view = partner();
    const opened = openConversation({ script: [say("Hi."), say("Bye.")] }, npc, view);
    expect(lines(opened)).toEqual(["npc: Hi.", "npc: Bye."]);
    expect(waitingOn({ script: [say("Hi."), say("Bye.")] }, opened)).toBeNull();
  });
});

describe("choosing", () => {
  it("records the press, runs the branch, and comes back to the menu by goto", () => {
    const view = partner();
    const how = chooseOption(shop, openConversation(shop, npc, view), 1, view)!;
    expect(lines(how)).toEqual(["npc: Hello, ann!", "you: How", "npc: Crystals.", "npc: Light."]);
    expect(how.pc).toEqual([2]);
    expect(waitingOn(shop, how)?.kind).toBe("choices");
  });

  it("runs effects on the way, skipping ones that cannot be, and ends when a branch runs out", () => {
    const view = partner((effects) => effects[0]?.effect !== "add_status");
    const blessed = chooseOption(shop, openConversation(shop, npc, view), 2, view)!;
    expect(view.attempts).toEqual([[{ effect: "add_status", statusId: "luminous" }], [{ effect: "tag", tag: "blessed" }]]);
    expect(lines(blessed).at(-1)).toBe("npc: Shine.");
    expect(waitingOn(shop, blessed)).toBeNull();
  });

  it("stops after a dangling branch, transcript intact", () => {
    const view = partner();
    const bye = chooseOption(shop, openConversation(shop, npc, view), 3, view)!;
    expect(lines(bye).at(-1)).toBe("npc: Mind the dark.");
    expect(waitingOn(shop, bye)).toBeNull();
    expect(chooseOption(shop, bye, 0, view)).toBeNull();
  });

  it("refuses a position nothing is at, and a press while not waiting on choices", () => {
    const view = partner();
    const opened = openConversation(shop, npc, view);
    expect(chooseOption(shop, opened, 9, view)).toBeNull();
    const buying = chooseOption(shop, opened, 0, view)!;
    expect(waitingOn(shop, buying)?.kind).toBe("request_trade");
    expect(chooseOption(shop, buying, 0, view)).toBeNull();
  });
});

describe("trading", () => {
  function atCounter(view: PartnerView) {
    return chooseOption(shop, openConversation(shop, npc, view), 0, view)!;
  }

  it("waits on the trade with its line said, and refuses a cancel or trade elsewhere", () => {
    const view = partner();
    const offer = atCounter(view);
    expect(lines(offer).at(-1)).toBe("npc: Fourteen shards each.");
    expect(offer.pc).toEqual([2, 0, 1]);
    expect(acceptTrade(shop, openConversation(shop, npc, view), 1, view)).toBeNull();
    expect(cancelTrade(shop, openConversation(shop, npc, view), view)).toBeNull();
  });

  it("runs the trade for so many units, notes it, and continues the traded branch", () => {
    const view = partner();
    const done = acceptTrade(shop, atCounter(view), 3, view)!;
    expect(view.attempts).toEqual([
      [{ effect: "trade", take: [{ tileId: "shard", count: 42 }], give: [{ tileId: "potion", count: 3 }] }],
    ]);
    expect(lines(done).slice(-2)).toEqual(["note: Traded ×3.", "npc: Thanks."]);
    expect(waitingOn(shop, done)?.kind).toBe("choices");
  });

  it("clamps the amount to the trade's range", () => {
    const view = partner();
    acceptTrade(shop, atCounter(view), 40, view);
    expect(view.attempts[0]![0]).toMatchObject({ take: [{ tileId: "shard", count: 56 }] });
  });

  it("notes a refusal and keeps waiting, nothing run", () => {
    const view = partner(() => false);
    const refused = acceptTrade(shop, atCounter(view), 1, view)!;
    expect(lines(refused).at(-1)).toBe(`note: ${TRADE_REFUSED}`);
    expect(waitingOn(shop, refused)?.kind).toBe("request_trade");
  });

  it("runs the cancel branch on cancel", () => {
    const view = partner();
    const cancelled = cancelTrade(shop, atCounter(view), view)!;
    expect(lines(cancelled).slice(-2)).toEqual(["you: Cancel", "npc: Stop wasting my time."]);
    expect(view.attempts).toEqual([]);
    expect(waitingOn(shop, cancelled)?.kind).toBe("choices");
  });
});

describe("goto", () => {
  it("lands after the anchor, wherever it is, and stops a loop that never waits", () => {
    const nested: DialogDef = {
      script: [
        { kind: "choices", options: [{ label: "In", then: [{ kind: "anchor", name: "deep" }, say("Deep.")] }] },
        say("Top."),
        { kind: "goto", name: "deep" },
      ],
    };
    const view = partner();
    const gone = chooseOption(nested, openConversation(nested, npc, view), 0, view)!;
    expect(lines(gone).slice(0, 4)).toEqual(["you: In", "npc: Deep.", "npc: Top.", "npc: Deep."]);
    expect(gone.transcript.length).toBeLessThanOrEqual(MAX_STEPS_PER_PRESS);
    expect(waitingOn(nested, gone)).toBeNull();
  });

  it("carries on past a goto naming no anchor", () => {
    const lost: DialogDef = { script: [{ kind: "goto", name: "nowhere" }, say("Still here.")] };
    expect(lines(openConversation(lost, npc, partner()))).toEqual(["npc: Still here."]);
  });
});
