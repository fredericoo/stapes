import { describe, expect, it } from "vitest";
import { DEFAULT_CONTAINER, DEFAULT_WEAPON } from "../lib/item";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import type { ObjectRef } from "./affordances";
import { readOpenedContainer } from "./openedContainer";

/**
 * Whether a box somebody opened is still theirs to look into.
 *
 * Open or closed, with nothing in between: walking off closes it, and so does
 * somebody carrying it away. The caller forgets the reference on a close (see
 * `GameRenderer.pushOpenedContainer`), which is what stops a panel reopening on
 * its own as you wander back past a chest — and, with nothing kept, stops a slot
 * that has come to hold another bag being shown under the old panel.
 */

function tile(partial: Record<string, unknown>): TileDef {
  return normalizeTileDef({
    name: partial.id,
    height: 0,
    type: "simple",
    kind: "prop",
    attributes: {},
    sprite: { frames: [] },
    ...partial,
  });
}

const tiles = [
  tile({ id: "grass" }),
  tile({ id: "rock", height: 2 }),
  tile({ id: "sword", kind: "item", interactions: { item: DEFAULT_WEAPON } }),
  tile({ id: "bag", kind: "item", interactions: { item: DEFAULT_CONTAINER } }),
  tile({
    id: "chest",
    kind: "item",
    interactions: {
      item: { ...DEFAULT_CONTAINER, size: 2, equippable: false },
    },
  }),
];
const tilesById = tilesByIdFromList(tiles);

const ME = { x: 0, y: 0, z: 0 };
const REF: ObjectRef = { x: 1, y: 0, z: 0, stackIndex: 1 };
const CHEST_ID = "itm_chest";

/** A chest one cell east, holding one thing. */
function board(
  tileId = "chest",
  itemId: string | undefined = CHEST_ID,
): MapFile {
  return replaceStack(emptyMap(), 1, 0, 0, [
    { tileId: "grass" },
    { tileId, itemId, contents: [{ id: "itm_loot", tileId: "sword" }] },
  ]);
}

describe("a box in reach", () => {
  it("is open, and carries what is in it", () => {
    const read = readOpenedContainer(board(), tilesById, ME, REF, null);

    expect(read.kind).toBe("open");
    if (read.kind !== "open") return;
    expect(read.container.instance.id).toBe(CHEST_ID);
    expect(read.container.instance.contents).toHaveLength(1);
    expect(read.container.ref).toEqual(REF);
  });

  it("learns which thing was opened on the first read", () => {
    const read = readOpenedContainer(board(), tilesById, ME, REF, null);
    expect(read.kind === "open" && read.itemId).toBe(CHEST_ID);
  });

  it("stays open across a read that names the same thing", () => {
    const read = readOpenedContainer(board(), tilesById, ME, REF, CHEST_ID);
    expect(read.kind).toBe("open");
  });
});

describe("walking away", () => {
  const FAR = { x: 4, y: 0, z: 0 };

  it("closes the panel", () => {
    expect(
      readOpenedContainer(board(), tilesById, FAR, REF, CHEST_ID).kind,
    ).toBe("closed");
  });

  it("closes on the floor below as readily as across the room", () => {
    const below = { x: 1, y: 0, z: -2 };
    expect(
      readOpenedContainer(board(), tilesById, below, REF, CHEST_ID).kind,
    ).toBe("closed");
  });
});

/**
 * The case worth being strict about: what is in a bag belongs to whoever has
 * it, and a reference is a slot rather than a thing. This matters even with the
 * reference dropped on every close, because a box can be swapped while you are
 * standing right over it — which is exactly when nobody is walking anywhere.
 */
describe("a box that is not that box any more", () => {
  it("is closed once somebody has taken it", () => {
    const taken = replaceStack(emptyMap(), 1, 0, 0, [{ tileId: "grass" }]);
    expect(readOpenedContainer(taken, tilesById, ME, REF, CHEST_ID).kind).toBe(
      "closed",
    );
  });

  it("is closed when another container has taken its slot", () => {
    const swapped = board("bag", "itm_somebody_elses");
    expect(
      readOpenedContainer(swapped, tilesById, ME, REF, CHEST_ID).kind,
    ).toBe("closed");
  });

  it("is closed when the same kind of box with another identity is there", () => {
    const twin = board("chest", "itm_other_chest");
    expect(readOpenedContainer(twin, tilesById, ME, REF, CHEST_ID).kind).toBe(
      "closed",
    );
  });

  it("is closed when the slot holds something with no identity at all", () => {
    const scenery = replaceStack(emptyMap(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "rock" },
    ]);
    expect(
      readOpenedContainer(scenery, tilesById, ME, REF, CHEST_ID).kind,
    ).toBe("closed");
  });

  it("is closed for an empty cell", () => {
    expect(
      readOpenedContainer(emptyMap(), tilesById, ME, REF, CHEST_ID).kind,
    ).toBe("closed");
  });
});

describe("a box that is covered", () => {
  it("is still open under a body, which is not a lid", () => {
    const trodden = replaceStack(emptyMap(), 1, 0, 0, [
      { tileId: "grass" },
      {
        tileId: "chest",
        itemId: CHEST_ID,
        contents: [{ id: "itm_loot", tileId: "sword" }],
      },
      { tileId: "rock", owner: "somebody" },
    ]);
    expect(
      readOpenedContainer(trodden, tilesById, ME, REF, CHEST_ID).kind,
    ).toBe("open");
  });

  it("closes under a crate, which is", () => {
    const buried = replaceStack(emptyMap(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "chest", itemId: CHEST_ID, contents: [] },
      { tileId: "rock" },
    ]);
    expect(readOpenedContainer(buried, tilesById, ME, REF, CHEST_ID).kind).toBe(
      "closed",
    );
  });
});
