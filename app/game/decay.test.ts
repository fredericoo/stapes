import { describe, expect, it } from "vitest";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { TICK_MS } from "./constants";
import { DecayIndex, applyDecay, findDecayCells } from "./decay";
import { GameSession } from "./GameSession";
import { Rng } from "./rng";

/** Fixed lifetimes, so a test asserts a deadline rather than a distribution. */
const BLOOD_MS = 1000;
const STAIN_MS = 2000;

/** The spread the jitter tests draw from. */
const JITTER_FROM_MS = 1000;
const JITTER_TO_MS = 5000;

function tile(
  partial: Record<string, unknown> & Pick<TileDef, "id" | "height">,
): TileDef {
  return normalizeTileDef({
    name: partial.id,
    directional: false,
    variants: {
      default: [
        {
          sprite: {
            tilesetId: "basic",
            rect: { x: 0, y: 0, w: 1, h: 1 },
            base: { x: 0, y: 0 },
          },
          durationMs: 200,
        },
      ],
    },
    attributes: {},
    ...partial,
  });
}

function directionalTile(id: string, extra: Record<string, unknown> = {}) {
  const frames = [
    {
      sprite: {
        tilesetId: "basic",
        rect: { x: 0, y: 0, w: 1, h: 1 },
        base: { x: 0, y: 0 },
      },
      durationMs: 200,
    },
  ];
  return normalizeTileDef({
    id,
    name: id,
    height: 2,
    directional: true,
    attributes: {},
    variants: { n: frames, e: frames, s: frames, w: frames },
    ...extra,
  });
}

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "wall", height: 2 }),
  directionalTile("player", { affectedByGravity: true, walkable: false }),
  // The motivating pair: blood dries to a stain, the stain fades to nothing.
  tile({
    id: "blood",
    height: 0,
    interactions: { decay: { tileId: "stain", fromMs: BLOOD_MS, toMs: BLOOD_MS } },
  }),
  tile({
    id: "stain",
    height: 0,
    interactions: { decay: { tileId: "", fromMs: STAIN_MS, toMs: STAIN_MS } },
  }),
  // Draws its lifetime from a spread rather than taking a fixed one.
  tile({
    id: "spatter",
    height: 0,
    interactions: {
      decay: { tileId: "", fromMs: JITTER_FROM_MS, toMs: JITTER_TO_MS },
    },
  }),
  // Rots into something that cannot fit under a load.
  tile({
    id: "swell",
    height: 0,
    interactions: { decay: { tileId: "wall", fromMs: BLOOD_MS, toMs: BLOOD_MS } },
  }),
  // Names a tile this world does not have.
  tile({
    id: "orphan",
    height: 0,
    interactions: { decay: { tileId: "nope", fromMs: BLOOD_MS, toMs: BLOOD_MS } },
  }),
  // Zero lifetime is not a decay at all.
  tile({
    id: "inert",
    height: 0,
    interactions: { decay: { tileId: "", fromMs: 0, toMs: 0 } },
  }),
  // Longest shorter than shortest — malformed, so inert.
  tile({
    id: "backwards",
    height: 0,
    interactions: { decay: { tileId: "", fromMs: 5000, toMs: 1000 } },
  }),
  // A body that decays — its runtime must not be stranded.
  directionalTile("ghoul", {
    actor: true,
    affectedByGravity: true,
    walkable: false,
    interactions: { decay: { tileId: "", fromMs: BLOOD_MS, toMs: BLOOD_MS } },
  }),
];

const tilesById = tilesByIdFromList(tiles);

/** Player parked away from the action; every map needs exactly one. */
function withIdlePlayer(map: MapFile): MapFile {
  return replaceStack(map, 9, 9, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "s" },
  ]);
}

function stackIds(map: MapFile, x: number, y: number, z = 0): string[] {
  return getStack(map, x, y, z).map((p) => p.tileId);
}

/**
 * Tick past `ms` of simulated time.
 *
 * One tick further than the arithmetic asks for, because a deadline lands
 * partway through a tick and is only served by the one after it — and because
 * a tick is not a whole millisecond, so summing thirty of them lands a hair
 * either side of a second.
 */
function run(session: GameSession, ms: number) {
  for (let i = 0; i <= Math.ceil(ms / TICK_MS); i++) session.tick(TICK_MS);
}

