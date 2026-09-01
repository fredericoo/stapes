/**
 * A fall has to be *drawn* as one continuous descent.
 *
 * The simulation's own numbers were always smooth; what twitched was the step
 * between them and the screen. The map can only stand a tile on a surface, so a
 * fall passing through an odd absolute height is placed a unit low — and the
 * sprite used to be drawn from that cell, jumping a whole height unit down at
 * one boundary and back up at the next. Driving a real fall and watching the
 * drawn foot is the only way to see it: every frame in isolation looks fine.
 */
import { describe, expect, it } from "vitest";
import { FALL_MS_PER_HEIGHT } from "../game/constants";
import { GameSession } from "../game/GameSession";
import { PX_PER_HEIGHT } from "../lib/geometry";
import { emptyMap, replaceStack } from "../lib/mapData";
import { normalizeTileDef, type TileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { fallDropPx, standingFootAbs } from "./fallAnchor";

function tile(partial: Record<string, unknown>): TileDef {
  const frame = {
    sprite: {
      tilesetId: "basic",
      rect: { x: 0, y: 0, w: 1, h: 1 },
      base: { x: 0, y: 0 },
    },
    durationMs: 200,
  };
  return normalizeTileDef({
    name: partial.id,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    ...partial,
  });
}

const directionalFrames = {
  n: [{ sprite: { tilesetId: "basic", rect: { x: 0, y: 0, w: 1, h: 1 }, base: { x: 0, y: 0 } }, durationMs: 200 }],
  e: [{ sprite: { tilesetId: "basic", rect: { x: 0, y: 0, w: 1, h: 1 }, base: { x: 0, y: 0 } }, durationMs: 200 }],
  s: [{ sprite: { tilesetId: "basic", rect: { x: 0, y: 0, w: 1, h: 1 }, base: { x: 0, y: 0 } }, durationMs: 200 }],
  w: [{ sprite: { tilesetId: "basic", rect: { x: 0, y: 0, w: 1, h: 1 }, base: { x: 0, y: 0 } }, durationMs: 200 }],
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

/** Ground at z=0, with the player standing on nothing four levels up. */
function droppingSession(): GameSession {
  let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
  map = replaceStack(map, 0, 0, 4, [{ tileId: "player", direction: "s" }]);
  return new GameSession(map, tiles);
}

/** Where the sprite is drawn, in absolute height units. */
function drawnFootAbs(session: GameSession): number {
  const snap = session.getSnapshot();
  const anchor = standingFootAbs(snap.map, tilesById, snap.self, snap.self.stackIndex);
  return anchor - fallDropPx(snap.map, tilesById, snap.self) / PX_PER_HEIGHT;
}

const FRAME_MS = 16;
/** How far a fall covers in one frame, plus room for tick quantisation. */
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
      // The fall takes a tick to start, so "over" only counts once it began.
      const inFall = session.getSnapshot().self.fall !== null;
      if (falling && !inFall) break;
      falling = inFall;
    }

    // Each frame moves the sprite down a little, or holds — never up, and never
    // by the whole height unit the old anchor jumped by.
    for (const drop of drops) {
      expect(drop).toBeGreaterThanOrEqual(0);
      expect(drop).toBeLessThanOrEqual(MAX_STEP_PER_FRAME);
    }
    // And it actually fell the whole way: 16 height units down to the grass.
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
