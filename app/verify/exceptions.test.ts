import { describe, expect, it } from "vitest";
import { applyExceptions, parseExceptions } from "./exceptions";

const stairwellArea = { from: [10, -16, -1], to: [11, -15, -1] };

const stairwell = parseExceptions([
  { check: "caves", kind: "open-sky", areas: [stairwellArea], reason: "The stairwell." },
]);

const hole = { kind: "open-sky", x: 11, y: -15, z: -1 };

describe("applyExceptions", () => {
  it("excuses a problem of the named kind inside the area", () => {
    const { failing, excused, stale } = applyExceptions("caves", [hole], stairwell);

    expect(failing).toEqual([]);
    expect(excused).toEqual([{ ...hole, reason: "The stairwell." }]);
    expect(stale).toEqual([]);
  });

  it.each([
    { what: "just past the area", problem: { ...hole, x: 12 } },
    { what: "on the level below the area", problem: { ...hole, z: -2 } },
    { what: "of another kind inside the area", problem: { ...hole, kind: "daylight" } },
  ])("still fails a problem $what", ({ problem }) => {
    const { failing } = applyExceptions("caves", [hole, problem], stairwell);

    expect(failing).toEqual([problem]);
  });

  it("ignores exceptions written for another check", () => {
    const { failing } = applyExceptions("content", [hole], stairwell);

    expect(failing).toEqual([hole]);
  });

  it("reports an area that no longer holds the problem it excuses", () => {
    const { stale } = applyExceptions("caves", [], stairwell);

    expect(stale).toEqual([{ kind: "open-sky", area: stairwellArea, reason: "The stairwell." }]);
  });
});

describe("parseExceptions", () => {
  const entry = { check: "caves", kind: "open-sky", areas: [stairwellArea], reason: "Why." };

  it.each([
    { what: "no reason", broken: { ...entry, reason: "" } },
    { what: "no areas", broken: { ...entry, areas: [] } },
    {
      what: "a corner with two coordinates",
      broken: { ...entry, areas: [{ from: [1, 2], to: [3, 4] }] },
    },
    {
      what: "corners the wrong way round",
      broken: { ...entry, areas: [{ from: [3, 0, 0], to: [1, 0, 0] }] },
    },
  ])("refuses an entry with $what", ({ broken }) => {
    expect(() => parseExceptions([broken])).toThrow();
  });
});
