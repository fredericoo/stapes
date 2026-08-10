import { describe, expect, it } from "vitest";
import { MAX_CHAT_LENGTH, MAX_CHAT_RAW_LENGTH, sanitizeChatText } from "./chat";

/**
 * What a browser is allowed to put on the wire.
 *
 * This runs on text from a player nobody controls, and it is the only thing
 * standing between that text and both a broadcast and a row on disk — so the
 * interesting cases are all the ones where the input is not a sentence.
 */

describe("sanitizeChatText", () => {
  it("keeps an ordinary message as it was typed", () => {
    expect(sanitizeChatText("hey there!")).toBe("hey there!");
  });

  /**
   * The font is subset to printable ASCII, so anything outside it would take up
   * width and draw nothing — a hole in the sentence rather than a character the
   * reader is missing.
   */
  it("drops characters the font cannot draw", () => {
    expect(sanitizeChatText("café 🎉")).toBe("caf");
    expect(sanitizeChatText("naïve")).toBe("nave");
  });

  it("drops newlines and control characters, so a message is one line", () => {
    expect(sanitizeChatText("up\ndown")).toBe("updown");
    expect(sanitizeChatText("tab\there")).toBe("tabhere");
    expect(sanitizeChatText("bell\x07\x00")).toBe("bell");
    // Carriage return too, or a Windows paste arrives as one long word.
    expect(sanitizeChatText("one\r\ntwo")).toBe("onetwo");
  });

  it("collapses runs of spaces and trims the ends", () => {
    expect(sanitizeChatText("   hey    there   ")).toBe("hey there");
  });

  it("refuses a message with nothing left to draw", () => {
    expect(sanitizeChatText("")).toBeNull();
    expect(sanitizeChatText("     ")).toBeNull();
    expect(sanitizeChatText("🎉🎉🎉")).toBeNull();
    expect(sanitizeChatText("\n\t")).toBeNull();
  });

  /**
   * The one character in printable ASCII that NF Pixels has no glyph for. It is
   * dropped so the rule "anything that survives here can be drawn" stays
   * literally true — a message must never arrive with a hole in it.
   */
  it("drops the tilde, which the font cannot draw", () => {
    expect(sanitizeChatText("a ~ b")).toBe("a b");
    expect(sanitizeChatText("~~~")).toBeNull();
  });

  it("keeps the rest of printable ASCII, punctuation and all", () => {
    const drawable = "!\"#$%&'()*+,-./0123456789:;<=>?@ABCXYZ[\\]^_`abcxyz{|}";
    expect(sanitizeChatText(drawable)).toBe(drawable);
  });

  it("truncates to the drawn cap", () => {
    const long = "a".repeat(MAX_CHAT_LENGTH + 50);
    expect(sanitizeChatText(long)).toHaveLength(MAX_CHAT_LENGTH);
  });

  /**
   * The cap counts characters that will actually appear, which is why it is
   * applied after stripping: a message padded with emoji should still be able to
   * say its full hundred and twenty-eight characters.
   */
  it("spends the cap on drawable characters, not on stripped ones", () => {
    const padded = "🎉".repeat(100) + "b".repeat(MAX_CHAT_LENGTH);
    expect(sanitizeChatText(padded)).toBe("b".repeat(MAX_CHAT_LENGTH));
  });

  /**
   * The raw cap is a bound on the work, not on the message. A client must not be
   * able to hand this a megabyte to walk, so the slice happens before the loop —
   * which means a message whose first 512 characters are all strippable really
   * does come back empty.
   */
  it("never walks more than the raw cap", () => {
    const flood = "🎉".repeat(MAX_CHAT_RAW_LENGTH * 10) + "hello";
    expect(sanitizeChatText(flood)).toBeNull();
  });
});
