/**
 * The claim the `moving` sprite rests on: a body that is crossing a cell reads as
 * moving for exactly as long as it is doing so, and everything else reads as
 * idle.
 *
 * Driven by a real {@link GameSession} rather than by hand-built snapshots,
 * because the fact being read is one the simulation owns: `walk` is set when a
 * step commits and cleared when it lands, and a test that fabricated those would
 * pass while the renderer showed a deer skating along in its grazing pose.
 */
import { describe, expect, it } from "vitest";
import { GameSession } from "../game/GameSession";
import { TICK_MS, WALK_DURATION_MS } from "../game/constants";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { spriteStatesFor } from "./spriteState";
import { tileInstanceKey } from "./WorldRenderer";

const frame = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

function tile(
  partial: Record<string, unknown> & Pick<TileDef, "id" | "height">,
): TileDef {
  return normalizeTileDef({
    name: partial.id,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    ...partial,
  });
}

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({
    id: "player",
    height: 4,
    directional: true,
    affectedByGravity: true,
    walkable: false,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
  }),
];

const FLOOR_SIZE = 8;

/** Flat grass with the player in a corner, free to walk east. */
function floor(): MapFile {
  let map = emptyMap();
  for (let x = 0; x < FLOOR_SIZE; x++) {
    for (let y = 0; y < FLOOR_SIZE; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" } as PlacedTile]);
    }
  }
  map = replaceStack(map, 0, 0, 0, [
    { tileId: "grass" } as PlacedTile,
    { tileId: "player", direction: "e" } as PlacedTile,
  ]);
  return map;
}

describe("spriteStatesFor", () => {
  it("says nothing at all when nobody is moving", () => {
    const session = new GameSession(floor(), tiles);
    session.update(TICK_MS);
    // Undefined rather than an empty map: the renderer short-circuits on the
    // absence, and this is the shape of almost every frame.
    expect(spriteStatesFor(session.getSnapshot().actors)).toBeUndefined();
  });

  it("marks a walking body moving, at the cell the map still holds it in", () => {
    const session = new GameSession(floor(), tiles);
    session.setInput({ directions: ["e"] });

    let states: Map<string, string> | undefined;
    for (let i = 0; i < 20 && !states; i++) {
      session.update(TICK_MS);
      states = spriteStatesFor(session.getSnapshot().actors);
    }

    expect(states, "the player never started walking").toBeDefined();
    const self = session.getSnapshot().self;
    expect(states!.get(tileInstanceKey(self))).toBe("moving");
    // Only the mover. Nothing else in an 8x8 grass floor is doing anything.
    expect(states!.size).toBe(1);
  });

  it("leaves a falling body idle, walk cycle and all", () => {
    // A ledge with nothing under it: the player is dropped a level above the
    // grass and gravity takes it from there.
    let map = floor();
    map = replaceStack(map, 0, 0, 1, [
      { tileId: "player", direction: "e" } as PlacedTile,
    ]);
    map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" } as PlacedTile]);
    const session = new GameSession(map, tiles);

    let falling = false;
    for (let i = 0; i < 20 && !falling; i++) {
      session.update(TICK_MS);
      falling = session.getSnapshot().self.fall != null;
    }

    expect(falling, "the player never started falling").toBe(true);
    // The `moving` sprite is a walk cycle. Mid-air legs are not a fall.
    expect(spriteStatesFor(session.getSnapshot().actors)).toBeUndefined();
  });

  it("goes back to idle once the step lands", () => {
    const session = new GameSession(floor(), tiles);
    session.setInput({ directions: ["e"] });

    let started = false;
    for (let i = 0; i < 20 && !started; i++) {
      session.update(TICK_MS);
      started = spriteStatesFor(session.getSnapshot().actors) != null;
    }
    expect(started, "the player never started walking").toBe(true);

    // Let go, and give the walk in flight more than its own duration to land.
    session.setInput({ directions: [] });
    const ticks = Math.ceil(WALK_DURATION_MS / TICK_MS) + 4;
    for (let i = 0; i < ticks; i++) session.update(TICK_MS);

    expect(spriteStatesFor(session.getSnapshot().actors)).toBeUndefined();
  });
});
