import { describe, expect, it } from "vitest";
import {
  parseTileTransitions,
  type HeldTransition,
  type TileTransitionNote,
  type Transition,
} from "../lib/tileTransition";
import { DEFAULT_PARTICLES } from "../lib/particleVfx";
import { CELL_SIZE } from "../lib/types";
import {
  LIGHT_FADE_STEP_MS,
  MAX_LIVE_TRANSITIONS,
  NO_TRANSITION_UNIFORMS,
  admitTransitions,
  appendTransitionEmitters,
  goingPlumeId,
  placementIdentity,
  fadingLightScale,
  isFinished,
  liveShown,
  pixelSnappedQuad,
  resolveTransitionSlot,
  transitionAddress,
  transitionPose,
  transitionUniforms,
  type LiveTransition,
  type TransitionIntake,
} from "./tileTransitions";

/**
 * Which transitions a renderer takes on, how far along each is, and what the
 * shader is told — everything about playing one that is arithmetic rather than
 * pixels.
 */

const DURATION_MS = 700;

function sideOf(raw: unknown): Transition {
  const parsed = parseTileTransitions({ appear: raw });
  if (!parsed?.appear) throw new Error("fixture does not parse");
  return parsed.appear;
}

const sweep = sideOf({
  durationMs: DURATION_MS,
  dissolve: {
    pattern: "sweep",
    from: { x: -1, y: -1 },
    edgeColor: "#ffffff",
    edgeWidth: 0.2,
  },
});

const shrink = sideOf({ durationMs: DURATION_MS, scale: {} });

function note(
  id: string,
  side: TileTransitionNote["side"] = "appear",
): TileTransitionNote {
  return { id, side, tileId: "flame", x: 1, y: 2, z: 0, stackIndex: 1 };
}

function heard(id: string, ageMs = 0): HeldTransition {
  return { note: note(id), ageMs };
}

function intake(overrides: Partial<TransitionIntake> = {}): TransitionIntake {
  return {
    clockMs: 10_000,
    live: 0,
    transitionOf: () => sweep,
    inWindow: () => true,
    ...overrides,
  };
}

describe("admitTransitions", () => {
  it("starts one as far in as it waited", () => {
    expect(admitTransitions([heard("a", 50)], intake())).toEqual([
      { note: note("a"), transition: sweep, startMs: 10_000 - 50 },
    ]);
  });

  it("drops one this client has nothing authored for", () => {
    expect(
      admitTransitions([heard("a")], intake({ transitionOf: () => undefined })),
    ).toEqual([]);
  });

  it("drops one that has already had its whole duration", () => {
    expect(admitTransitions([heard("a", DURATION_MS)], intake())).toEqual([]);
  });

  it("drops one nobody could see", () => {
    expect(admitTransitions([heard("a")], intake({ inWindow: () => false }))).toEqual(
      [],
    );
  });

  it("stops at the cap, counting what is already playing, oldest first", () => {
    const many = Array.from({ length: MAX_LIVE_TRANSITIONS }, (_, i) =>
      heard(`t${i}`),
    );
    const admitted = admitTransitions(many, intake({ live: 2 }));
    expect(admitted).toHaveLength(MAX_LIVE_TRANSITIONS - 2);
    expect(admitted[0]?.note.id).toBe("t0");
  });
});

describe("progress", () => {
  const live: LiveTransition = { note: note("a"), transition: sweep, startMs: 1000 };

  it("reads how much is showing off the renderer's own clock", () => {
    expect(liveShown(live, 1000)).toBe(0);
    expect(liveShown(live, 1000 + DURATION_MS / 2)).toBe(0.5);
    expect(liveShown(live, 1000 + DURATION_MS)).toBe(1);
  });

  it("is finished once its duration is up", () => {
    expect(isFinished(live, 1000 + DURATION_MS - 1)).toBe(false);
    expect(isFinished(live, 1000 + DURATION_MS)).toBe(true);
  });

  it("keys a placement by its cell and slot", () => {
    expect(transitionAddress(note("a"))).toBe("0:1,2#1");
  });
});

