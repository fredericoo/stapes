import { describe, expect, it } from "vitest";
import { FALL_MS_PER_HEIGHT } from "../game/constants";
import { GameSession } from "../game/GameSession";
import { PX_PER_HEIGHT } from "../lib/geometry";
import { emptyMap, replaceStack } from "../lib/mapData";
import { type TileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { fallDropPx, standingFootAbs } from "./fallAnchor";
import { tile } from "../lib/testTile";

const directionalFrames = {
  n: [
    {
      sprite: { tilesetId: "basic", rect: { x: 0, y: 0, w: 1, h: 1 }, base: { x: 0, y: 0 } },
      durationMs: 200,
    },
  ],
  e: [
    {
      sprite: { tilesetId: "basic", rect: { x: 0, y: 0, w: 1, h: 1 }, base: { x: 0, y: 0 } },
      durationMs: 200,
    },
  ],
  s: [
    {
      sprite: { tilesetId: "basic", rect: { x: 0, y: 0, w: 1, h: 1 }, base: { x: 0, y: 0 } },
      durationMs: 200,
    },
  ],
  w: [
    {
      sprite: { tilesetId: "basic", rect: { x: 0, y: 0, w: 1, h: 1 }, base: { x: 0, y: 0 } },
      durationMs: 200,
    },
  ],
};

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({
    id: "player",
    height: 4,
    directional: true,
    affectedByGravity: true,
    walkable: false,
    variants: directionalFrames,
  }),
];
const tilesById = tilesByIdFromList(tiles);

function droppingSession(): GameSession {
  let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
  map = replaceStack(map, 0, 0, 4, [{ tileId: "player", direction: "s" }]);
  return new GameSession(map, tiles);
}

function drawnFootAbs(session: GameSession): number {
  const snap = session.getSnapshot();
  const anchor = standingFootAbs(snap.map, tilesById, snap.self, snap.self.stackIndex);
  return anchor - fallDropPx(snap.map, tilesById, snap.self) / PX_PER_HEIGHT;
}

const FRAME_MS = 16;
const MAX_STEP_PER_FRAME = (FRAME_MS / FALL_MS_PER_HEIGHT) * 1.5;

describe("drawing a fall", () => {
  it("descends without ever jumping or backing up", () => {
    const session = droppingSession();
    let previous = drawnFootAbs(session);
    const drops: number[] = [];

    let falling = false;
    for (let elapsed = 0; elapsed < 4000; elapsed += FRAME_MS) {
      session.update(FRAME_MS);
      const foot = drawnFootAbs(session);
      drops.push(previous - foot);
      previous = foot;
      const inFall = session.getSnapshot().self.fall !== null;
      if (falling && !inFall) break;
      falling = inFall;
    }

    for (const drop of drops) {
      expect(drop).toBeGreaterThanOrEqual(0);
      expect(drop).toBeLessThanOrEqual(MAX_STEP_PER_FRAME);
    }
    expect(previous).toBe(0);
  });

  it("starts the drop exactly where the actor was standing", () => {
    const session = droppingSession();
    const before = drawnFootAbs(session);

    session.update(FRAME_MS);

    expect(before).toBe(16);
    expect(drawnFootAbs(session)).toBeLessThanOrEqual(before);
  });
});