const ORIGIN = { x: 0, y: 0, z: 0 };

describe("findDecayCells", () => {
  it("finds decaying placements across levels and skips inert ones", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "blood" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "inert" }]);
    map = replaceStack(map, 2, 0, 0, [{ tileId: "backwards" }]);
    map = replaceStack(map, 4, 2, 3, [{ tileId: "stain" }]);
    expect(findDecayCells(map, tilesById)).toEqual([
      { x: 0, y: 0, z: 0 },
      { x: 4, y: 2, z: 3 },
    ]);
  });
});

describe("DecayIndex", () => {
  const armed = (map: MapFile) => {
    const index = new DecayIndex(new Rng());
    index.armCell(map, ORIGIN, tilesById);
    return index;
  };

  it("holds nothing until something decaying is armed", () => {
    const index = armed(replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]));
    expect(index.pending()).toBe(false);
  });

  it("yields an entry only once its lifetime has elapsed", () => {
    const index = armed(replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "blood" }]));
    expect(index.pending()).toBe(true);

    index.advance(BLOOD_MS - 1);
    expect(index.takeDue()).toEqual([]);

    index.advance(1);
    expect(index.takeDue()).toEqual([
      { cell: ORIGIN, tileId: "blood", dueMs: BLOOD_MS },
    ]);
    expect(index.pending()).toBe(false);
  });

  it("keeps the deadline a placement already has when its cell is re-armed", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "blood" }]);
    const index = armed(map);

    // Somebody walks over the blood every tick for most of its life. Re-stamping
    // here is what would make blood in a doorway immortal.
    for (let elapsed = 0; elapsed < BLOOD_MS; elapsed += TICK_MS) {
      index.advance(TICK_MS);
      index.armCell(map, ORIGIN, tilesById);
    }
    expect(index.takeDue()).toHaveLength(1);
  });

  it("serves everything due in one pass", () => {
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "blood" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "blood" }]);
    const index = new DecayIndex(new Rng());
    index.armCell(map, ORIGIN, tilesById);
    index.armCell(map, { x: 1, y: 0, z: 0 }, tilesById);

    index.advance(BLOOD_MS);
    expect(index.takeDue()).toHaveLength(2);
  });

  /** Deadlines drawn for `count` placements armed together at time zero. */
  function jitteredDeadlines(count: number, seed?: number): number[] {
    const index = new DecayIndex(new Rng(seed));
    let map = emptyMap();
    for (let x = 0; x < count; x++) {
      map = replaceStack(map, x, 0, 0, [{ tileId: "spatter" }]);
    }
    for (let x = 0; x < count; x++) {
      index.armCell(map, { x, y: 0, z: 0 }, tilesById);
    }
    index.advance(JITTER_TO_MS);
    return index.takeDue().map((e) => e.dueMs);
  }

  it("draws each lifetime from the authored range", () => {
    const deadlines = jitteredDeadlines(50);
    expect(deadlines).toHaveLength(50);
    for (const dueMs of deadlines) {
      expect(dueMs).toBeGreaterThanOrEqual(JITTER_FROM_MS);
      expect(dueMs).toBeLessThanOrEqual(JITTER_TO_MS);
    }
  });

  it("spreads a burst armed on the same tick across the range", () => {
    // The whole point of the range: fifty splashes placed together must not
    // share one deadline and clear the floor on a single frame.
    const distinct = new Set(jitteredDeadlines(50));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it("draws the same lifetimes from the same seed, and different from another", () => {
    expect(jitteredDeadlines(20, 1)).toEqual(jitteredDeadlines(20, 1));
    expect(jitteredDeadlines(20, 1)).not.toEqual(jitteredDeadlines(20, 2));
  });

  it("spends exactly one draw per placement, whatever the range", () => {
    // A draw count that varied with the authored numbers would make widening
    // one tile's range change what every creature after it rolled.
    const rng = new Rng(7);
    const index = new DecayIndex(rng);
    let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "blood" }]);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "spatter" }]);
    index.armCell(map, ORIGIN, tilesById);
    index.armCell(map, { x: 1, y: 0, z: 0 }, tilesById);

    const spent = new Rng(7);
    spent.next();
    spent.next();
    expect(rng.save()).toBe(spent.save());
  });

  it("neither redraws nor spends a draw when a cell is re-armed", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "spatter" }]);
    const rng = new Rng(3);
    const index = new DecayIndex(rng);
    index.armCell(map, ORIGIN, tilesById);
    const afterFirst = rng.save();

    for (let i = 0; i < 10; i++) index.armCell(map, ORIGIN, tilesById);
    expect(rng.save()).toBe(afterFirst);

    index.advance(JITTER_TO_MS);
    const due = index.takeDue();
    expect(due).toHaveLength(1);
    expect(due[0]!.dueMs).toBe(JITTER_FROM_MS + new Rng(3).int(
      JITTER_TO_MS - JITTER_FROM_MS + 1,
    ));
  });
});

