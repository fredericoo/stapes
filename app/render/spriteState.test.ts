import { describe, expect, it } from "vitest";
import { GameSession } from "../game/GameSession";
import { TICK_MS, WALK_DURATION_MS } from "../game/constants";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";
import { spriteStatesFor } from "./spriteState";
import { tileInstanceKey } from "./WorldRenderer";
import { FRAME, tile } from "../lib/testTile";

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({
    id: "player",
    height: 4,
    directional: true,
    affectedByGravity: true,
    walkable: false,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
  }),
];

const FLOOR_SIZE = 8;

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
    expect(states!.size).toBe(1);
  });

  it("leaves a falling body idle, walk cycle and all", () => {
    let map = floor();
    map = replaceStack(map, 0, 0, 1, [{ tileId: "player", direction: "e" } as PlacedTile]);
    map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" } as PlacedTile]);
    const session = new GameSession(map, tiles);

    let falling = false;
    for (let i = 0; i < 20 && !falling; i++) {
      session.update(TICK_MS);
      falling = session.getSnapshot().self.fall != null;
    }

    expect(falling, "the player never started falling").toBe(true);
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

    session.setInput({ directions: [] });
    const ticks = Math.ceil(WALK_DURATION_MS / TICK_MS) + 4;
    for (let i = 0; i < ticks; i++) session.update(TICK_MS);

    expect(spriteStatesFor(session.getSnapshot().actors)).toBeUndefined();
  });
});
