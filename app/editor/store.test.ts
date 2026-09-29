import { MAP_FILE_VERSION } from "../lib/types";
import { beforeEach, describe, expect, it } from "vitest";
import { chunkifyMap } from "../lib/mapData";
import { getStack, replaceStack } from "../lib/mapData";
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
    height: 2,
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

const holeSprite = (tilesetId: string) => ({
  frames: [
    {
      sprite: {
        tilesetId,
        rect: { x: 0, y: 0, w: 1, h: 1 },
        base: { x: 0, y: 0 },
      },
      durationMs: 200,
    },
  ],
});

const hole: TileDef = normalizeTileDef({
  id: "hole",
  name: "Hole",
  height: 0,
  type: "variant",
  kind: "prop",
  attributes: {},
  variants: {
    grass: holeSprite("grass-sheet"),
    planks: holeSprite("planks-sheet"),
  },
});

const seedMap: MapFile = chunkifyMap({
  version: MAP_FILE_VERSION,
  levels: {
    "0": {
      "1,2": [{ tileId: "grass" }, { tileId: "rock" }],
    },
  },
});

describe("editor store history", () => {
  beforeEach(() => {
    useEditorStore.getState().hydrate(structuredClone(seedMap), tiles);
    useEditorStore.getState().selectCoord(1, 2);
  });

  it("removeFromStack records an undoable entry", () => {
    const store = useEditorStore.getState();
    expect(getStack(store.map, 1, 2, 0)).toHaveLength(2);

    store.removeFromStack(1);
    expect(getStack(useEditorStore.getState().map, 1, 2, 0)).toEqual([{ tileId: "grass" }]);
    expect(useEditorStore.getState().past).toHaveLength(1);

    useEditorStore.getState().undo();
    expect(getStack(useEditorStore.getState().map, 1, 2, 0)).toEqual([
      { tileId: "grass" },
      { tileId: "rock" },
    ]);
  });

  it("setStackFoot lifts a placement, refuses what will not fit, and undoes", () => {
    const store = useEditorStore.getState();
    expect(store.setStackFoot(1, 2)).toEqual({ ok: true });
    expect(getStack(useEditorStore.getState().map, 1, 2, 0)).toEqual([
      { tileId: "grass" },
      { tileId: "rock", foot: 2 },
    ]);

    const tooHigh = useEditorStore.getState().setStackFoot(1, 3);
    expect(tooHigh.ok).toBe(false);
    expect(getStack(useEditorStore.getState().map, 1, 2, 0)[1]!.foot).toBe(2);

    useEditorStore.getState().setStackFoot(1, null);
    expect(getStack(useEditorStore.getState().map, 1, 2, 0)).toEqual([
      { tileId: "grass" },
      { tileId: "rock" },
    ]);

    useEditorStore.getState().undo();
    expect(getStack(useEditorStore.getState().map, 1, 2, 0)[1]!.foot).toBe(2);
  });

  it("setStackChannel wires, unwires and stays undoable", () => {
    const store = useEditorStore.getState();
    store.setStackChannel(1, "gate-a");
    expect(getStack(useEditorStore.getState().map, 1, 2, 0)).toEqual([
      { tileId: "grass" },
      { tileId: "rock", channel: "gate-a" },
    ]);

    useEditorStore.getState().setStackChannel(1, "   ");
    expect(getStack(useEditorStore.getState().map, 1, 2, 0)).toEqual([
      { tileId: "grass" },
      { tileId: "rock" },
    ]);

    useEditorStore.getState().undo();
    expect(getStack(useEditorStore.getState().map, 1, 2, 0)).toEqual([
      { tileId: "grass" },
      { tileId: "rock", channel: "gate-a" },
    ]);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().past).toHaveLength(0);
  });

  it("removeUnfit takes off what does not fit as one undoable entry", () => {
    const tooTall = replaceStack(seedMap, 1, 2, 0, [
      { tileId: "grass" },
      { tileId: "rock" },
      { tileId: "rock" },
      { tileId: "rock" },
    ]);
    useEditorStore.getState().hydrate(tooTall, tiles);

    const removed = useEditorStore.getState().removeUnfit();

    expect(removed).toEqual([expect.objectContaining({ x: 1, y: 2, z: 0, tileId: "rock" })]);
    expect(getStack(useEditorStore.getState().map, 1, 2, 0)).toHaveLength(3);
    expect(useEditorStore.getState().past).toHaveLength(1);

    useEditorStore.getState().undo();
    expect(getStack(useEditorStore.getState().map, 1, 2, 0)).toEqual(getStack(tooTall, 1, 2, 0));
  });

  it("discrete commits stay undoable during an open stroke", () => {
    const store = useEditorStore.getState();
    store.beginStroke();
    expect(useEditorStore.getState().strokeBase).not.toBeNull();
    expect(useEditorStore.getState().past).toHaveLength(0);

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
    expect(getStack(useEditorStore.getState().map, 5, 5, 0)).toEqual([{ tileId: "grass" }]);
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
    expect(getStack(useEditorStore.getState().map, 0, 0, 0)).toEqual([{ tileId: "rock" }]);
    expect(getStack(useEditorStore.getState().map, 1, 0, 0)).toEqual([{ tileId: "rock" }]);
  });
});

describe("the armed face is a brush setting", () => {
  beforeEach(() => {
    useEditorStore.getState().setArmedTileId(null);
    useEditorStore.getState().hydrate(structuredClone(seedMap), [...tiles, hole]);
  });

  it("writes the armed face onto every placement it lays down", () => {
    const store = useEditorStore.getState();
    store.setArmedTileId("hole");
    store.setArmedVariant("planks");
    store.stampAt(4, 4);
    store.stampMany([{ x: 5, y: 4 }]);

    for (const [x, y] of [
      [4, 4],
      [5, 4],
    ] as const) {
      const top = getStack(useEditorStore.getState().map, x, y, 0).at(-1);
      expect(top).toEqual({ tileId: "hole", variant: "planks" });
    }
  });

  it("drops the face when a different tile is armed", () => {
    const store = useEditorStore.getState();
    store.setArmedTileId("hole");
    store.setArmedVariant("planks");
    store.setArmedTileId("grass");
    expect(useEditorStore.getState().armedVariant).toBeNull();
  });

  it("keeps the face when the same tile is re-armed", () => {
    const store = useEditorStore.getState();
    store.setArmedTileId("hole");
    store.setArmedVariant("planks");
    store.setArmedTileId("hole");
    expect(useEditorStore.getState().armedVariant).toBe("planks");
  });

  it("writes no face when none is armed", () => {
    const store = useEditorStore.getState();
    store.setArmedTileId("hole");
    store.stampAt(6, 4);
    expect(getStack(useEditorStore.getState().map, 6, 4, 0).at(-1)).toEqual({
      tileId: "hole",
    });
  });

  it("changes the face on a placement already down", () => {
    const store = useEditorStore.getState();
    store.setArmedTileId("hole");
    store.setArmedVariant("planks");
    store.stampAt(7, 4);
    store.selectCoord(7, 4);
    useEditorStore.getState().setStackVariant(0, "grass");
    expect(getStack(useEditorStore.getState().map, 7, 4, 0)[0]).toEqual({
      tileId: "hole",
      variant: "grass",
    });
  });
});
