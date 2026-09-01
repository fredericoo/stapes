import { describe, expect, it } from "vitest";
import type { BrainDef } from "./brain";
import { filterTiles, matchesTileFilter, matchesTileQuery } from "./tileFilter";
import { normalizeTileDef, type TileDef, type TileKind } from "./types";

/**
 * The catalogue grew past the point where scrolling finds anything, so the page
 * asks two questions of every tile. Both are pure, and both are here rather than
 * in the route because a filter that quietly drops a tile is invisible in a grid
 * of a hundred cards.
 */

const frame = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

const wanderBrain: BrainDef = {
  initial: "idle",
  states: { idle: { do: [{ action: "hold" }] } },
  transitions: [],
};

function tile(
  props: { id: string; name: string; kind?: TileKind; brain?: BrainDef },
): TileDef {
  return normalizeTileDef({
    id: props.id,
    name: props.name,
    height: 2,
    type: "simple",
    kind: props.kind ?? "prop",
    sprite: { frames: [frame] },
    attributes: {},
    ...(props.brain ? { interactions: { brain: props.brain } } : {}),
  });
}

describe("the kind filter", () => {
  it("keeps everything under 'all'", () => {
    const tiles = [
      tile({ id: "wall", name: "Wall" }),
      tile({ id: "troll", name: "Cave Troll", kind: "battler" }),
    ];
    expect(filterTiles(tiles, "", "all")).toEqual(tiles);
  });

  it("reads a brain as the thing that makes an NPC", () => {
    const deer = tile({ id: "deer", name: "Deer", brain: wanderBrain });
    const crate = tile({ id: "crate", name: "Crate" });
    expect(matchesTileFilter(deer, "npc")).toBe(true);
    expect(matchesTileFilter(crate, "npc")).toBe(false);
  });

  /**
   * The one case that would be wrong if the buckets were exclusive. A creature
   * with hit points *and* behaviour has to appear under both, or half the
   * bestiary goes missing from whichever bucket lost the coin toss.
   */
  it("lists a thinking battler under both battler and NPC", () => {
    const troll = tile({
      id: "troll",
      name: "Cave Troll",
      kind: "battler",
      brain: wanderBrain,
    });
    expect(matchesTileFilter(troll, "battler")).toBe(true);
    expect(matchesTileFilter(troll, "npc")).toBe(true);
    expect(matchesTileFilter(troll, "item")).toBe(false);
  });

  /**
   * An unparseable brain leaves an inert body, and the catalogue has to agree
   * with the world about that rather than promising an NPC that never moves.
   */
  it("does not call a tile with a malformed brain an NPC", () => {
    const broken = normalizeTileDef({
      id: "broken",
      name: "Broken",
      height: 2,
      type: "simple",
      kind: "prop",
      sprite: { frames: [frame] },
      attributes: {},
      // Points at a state that does not exist, which is exactly what a rename
      // leaves behind.
      interactions: {
        brain: { initial: "nowhere", states: {}, transitions: [] },
      },
    });
    expect(matchesTileFilter(broken, "npc")).toBe(false);
  });
});

describe("the search", () => {
  const troll = tile({ id: "cave-troll", name: "Cave Troll" });

  it("matches name and id case-insensitively", () => {
    expect(matchesTileQuery(troll, "TROLL")).toBe(true);
    expect(matchesTileQuery(troll, "cave-tr")).toBe(true);
    expect(matchesTileQuery(troll, "goblin")).toBe(false);
  });

  it("matches terms in any order", () => {
    expect(matchesTileQuery(troll, "troll cave")).toBe(true);
  });

  it("treats an empty or blank query as no query", () => {
    expect(matchesTileQuery(troll, "")).toBe(true);
    expect(matchesTileQuery(troll, "   ")).toBe(true);
  });

  it("does not match on fields the card never shows", () => {
    expect(matchesTileQuery(troll, "simple")).toBe(false);
    expect(matchesTileQuery(troll, "prop")).toBe(false);
  });
});

describe("the two together", () => {
  it("narrows by both at once", () => {
    const tiles = [
      tile({ id: "cave-troll", name: "Cave Troll", kind: "battler" }),
      tile({ id: "cave-bat", name: "Cave Bat", kind: "battler" }),
      tile({ id: "cave-torch", name: "Cave Torch" }),
    ];
    expect(filterTiles(tiles, "cave", "battler").map((t) => t.id)).toEqual([
      "cave-troll",
      "cave-bat",
    ]);
  });
});
