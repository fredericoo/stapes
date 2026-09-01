import { describe, expect, it } from "vitest";
import { HEIGHT_PER_LEVEL, normalizeTileDef, type TileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { clumpExtentAt, clumpExtents } from "./depthClump";

function tile(partial: Record<string, unknown>): TileDef {
  return normalizeTileDef({ name: String(partial.id), attributes: {}, ...partial });
}

const tilesById = tilesByIdFromList([
  tile({ id: "floor", height: 0 }),
  tile({ id: "crate", height: HEIGHT_PER_LEVEL / 2 }),
  // The player: shorter than a storey, so a roof leaves room to stand on a
  // stool. @see docs/notes.md, "A level is four height units, and a body is
  // three".
  tile({ id: "player", height: HEIGHT_PER_LEVEL - 1, kind: "battler" }),
  // Full height and takes up no room: you walk into it, not around it.
  tile({ id: "door-open", height: HEIGHT_PER_LEVEL, intangible: true }),
  tile({ id: "wall", height: HEIGHT_PER_LEVEL }),
]);

const body = (tileId: string) => ({ tileId, owner: "a" });

describe("clumpExtents", () => {
  it("leaves a plain stack alone, one extent per tile", () => {
    const extents = clumpExtents(
      [{ tileId: "floor" }, { tileId: "crate" }],
      tilesById,
    );
    expect(extents).toEqual([
      { foot: 0, top: 0 },
      { foot: 0, top: HEIGHT_PER_LEVEL / 2 },
    ]);
  });

  it("merges what stands inside an intangible tile", () => {
    // The bug, in one stack: the door takes up no elevation, so the player
    // stands in it rather than on it.
    const extents = clumpExtents(
      [{ tileId: "floor" }, { tileId: "door-open" }, body("player")],
      tilesById,
    );
    expect(extents[1]).toEqual({ foot: 0, top: HEIGHT_PER_LEVEL });
    // Same object, so the two sort on stack order alone.
    expect(extents[2]).toBe(extents[1]);
  });

  it("merges a shoved crate into the doorway it lands in", () => {
    // The case a body-shaped fix cannot reach: a barrel is not a body.
    const extents = clumpExtents(
      [{ tileId: "floor" }, { tileId: "door-open" }, { tileId: "crate" }],
      tilesById,
    );
    expect(extents[2]).toEqual({ foot: 0, top: HEIGHT_PER_LEVEL });
  });

  it("keeps a body standing *on* a crate separate from it", () => {
    // Resting on something is not being inside it, and geometry sorts those
    // two correctly on its own. Merging them would be the opposite bug.
    const extents = clumpExtents(
      [{ tileId: "floor" }, { tileId: "crate" }, body("player")],
      tilesById,
    );
    const half = HEIGHT_PER_LEVEL / 2;
    expect(extents[1]).toEqual({ foot: 0, top: half });
    expect(extents[2]).toEqual({ foot: half, top: half + HEIGHT_PER_LEVEL - 1 });
  });

  it("does not merge a tile resting on a solid one of the same height", () => {
    const extents = clumpExtents(
      [{ tileId: "wall" }, { tileId: "crate" }],
      tilesById,
    );
    expect(extents[0]).toEqual({ foot: 0, top: HEIGHT_PER_LEVEL });
    expect(extents[1]!.foot).toBe(HEIGHT_PER_LEVEL);
  });

  it("has an extent for every slot, and none for an empty stack", () => {
    expect(clumpExtents([], tilesById)).toEqual([]);
    expect(clumpExtents([{ tileId: "floor" }], tilesById)).toHaveLength(1);
  });

  it("reads an unknown tile as taking up nothing", () => {
    const extents = clumpExtents([{ tileId: "nope" }], tilesById);
    expect(extents[0]).toEqual({ foot: 0, top: 0 });
  });
});

describe("clumpExtentAt", () => {
  it("answers for one slot the same as the whole stack does", () => {
    const stack = [{ tileId: "floor" }, { tileId: "door-open" }, body("player")];
    expect(clumpExtentAt(stack, 2, tilesById)).toEqual(
      clumpExtents(stack, tilesById)[2],
    );
  });

  it("answers for a slot that is not there", () => {
    expect(clumpExtentAt([], 0, tilesById)).toEqual({ foot: 0, top: 0 });
  });
});
