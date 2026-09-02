import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIALOG,
  hearsAny,
  hearsWord,
  MAX_DIALOG_DEPTH,
  normalizeKeyword,
  resolveDialog,
  validateDialog,
  type DialogDef,
} from "./dialog";
import { normalizeTileDef } from "./types";

const frame = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

function tileWith(dialog: unknown) {
  return normalizeTileDef({
    id: "seller",
    name: "Seller",
    height: 4,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    kind: "prop",
    interactions: { dialog },
  });
}

describe("hearing a word", () => {
  it("matches a whole word, whatever the case", () => {
    expect(hearsWord("Buy a POTION please", "potion")).toBe(true);
  });

  it("does not match inside another word", () => {
    // The brain's `heard` is a substring on purpose; this is not.
    expect(hearsWord("such emotion", "motion")).toBe(false);
    expect(hearsWord("potions", "potion")).toBe(false);
  });

  it("matches at either end and beside punctuation", () => {
    expect(hearsWord("potion", "potion")).toBe(true);
    expect(hearsWord("hi!", "hi")).toBe(true);
    expect(hearsWord("a potion, then", "potion")).toBe(true);
  });

  it("finds a later whole-word match after an embedded one", () => {
    expect(hearsWord("potions and a potion", "potion")).toBe(true);
  });

  it("matches a phrase as a phrase", () => {
    expect(hearsWord("sell my empty  bottle", "empty bottle")).toBe(true);
    expect(hearsWord("empty this bottle", "empty bottle")).toBe(false);
  });

  it("never matches an empty keyword", () => {
    expect(hearsWord("anything", "")).toBe(false);
  });

  it("answers for any of a list", () => {
    expect(hearsAny("hello there", ["hi", "hello"])).toBe(true);
    expect(hearsAny("hey there", ["hi", "hello"])).toBe(false);
  });

  it("normalises a keyword the way it normalises an utterance", () => {
    expect(normalizeKeyword("  Empty   Bottle ")).toBe("empty bottle");
  });
});

describe("resolving a dialog", () => {
  it("parses a block and lowercases its keywords", () => {
    const dialog = resolveDialog(
      tileWith({
        ...DEFAULT_DIALOG,
        greet: { hear: ["Hi ", "HELLO"], say: "Hello." },
        topics: [{ hear: ["Potion"], say: "Fourteen shards.", then: [{ hear: ["Yes"], say: "Here." }] }],
      }),
    );
    expect(dialog?.greet.hear).toEqual(["hi", "hello"]);
    expect(dialog?.topics[0]?.hear).toEqual(["potion"]);
    expect(dialog?.topics[0]?.then?.[0]?.hear).toEqual(["yes"]);
  });

  it("is null for a tile with no dialog", () => {
    expect(resolveDialog(tileWith(undefined))).toBeNull();
  });

  it("is null for a greeting that listens for nothing", () => {
    expect(
      resolveDialog(tileWith({ ...DEFAULT_DIALOG, greet: { hear: [], say: "Hello." } })),
    ).toBeNull();
  });

  it("is null for a keyword that is only spaces", () => {
    expect(
      resolveDialog(tileWith({ ...DEFAULT_DIALOG, greet: { hear: ["   "], say: "Hello." } })),
    ).toBeNull();
  });

  it("is null for a topic with no line", () => {
    expect(
      resolveDialog(tileWith({ ...DEFAULT_DIALOG, topics: [{ hear: ["potion"], say: "" }] })),
    ).toBeNull();
  });

  it("is memoised on the def", () => {
    const def = tileWith(DEFAULT_DIALOG);
    expect(resolveDialog(def)).toBe(resolveDialog(def));
  });
});

describe("validating a dialog", () => {
  const sound: DialogDef = {
    ...DEFAULT_DIALOG,
    topics: [{ hear: ["potion"], say: "Fourteen shards." }],
  };

  it("has nothing to say about a sound one", () => {
    expect(validateDialog(sound)).toEqual([]);
  });

  it("warns about a dialog with no topics", () => {
    expect(validateDialog(DEFAULT_DIALOG).map((i) => i.severity)).toEqual(["warn"]);
  });

  it("warns when the same word is answered twice at one level", () => {
    const issues = validateDialog({
      ...sound,
      topics: [
        { hear: ["potion", "buy"], say: "One." },
        { hear: ["buy"], say: "Two." },
      ],
    });
    expect(issues).toEqual([
      { severity: "warn", message: expect.stringContaining('"buy" is answered by an earlier topic') },
    ]);
  });

  it("does not mind the same word under two different replies", () => {
    const issues = validateDialog({
      ...sound,
      topics: [
        { hear: ["potion"], say: "Deal?", then: [{ hear: ["yes"], say: "Here." }] },
        { hear: ["bottle"], say: "Sell?", then: [{ hear: ["yes"], say: "Ta." }] },
      ],
    });
    expect(issues).toEqual([]);
  });

  it("warns when a word both greets and says goodbye", () => {
    const issues = validateDialog({
      ...sound,
      greet: { hear: ["hi", "yo"], say: "Hello." },
      bye: { hear: ["yo"], say: "Bye." },
    });
    expect(issues.map((i) => i.message)).toEqual([
      expect.stringContaining('"yo" both greets'),
    ]);
  });

  it("errors on a blank line, which the schema would refuse", () => {
    const issues = validateDialog({ ...sound, bye: { hear: ["bye"], say: "  " } });
    expect(issues).toEqual([{ severity: "error", message: "The farewell says nothing" }]);
  });

  it("errors on a blank busy line, where leaving it out is the way to say nothing", () => {
    expect(validateDialog({ ...sound, busy: "" })[0]?.severity).toBe("error");
  });

  it("warns past the depth a conversation can follow", () => {
    let topic = { hear: ["deep"], say: "Deepest." } as DialogDef["topics"][number];
    for (let depth = 0; depth < MAX_DIALOG_DEPTH; depth++) {
      topic = { hear: ["deep"], say: "Deeper.", then: [topic] };
    }
    const issues = validateDialog({ ...sound, topics: [topic] });
    expect(issues.map((i) => i.message)).toEqual([
      expect.stringContaining(`${MAX_DIALOG_DEPTH + 1} deep`),
    ]);
  });
});