describe("fadingLightScale", () => {
  it("only ever changes on the shared grid, however each fade was timed", () => {
    const early: LiveTransition = {
      note: note("a", "disappear"),
      transition: shrink,
      startMs: 37,
    };
    const late: LiveTransition = {
      note: note("b", "disappear"),
      transition: shrink,
      startMs: 212,
    };

    const changedAt: number[] = [];
    let before = [fadingLightScale(early, 0), fadingLightScale(late, 0)];
    for (let clockMs = 1; clockMs <= 1500; clockMs++) {
      const now = [fadingLightScale(early, clockMs), fadingLightScale(late, clockMs)];
      if (now[0] !== before[0] || now[1] !== before[1]) changedAt.push(clockMs);
      before = now;
    }

    expect(changedAt.length).toBeGreaterThan(0);
    expect(changedAt.every((clockMs) => clockMs % LIGHT_FADE_STEP_MS === 0)).toBe(
      true,
    );
  });

  it("is full before the fade's first grid line and gone after its last", () => {
    const live: LiveTransition = {
      note: note("a", "disappear"),
      transition: shrink,
      startMs: 100,
    };
    expect(fadingLightScale(live, 120)).toBe(1);
    expect(fadingLightScale(live, 100 + DURATION_MS + LIGHT_FADE_STEP_MS)).toBe(0);
  });
});

describe("transitionUniforms", () => {
  const sprite = { centreX: 100, centreY: 200, w: 16, h: 16 };

  it("starts a sweep a cell from the sprite's middle, and spans to its far corner", () => {
    const u = transitionUniforms(
      { note: note("a"), transition: sweep, startMs: 0 },
      sprite,
    );
    expect(u.uFxEnabled.value).toBe(1);
    expect(u.uFxOriginPx.value.x).toBe(100 - CELL_SIZE);
    expect(u.uFxOriginPx.value.y).toBe(200 - CELL_SIZE);
    // The far corner is down-right: a cell plus half a sprite on each axis.
    const reach = CELL_SIZE + sprite.w / 2;
    expect(u.uFxSpanPx.value).toBeCloseTo(Math.hypot(reach, reach), 6);
    expect(u.uFxSweepAppear.value).toBe(1);
  });

  it("sweeps the other way round for a tile that is going", () => {
    const u = transitionUniforms(
      { note: note("a", "disappear"), transition: sweep, startMs: 0 },
      sprite,
    );
    expect(u.uFxSweepAppear.value).toBe(0);
  });

  it("hands the edge colour over in linear light", () => {
    const u = transitionUniforms(
      { note: note("a"), transition: sweep, startMs: 0 },
      sprite,
    );
    expect(u.uFxEdgeColor.value.toArray()).toEqual([1, 1, 1]);
  });

  it("dissolves nothing for a transition that only scales", () => {
    const u = transitionUniforms(
      { note: note("a"), transition: shrink, startMs: 0 },
      sprite,
    );
    expect(u.uFxEnabled.value).toBe(1);
    expect(u.uFxPattern.value).toBe(0);
  });

  it("leaves every other material on the skipped branch", () => {
    expect(NO_TRANSITION_UNIFORMS.uFxEnabled.value).toBe(0);
  });
});

describe("resolveTransitionSlot", () => {
  const placed = (...ids: string[]) => ids.map((tileId) => ({ tileId }));

  it("trusts the slot while the tile it names is still there", () => {
    expect(
      resolveTransitionSlot(placed("grass", "flame"), { tileId: "flame", stackIndex: 1 }),
    ).toBe(1);
  });

  it("takes the cell's only copy when something shifted it", () => {
    expect(
      resolveTransitionSlot(placed("grass", "berry", "flame"), {
        tileId: "flame",
        stackIndex: 1,
      }),
    ).toBe(2);
  });

  it("cannot say which of two copies was meant", () => {
    expect(
      resolveTransitionSlot(placed("grass", "flame", "flame"), {
        tileId: "flame",
        stackIndex: 0,
      }),
    ).toBeUndefined();
  });

  it("finds nothing where the tile is not", () => {
    expect(
      resolveTransitionSlot(placed("grass"), { tileId: "flame", stackIndex: 1 }),
    ).toBeUndefined();
  });
});

describe("transitionPose", () => {
  const dropping = sideOf({ durationMs: DURATION_MS, drop: { levels: 2 } });

  it("leaves a sprite whole and in place when it neither scales nor drops", () => {
    expect(transitionPose(sweep, 0)).toEqual({ scale: 1, dropLevels: 0 });
  });

  it("grows a scaling sprite from nothing", () => {
    expect(transitionPose(shrink, 0).scale).toBe(0);
    expect(transitionPose(shrink, 0.5).scale).toBe(0.5);
    expect(transitionPose(shrink, 1).scale).toBe(1);
  });

  it("lands a dropping sprite from its authored height", () => {
    expect(transitionPose(dropping, 0).dropLevels).toBe(2);
    expect(transitionPose(dropping, 0.5).dropLevels).toBe(1);
    expect(transitionPose(dropping, 1).dropLevels).toBe(0);
  });
});

