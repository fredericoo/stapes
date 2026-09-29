import { describe, expect, it } from "vitest";
import { MAX_CHAT_LENGTH, MAX_CHAT_RAW_LENGTH, sanitizeChatText } from "./chat";

describe("sanitizeChatText", () => {
  it("keeps an ordinary message as it was typed", () => {
    expect(sanitizeChatText("hey there!")).toBe("hey there!");
  });

  it("drops characters the font cannot draw", () => {
    expect(sanitizeChatText("café 🎉")).toBe("caf");
    expect(sanitizeChatText("naïve")).toBe("nave");
  });

  it("drops newlines and control characters, so a message is one line", () => {
    expect(sanitizeChatText("up\ndown")).toBe("updown");
    expect(sanitizeChatText("tab\there")).toBe("tabhere");
    expect(sanitizeChatText("bell\x07\x00")).toBe("bell");
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

  it("spends the cap on drawable characters, not on stripped ones", () => {
    const padded = "🎉".repeat(100) + "b".repeat(MAX_CHAT_LENGTH);
    expect(sanitizeChatText(padded)).toBe("b".repeat(MAX_CHAT_LENGTH));
  });

  it("never walks more than the raw cap", () => {
    const flood = "🎉".repeat(MAX_CHAT_RAW_LENGTH * 10) + "hello";
    expect(sanitizeChatText(flood)).toBeNull();
  });
});
