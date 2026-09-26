import { describe, expect, it } from "vitest";
import { addContent, removeContent, setContentCount } from "./ContainerContentsField";
import { DEFAULT_CONTAINER } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import type { TileDef } from "../lib/types";
import { tile } from "../lib/testTile";

function food(id: string, pile: number): TileDef {
  return tile({
    id,
    kind: "item",
    intangible: true,
    interactions: { item: { type: "consumable", label: "Eat", hp: 1, pile } },
  });
}

const bread = food("bread", 3);
const sword = tile({
  id: "sword",
  kind: "item",
  intangible: true,
  interactions: {
    item: {
      type: "weapon",
      damage: 1,
      def: 0,
      accuracy: 100,
      variance: 0,
      spd: 50,
      mastery: "sharp",
    },
  },
});
const bag = tile({
  id: "bag",
  kind: "item",
  intangible: true,
  interactions: { item: { ...DEFAULT_CONTAINER, size: 2 } },
});

const tilesById: Record<string, TileDef> = Object.fromEntries(
  [bread, sword, bag].map((def) => [def.id, def]),
);

function authored(contents: readonly ItemInstance[]) {
  return contents.map(({ tileId, count }) => ({ tileId, count }));
}

describe("addContent", () => {
  it("gives the first of something a square of its own", () => {
    const next = addContent([], "sword", 4, tilesById);
    expect(authored(next!)).toEqual([{ tileId: "sword", count: undefined }]);
  });

  it("mints an identity, so what it hands back is an instance", () => {
    const next = addContent([], "sword", 4, tilesById)!;
    expect(next[0]!.id).toMatch(/^itm_/);
  });

  it("pours a second of the same food into the pile already there", () => {
    let contents = addContent([], "bread", 4, tilesById)!;
    contents = addContent(contents, "bread", 4, tilesById)!;
    expect(authored(contents)).toEqual([{ tileId: "bread", count: 2 }]);
  });

  it("takes a fresh square once the pile is at its tile's ceiling", () => {
    let contents: ItemInstance[] = [];
    for (let i = 0; i < 4; i++) {
      contents = addContent(contents, "bread", 4, tilesById)!;
    }
    expect(authored(contents)).toEqual([
      { tileId: "bread", count: 3 },
      { tileId: "bread", count: undefined },
    ]);
  });

  it("never pours one kind of thing into another", () => {
    let contents = addContent([], "sword", 4, tilesById)!;
    contents = addContent(contents, "sword", 4, tilesById)!;
    expect(contents).toHaveLength(2);
  });

  it("refuses what the container has no square left for", () => {
    let contents = addContent([], "sword", 1, tilesById)!;
    expect(addContent(contents, "bread", 1, tilesById)).toBeNull();
  });

  it("takes a pour even when every square is taken", () => {
    const contents = addContent([], "bread", 1, tilesById)!;
    const next = addContent(contents, "bread", 1, tilesById);
    expect(authored(next!)).toEqual([{ tileId: "bread", count: 2 }]);
  });
});

describe("setContentCount", () => {
  it("writes a count above one", () => {
    const contents = addContent([], "bread", 4, tilesById)!;
    expect(authored(setContentCount(contents, 0, 3))).toEqual([{ tileId: "bread", count: 3 }]);
  });

  it("writes a count of one as no count at all", () => {
    const contents = setContentCount(addContent([], "bread", 4, tilesById)!, 0, 3);
    expect(authored(setContentCount(contents, 0, 1))).toEqual([
      { tileId: "bread", count: undefined },
    ]);
  });

  it("leaves every other square alone", () => {
    let contents = addContent([], "sword", 4, tilesById)!;
    contents = addContent(contents, "bread", 4, tilesById)!;
    const next = setContentCount(contents, 1, 2);
    expect(next[0]).toBe(contents[0]);
  });
});

describe("removeContent", () => {
  it("closes the squares up behind what it took", () => {
    let contents = addContent([], "sword", 4, tilesById)!;
    contents = addContent(contents, "bread", 4, tilesById)!;
    expect(authored(removeContent(contents, 0))).toEqual([{ tileId: "bread", count: undefined }]);
  });
});
