import { describe, expect, it } from "vitest";
import { inferNoiseStyle, noiseStyleOf } from "./noiseStyle";

describe("inferNoiseStyle", () => {
  it("reads a shouted word as loud", () => {
    expect(inferNoiseStyle("*BOOM*")).toBe("loud");
    expect(inferNoiseStyle("ROAR!")).toBe("loud");
  });

  it("reads a drawn-out letter as wavy", () => {
    expect(inferNoiseStyle("*sssk*")).toBe("wavy");
    expect(inferNoiseStyle("*hhhaaa*")).toBe("wavy");
  });

  it("pops anything else", () => {
    expect(inferNoiseStyle("crunch")).toBe("pop");
    expect(inferNoiseStyle("gulp")).toBe("pop");
    expect(inferNoiseStyle("A")).toBe("pop");
  });
});

it("prefers the style an author picked over the one the text suggests", () => {
  expect(noiseStyleOf({ text: "*BOOM*", style: "whisper" })).toBe("whisper");
  expect(noiseStyleOf({ text: "*BOOM*" })).toBe("loud");
});
