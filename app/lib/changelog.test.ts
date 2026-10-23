import { describe, expect, it } from "vitest";
import { parseChangelog } from "./changelog";

describe("parseChangelog", () => {
  it("reads releases newest first, with player-facing section titles", () => {
    const markdown = [
      "# the-last-stones",
      "",
      "## 0.2.0",
      "",
      "### Minor Changes",
      "",
      "- Wolves hear you.",
      "",
      "### Patch Changes",
      "",
      "- Shields stop counting as weapons.",
      "",
      "## 0.1.0",
      "",
      "### Major Changes",
      "",
      "- The world opens.",
      "",
    ].join("\n");

    expect(parseChangelog(markdown)).toEqual([
      {
        version: "0.2.0",
        sections: [
          { title: "New", entries: ["Wolves hear you."] },
          { title: "Fixes", entries: ["Shields stop counting as weapons."] },
        ],
      },
      { version: "0.1.0", sections: [{ title: "Big changes", entries: ["The world opens."] }] },
    ]);
  });

  it("joins an entry's indented lines onto it", () => {
    const markdown = "## 0.1.0\n\n### Minor Changes\n\n- First line.\n  Second line.\n";

    expect(parseChangelog(markdown)[0]?.sections[0]?.entries).toEqual([
      "First line.\nSecond line.",
    ]);
  });

  it("has no releases before the first one is written", () => {
    expect(parseChangelog("# the-last-stones\n")).toEqual([]);
  });
});