describe("applyDecay", () => {
  const due = (tileId: string) => [{ cell: ORIGIN, tileId, dueMs: 0 }];

  it("swaps in the target and keeps everything else in the stack", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "blood", description: "spattered" },
    ]);
    const result = applyDecay(map, due("blood"), tilesById);
    expect(stackIds(result.map, 0, 0)).toEqual(["grass", "stain"]);
    expect(getStack(result.map, 0, 0, 0)[1]).toEqual({
      tileId: "stain",
      description: "spattered",
    });
    expect(result.changed).toEqual([ORIGIN]);
  });

  it("removes the placement when no target is named", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "grass" },
      { tileId: "stain" },
    ]);
    const result = applyDecay(map, due("stain"), tilesById);
    expect(stackIds(result.map, 0, 0)).toEqual(["grass"]);
  });

  it("clears the cell when the last placement in it goes", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "stain" }]);
    const result = applyDecay(map, due("stain"), tilesById);
    expect(stackIds(result.map, 0, 0)).toEqual([]);
  });

  it("abandons a swap that would not fit under its own load", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "swell" },
      { tileId: "wall" },
    ]);
    const result = applyDecay(map, due("swell"), tilesById);
    expect(result.map).toBe(map);
    expect(result.changed).toEqual([]);
  });

  it("leaves a tile whose target this world does not have", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "orphan" }]);
    const result = applyDecay(map, due("orphan"), tilesById);
    expect(result.map).toBe(map);
  });

  it("leaves a placement somebody is driving", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [
      { tileId: "ghoul", owner: "someone" },
    ]);
    const result = applyDecay(map, due("ghoul"), tilesById);
    expect(result.map).toBe(map);
  });

  it("does nothing for an entry whose placement has already gone", () => {
    const map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
    const result = applyDecay(map, due("blood"), tilesById);
    expect(result.map).toBe(map);
  });
});

describe("GameSession decay", () => {
  it("ages authored decay from the moment the world opens", () => {
    const map = withIdlePlayer(
      replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId: "blood" }]),
    );
    const session = new GameSession(map, tiles);
    expect(stackIds(session.getMap(), 0, 0)).toEqual(["grass", "blood"]);

    run(session, BLOOD_MS);
    expect(stackIds(session.getMap(), 0, 0)).toEqual(["grass", "stain"]);
  });

  it("chains through a tile that decays in turn", () => {
    const map = withIdlePlayer(
      replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId: "blood" }]),
    );
    const session = new GameSession(map, tiles);

    run(session, BLOOD_MS + STAIN_MS);
    expect(stackIds(session.getMap(), 0, 0)).toEqual(["grass"]);
  });

  it("does not rest while anything is counting down", () => {
    const map = withIdlePlayer(
      replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId: "stain" }]),
    );
    const session = new GameSession(map, tiles);
    expect(session.isAtRest()).toBe(false);

    run(session, STAIN_MS);
    expect(stackIds(session.getMap(), 0, 0)).toEqual(["grass"]);
    expect(session.isAtRest()).toBe(true);
  });

  it("leaves a world with nothing decaying at rest", () => {
    const session = new GameSession(withIdlePlayer(emptyMap()), tiles);
    expect(session.isAtRest()).toBe(true);
  });

  it("does not offer decay as something the player can click", () => {
    const map = withIdlePlayer(
      replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId: "blood" }]),
    );
    const session = new GameSession(map, tiles);
    const ref = { x: 0, y: 0, z: 0, stackIndex: 1 };
    expect(session.canInteract(ref)).toBe(false);
    expect(session.interact(ref)).toBe(false);
  });
});
