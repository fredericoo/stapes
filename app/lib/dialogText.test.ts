import { describe, expect, it } from "vitest";
import { dialogPlainText, dialogTextParts, mentionedTileIds, pixelFontText } from "./dialogText";
import type { TileDef } from "./types";

const shield = { id: "shield", name: "Iron Shield" } as TileDef;

describe("item mentions in dialog text", () => {
  it("splits a line at each mention and keeps the text between them", () => {
    expect(dialogTextParts("A {item:shield} for {item:shard}, friend.")).toEqual([
      { kind: "text", text: "A " },
      { kind: "item", tileId: "shield" },
      { kind: "text", text: " for " },
      { kind: "item", tileId: "shard" },
      { kind: "text", text: ", friend." },
    ]);
  });

  it("leaves other braces as text, so {partner} survives to the runtime", () => {
    expect(dialogTextParts("Hello, {partner}. {item:}")).toEqual([
      { kind: "text", text: "Hello, {partner}. {item:}" },
    ]);
  });

  it("lists each mentioned tile once", () => {
    expect(mentionedTileIds("{item:shield} or {item:shard} or {item:shield}")).toEqual([
      "shield",
      "shard",
    ]);
  });

  it("reads a mention as the item's name, or its id when nobody authored it", () => {
    const text = "One {item:shield}, one {item:gone}.";
    expect(dialogPlainText(text, { shield })).toBe("One Iron Shield, one gone.");
  });

  it("spells typographic punctuation in ASCII for the pixel font", () => {
    expect(pixelFontText("Twenty \u2014 no less\u2026 \u201cfriend\u201d")).toBe(
      'Twenty - no less... "friend"',
    );
  });
});
