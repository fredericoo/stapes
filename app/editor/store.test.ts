import { beforeEach, describe, expect, it } from "vitest";
import { getStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { useEditorStore } from "./store";

const tiles: TileDef[] = [
  normalizeTileDef({
    id: "grass",
    name: "Grass",
    height: 0,
    directional: false,
    variants: {
      default: [
        {
          sprite: {
            tilesetId: "t",
            rect: { x: 0, y: 0, w: 1, h: 1 },
            base: { x: 0, y: 0 },
          },
          durationMs: 200,
        },
      ],
    },
    attributes: {},
  }),
  normalizeTileDef({
    id: "rock",
    name: "Rock",
    height: 1,
    directional: false,
    variants: {
      default: [
        {
          sprite: {
            tilesetId: "t",
            rect: { x: 8, y: 0, w: 1, h: 1 },
            base: { x: 0, y: 0 },
          },
          durationMs: 200,
        },
      ],
    },
    attributes: {},
  }),
];

const seedMap: MapFile = {
  version: 1,
  levels: {
    "0": {
      "1,2": [{ tileId: "grass" }, { tileId: "rock" }],
    },
  },
};

describe("editor store history", () => {
  beforeEach(() => {
    useEditorStore.getState().hydrate(structuredClone(seedMap), tiles);
    useEditorStore.getState().selectCoord(1, 2);
  });

  it("removeFromStack records an undoable entry", () => {
    const store = useEditorStore.getState();
    expect(getStack(store.map, 1, 2, 0)).toHaveLength(2);

    store.removeFromStack(1);
    expect(getStack(useEditorStore.getState().map, 1, 2, 0)).toEqual([
      { tileId: "grass" },
    ]);
    expect(useEditorStore.getState().past).toHaveLength(1);

    useEditorStore.getState().undo();
    expect(getStack(useEditorStore.getState().map, 1, 2, 0)).toEqual([
      { tileId: "grass" },
      { tileId: "rock" },
    ]);
  });

  it("discrete commits stay undoable during an open stroke", () => {
    const store = useEditorStore.getState();
    store.beginStroke();
    expect(useEditorStore.getState().strokeBase).not.toBeNull();
    expect(useEditorStore.getState().past).toHaveLength(0);

    // Backspace / stack-panel edits must not be swallowed by strokeBase.
    store.removeFromStack(1);

    const after = useEditorStore.getState();
    expect(after.strokeBase).toBeNull();
    expect(after.past).toHaveLength(1);
    expect(getStack(after.map, 1, 2, 0)).toEqual([{ tileId: "grass" }]);

    after.undo();
    expect(getStack(useEditorStore.getState().map, 1, 2, 0)).toEqual([
      { tileId: "grass" },
      { tileId: "rock" },
    ]);
  });
});

describe("editor store paint", () => {
  beforeEach(() => {
    useEditorStore.getState().hydrate(structuredClone(seedMap), tiles);
    useEditorStore.getState().setSelected(null);
    useEditorStore.getState().setArmedTileId(null);
  });

  it("stampAt with a selection copies the stack without moving selection", () => {
    const store = useEditorStore.getState();
    store.selectCoord(1, 2);
    store.beginStroke();
    const r = store.stampAt(3, 4);
    store.endStroke();

    expect(r.skipped).toBe(false);
    expect(useEditorStore.getState().selected).toEqual({ x: 1, y: 2 });
    expect(getStack(useEditorStore.getState().map, 3, 4, 0)).toEqual([
      { tileId: "grass" },
      { tileId: "rock" },
    ]);
  });

  it("stampAt without selection appends the armed tile", () => {
    const store = useEditorStore.getState();
    store.setArmedTileId("grass");
    store.beginStroke();
    const r = store.stampAt(5, 5);
    store.endStroke();

    expect(r.skipped).toBe(false);
    expect(useEditorStore.getState().selected).toBeNull();
    expect(getStack(useEditorStore.getState().map, 5, 5, 0)).toEqual([
      { tileId: "grass" },
    ]);
  });

  it("stampAt without selection or armed tile is a no-op", () => {
    const r = useEditorStore.getState().stampAt(5, 5);
    expect(r).toEqual({ skipped: true, reason: "No tile armed" });
    expect(getStack(useEditorStore.getState().map, 5, 5, 0)).toEqual([]);
  });

  it("stampMany without selection appends armed tile to each cell", () => {
    const store = useEditorStore.getState();
    store.setArmedTileId("rock");
    const r = store.stampMany([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);

    expect(r.skipped).toBe(0);
    expect(useEditorStore.getState().selected).toBeNull();
    expect(getStack(useEditorStore.getState().map, 0, 0, 0)).toEqual([
      { tileId: "rock" },
    ]);
    expect(getStack(useEditorStore.getState().map, 1, 0, 0)).toEqual([
      { tileId: "rock" },
    ]);
  });
});
