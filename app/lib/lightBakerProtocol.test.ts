/**
 * The worker's copy of the map must not drift from the real one.
 *
 * This is the one failure in the off-thread path that nothing else would
 * notice: a missed edit does not throw, it just bakes light for a world that no
 * longer exists, and it stays wrong until something else invalidates the chunk.
 */
import { describe, expect, it } from "vitest";
import { clearStack, getStack, replaceStack, setStacks } from "./mapData";
import { fixtureTown } from "./fixtureTown";
import { applyMapPatch, diffMapChunks } from "./lightBakerProtocol";
import type { MapFile } from "./types";

const base = fixtureTown();

/** What the worker would hold after being initialised and then told about `next`. */
function mirrorThrough(versions: MapFile[]): MapFile {
  const mirror = structuredClone(versions[0]!);
  let prev = versions[0]!;
  for (const next of versions.slice(1)) {
    const patch = diffMapChunks(prev, next);
    if (patch) applyMapPatch(mirror, structuredClone(patch));
    prev = next;
  }
  return mirror;
}

describe("light baker map mirror", () => {
  it("has nothing to say about a map that did not change", () => {
    expect(diffMapChunks(base, base)).toBeNull();
  });

  it("sends the whole map when there is no baseline", () => {
    const patch = diffMapChunks(null, base);
    expect(patch).not.toBeNull();
    expect(Object.keys(patch!.levels).sort()).toEqual(
      Object.keys(base.levels).sort(),
    );
  });

  it("tracks placements, replacements and removals", () => {
    const a = replaceStack(base, 0, 0, 0, [
      ...(getStack(base, 0, 0, 0) ?? []),
      { tileId: "torch" },
    ]);
    // Far enough out to land in a chunk the map has never had.
    const b = replaceStack(a, 400, -400, 3, [{ tileId: "stone-wall" }]);
    const c = clearStack(b, 0, 0, 0);
    const d = setStacks(c, [
      { x: 1, y: 1, z: 0, stack: [{ tileId: "wooden-box" }] },
      { x: 2, y: 1, z: 0, stack: [] },
    ]);
    const e = clearStack(d, 400, -400, 3);

    const versions = [base, a, b, c, d, e];
    for (let i = 1; i < versions.length; i++) {
      const mirror = mirrorThrough(versions.slice(0, i + 1));
      expect(JSON.stringify(mirror), `after edit ${i}`).toEqual(
        JSON.stringify(versions[i]),
      );
    }
  });

  it("drops a level the map no longer has", () => {
    const withLevel = replaceStack(base, 300, 300, 6, [
      { tileId: "stone-wall" },
    ]);
    const gone: MapFile = {
      ...withLevel,
      levels: Object.fromEntries(
        Object.entries(withLevel.levels).filter(([lz]) => lz !== "6"),
      ),
    };
    const mirror = mirrorThrough([withLevel, gone]);
    expect(mirror.levels["6"]).toBeUndefined();
    expect(JSON.stringify(mirror)).toEqual(JSON.stringify(gone));
  });
});
