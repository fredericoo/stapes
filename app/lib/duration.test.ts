import { describe, expect, it } from "vitest";
import { formatCountdown, formatDuration } from "./duration";

describe("formatDuration", () => {
  it("switches from seconds to minutes to hours at sixty of each", () => {
    expect(formatDuration(59_000)).toBe("59s");
    expect(formatDuration(150_000)).toBe("2.5m");
    expect(formatDuration(3_600_000)).toBe("1h");
  });
});

describe("formatCountdown", () => {
  it("rounds up to the unit it shows, so it never reads less than remains", () => {
    expect(formatCountdown(59_000)).toBe("59s");
    expect(formatCountdown(61_000)).toBe("2m");
    expect(formatCountdown(3_599_000)).toBe("1h");
    expect(formatCountdown(3_660_000)).toBe("2h");
  });
});