describe("pixelSnappedQuad", () => {
  // A 16×16 sprite whose base cell is its lower-right one, like the flame.
  const quad = { centreX: 100, centreY: 200, pivotX: 104, pivotY: 204, w: 16, h: 16 };

  it("leaves a whole quad exactly where it was", () => {
    expect(pixelSnappedQuad(quad, { scale: 1, dropLevels: 0 })).toEqual({
      scaleX: 1,
      scaleY: 1,
      x: 100,
      y: 200,
      dropLevels: 0,
    });
  });

  it("keeps every edge on a whole world pixel at any scale", () => {
    for (const scale of [0.1, 0.33, 0.5, 0.77, 0.9]) {
      const at = pixelSnappedQuad(quad, { scale, dropLevels: 0.4 });
      const w = quad.w * at.scaleX;
      const h = quad.h * at.scaleY;
      expect(Number.isInteger(w) && Number.isInteger(h)).toBe(true);
      expect(Number.isInteger(at.x - w / 2)).toBe(true);
      expect(Number.isInteger(at.y - h / 2)).toBe(true);
    }
  });

  it("shrinks towards the middle of the base cell, not the sprite's", () => {
    const tiny = pixelSnappedQuad(quad, { scale: 0.125, dropLevels: 0 });
    expect(Math.abs(tiny.x - quad.pivotX)).toBeLessThanOrEqual(1);
    expect(Math.abs(tiny.y - quad.pivotY)).toBeLessThanOrEqual(1);
  });
});

describe("pixelSnappedQuad's drop", () => {
  const quad = { centreX: 100, centreY: 200, pivotX: 100, pivotY: 200, w: 8, h: 8 };

  it("lifts by whole pixels and reports the storeys actually drawn", () => {
    for (const levels of [0.1, 0.33, 1, 1.7]) {
      const at = pixelSnappedQuad(quad, { scale: 1, dropLevels: levels });
      const liftPx = quad.centreX - at.x;
      expect(Number.isInteger(liftPx)).toBe(true);
      expect(at.dropLevels * CELL_SIZE).toBeCloseTo(liftPx, 9);
    }
  });
});

describe("appendTransitionEmitters", () => {
  const spec = (id: string) => ({
    id,
    config: DEFAULT_PARTICLES,
    cx: 1.5,
    cy: 2.5,
    footElev: 0,
    z: 0,
    box: { eastPx: 16, southPx: 24, foot: 0, top: 4 },
    stackBias: 0,
    taper: 1,
  });
  const at = (side: TileTransitionNote["side"], startMs: number): LiveTransition => ({
    note: note("t1", side),
    transition: shrink,
    startMs,
  });

  it("thins a forming tile's own plume in with it, without touching the chunk's spec", () => {
    for (const [clockMs, shown] of [[0, 0], [DURATION_MS / 2, 0.5], [DURATION_MS, 1]] as const) {
      const own = spec("plume:0:1,2#1");
      const out = [own];
      appendTransitionEmitters(
        out,
        [{ live: at("appear", 0), plumeId: own.id, plume: null, burst: null }],
        clockMs,
      );
      expect(out[0]?.taper).toBe(shown);
      expect(own.taper).toBe(1);
    }
  });

  it("carries a dissolving tile's plume on under an id of its own, winding down", () => {
    for (const [clockMs, shown] of [[0, 1], [DURATION_MS / 2, 0.5], [DURATION_MS, 0]] as const) {
      const out: ReturnType<typeof spec>[] = [spec("plume:0:1,2#1")];
      appendTransitionEmitters(
        out,
        [{ live: at("disappear", 0), plumeId: null, plume: spec("plume:0:1,2#1"), burst: null }],
        clockMs,
      );
      expect(out).toHaveLength(2);
      expect(out[1]?.id).toBe(goingPlumeId("plume:0:1,2#1", "t1"));
      expect(out[1]?.taper).toBe(shown);
      expect(out[0]?.taper).toBe(1);
    }
  });

  it("runs a burst until its transition is finished", () => {
    const burst = spec("transition:t1");
    const running = [{ live: at("appear", 0), plumeId: null, plume: null, burst }];
    const during: ReturnType<typeof spec>[] = [];
    appendTransitionEmitters(during, running, DURATION_MS - 1);
    expect(during).toEqual([burst]);
    const after: ReturnType<typeof spec>[] = [];
    appendTransitionEmitters(after, running, DURATION_MS);
    expect(after).toEqual([]);
  });
});

describe("placementIdentity", () => {
  it("names a placement by its driver, then by its item id", () => {
    expect(placementIdentity({ owner: "bob" })).toBe("owner:bob");
    expect(placementIdentity({ itemId: "itm_1" })).toBe("item:itm_1");
    expect(placementIdentity({ owner: "bob", itemId: "itm_1" })).toBe("owner:bob");
  });

  it("has nothing to say about an anonymous tile, which is found by its cell", () => {
    expect(placementIdentity({})).toBeUndefined();
  });
});
