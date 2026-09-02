import { describe, expect, it } from "vitest";
import type { ActiveStatus, StatusTone } from "../lib/status";
import {
  compareStatuses,
  splitForCapacity,
  statusFraction,
  statusStripCapacity,
  STATUS_CELL_SIZE_PX,
  STATUS_ICON_GAP_PX,
} from "./StatusStrip";

/**
 * The arithmetic behind the lane.
 *
 * All of it is pure precisely so it can be asserted here rather than by
 * screenshotting a browser: how many cells fit, which ones survive when they do
 * not, and how full each bar is. The rendering is not under test — the numbers
 * that decide it are.
 */

function status(over: Partial<ActiveStatus> = {}): ActiveStatus {
  return {
    defId: "fed",
    name: "Fed",
    description: "Slowly recovering health.",
    tone: "good" as StatusTone,
    icon: null,
    remainingMs: 10_000,
    fullDurationMs: 30_000,
    ...over,
  };
}

const STRIDE = STATUS_CELL_SIZE_PX + STATUS_ICON_GAP_PX;

describe("how many fit", () => {
  it("counts cells, allowing for the gap between them", () => {
    // Three cells need three strides less the gap that is not after the last.
    expect(statusStripCapacity(STRIDE * 3 - STATUS_ICON_GAP_PX)).toBe(3);
    expect(statusStripCapacity(STRIDE * 3 - STATUS_ICON_GAP_PX - 1)).toBe(2);
  });

  it("reads a lane with no room as holding nothing", () => {
    expect(statusStripCapacity(0)).toBe(0);
    expect(statusStripCapacity(-40)).toBe(0);
  });
});

describe("what is shown when they do not all fit", () => {
  const four = [
    status({ defId: "a" }),
    status({ defId: "b" }),
    status({ defId: "c" }),
    status({ defId: "d" }),
  ];

  it("shows everything when there is room", () => {
    expect(splitForCapacity(four, 4)).toEqual({ shown: four, overflow: 0 });
  });

  /**
   * The `+N` claims the last cell rather than appearing beside a full row — four
   * in three cells is two icons and `+2`, never three icons and a silently
   * hidden fourth. A lane that truncated quietly would be a lane that lies.
   */
  it("gives the last cell to the count, not to an icon", () => {
    const { shown, overflow } = splitForCapacity(four, 3);
    expect(shown.map((s) => s.defId)).toEqual(["a", "b"]);
    expect(overflow).toBe(2);
  });

  it("collapses to nothing but a count in a single cell", () => {
    expect(splitForCapacity(four, 1)).toEqual({ shown: [], overflow: 4 });
  });

  it("draws nothing at all in no cells", () => {
    expect(splitForCapacity(four, 0)).toEqual({ shown: [], overflow: 0 });
  });
});

describe("the order", () => {
  /**
   * The whole point of a bounded lane: when something has to be dropped into the
   * `+N`, the thing that gets dropped must not be the poison.
   */
  it("puts a harmful status ahead of a longer benign one", () => {
    const poison = status({
      defId: "poisoned",
      tone: "bad",
      remainingMs: 1_000,
    });
    const fed = status({ defId: "fed", tone: "good", remainingMs: 999_000 });
    expect([fed, poison].sort(compareStatuses).map((s) => s.defId)).toEqual([
      "poisoned",
      "fed",
    ]);
  });

  it("puts the longer of two of the same tone first", () => {
    const brief = status({ defId: "brief", remainingMs: 1_000 });
    const long = status({ defId: "long", remainingMs: 9_000 });
    expect([brief, long].sort(compareStatuses).map((s) => s.defId)).toEqual([
      "long",
      "brief",
    ]);
  });
});

describe("how full the bar is", () => {
  it("reads against the status's full duration", () => {
    expect(
      statusFraction(status({ remainingMs: 15_000, fullDurationMs: 30_000 })),
    ).toBeCloseTo(0.5);
  });

  /** A short roll starts short, which is the reading the reference is chosen for. */
  it("starts a badly rolled status below full", () => {
    expect(
      statusFraction(status({ remainingMs: 10_000, fullDurationMs: 30_000 })),
    ).toBeCloseTo(1 / 3);
  });

  it("never runs past either end", () => {
    expect(
      statusFraction(status({ remainingMs: 99_000, fullDurationMs: 30_000 })),
    ).toBe(1);
    expect(
      statusFraction(status({ remainingMs: -5, fullDurationMs: 30_000 })),
    ).toBe(0);
  });

  /**
   * A hand-authored file can say zero, and dividing by it would put `Infinity`
   * into a width. Empty is the honest answer when nothing says how long full is.
   */
  it("reads an unstated full duration as empty rather than as infinite", () => {
    expect(statusFraction(status({ fullDurationMs: 0 }))).toBe(0);
  });
});
