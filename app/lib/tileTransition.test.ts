import { describe, expect, it } from "vitest";
import { DEFAULT_PARTICLES } from "./particleVfx";
import {
  DEFAULT_CLUMP_PX,
  MAX_BURST_PARTICLES,
  MAX_DROP_LEVELS,
  MAX_TRANSITION_MS,
  MIN_TRANSITION_MS,
  parseTileTransitions,
  shownFraction,
  transitionOf,
} from "./tileTransition";
import { normalizeTileDef } from "./types";

/**
 * What an author may write, and what survives the trip into the renderer.
 *
 * The standard is the one a plume is held to: a block that does not parse is
 * dropped and the tile loads without it, so every case here is either "this is
 * kept as written" or "this side is gone and the other is untouched".
 */

const DURATION_MS = 700;

const flameAppear = {
  durationMs: DURATION_MS,
  dissolve: {
    pattern: "sweep",
    from: { x: -1, y: -1 },
    edgeColor: "#8ce6ff",
    edgeWidth: 0.18,
  },
};

const flameDisappear = {
  durationMs: DURATION_MS,
  scale: {},
  dissolve: { pattern: "noise", edgeColor: "#ff9e40", edgeWidth: 0.18 },
};

describe("parseTileTransitions", () => {
  it("keeps both sides as written, filling in what a side left out", () => {
    expect(
      parseTileTransitions({ appear: flameAppear, disappear: flameDisappear }),
    ).toEqual({
      appear: {
        ...flameAppear,
        dissolve: { ...flameAppear.dissolve, clumpPx: DEFAULT_CLUMP_PX },
      },
      disappear: {
        ...flameDisappear,
        dissolve: { ...flameDisappear.dissolve, clumpPx: DEFAULT_CLUMP_PX },
      },
    });
  });

  it("keeps a sweep's origin exactly as authored, on the appearing side too", () => {
    const parsed = parseTileTransitions({ appear: flameAppear });
    expect(parsed?.appear?.dissolve?.from).toEqual({ x: -1, y: -1 });
  });

  it("drops a side that does not parse and keeps the other", () => {
    const parsed = parseTileTransitions({
      appear: { ...flameAppear, durationMs: "slowly" },
      disappear: flameDisappear,
    });
    expect(parsed?.appear).toBeUndefined();
    expect(parsed?.disappear?.scale).toEqual({});
  });

  it("is nothing at all when neither side survives", () => {
    expect(parseTileTransitions({ appear: { durationMs: DURATION_MS } })).toBe(
      undefined,
    );
    expect(parseTileTransitions("dissolve please")).toBeUndefined();
    expect(parseTileTransitions(null)).toBeUndefined();
  });

  it("refuses a transition that does nothing", () => {
    expect(parseTileTransitions({ disappear: { durationMs: DURATION_MS } })).toBe(
      undefined,
    );
  });

  it("refuses a sweep with nowhere to start", () => {
    const { from: _from, ...noOrigin } = flameAppear.dissolve;
    expect(
      parseTileTransitions({ appear: { ...flameAppear, dissolve: noOrigin } }),
    ).toBeUndefined();
  });

  it("holds the duration to its range", () => {
    for (const durationMs of [MIN_TRANSITION_MS, MAX_TRANSITION_MS]) {
      expect(
        parseTileTransitions({ appear: { ...flameAppear, durationMs } })?.appear,
      ).toBeDefined();
    }
    for (const durationMs of [MIN_TRANSITION_MS - 1, MAX_TRANSITION_MS + 1]) {
      expect(
        parseTileTransitions({ appear: { ...flameAppear, durationMs } }),
      ).toBeUndefined();
    }
  });

  it("holds a drop to whole storeys within reach", () => {
    const drop = (levels: number) =>
      parseTileTransitions({
        appear: { durationMs: DURATION_MS, drop: { levels } },
      })?.appear?.drop;
    expect(drop(2)).toEqual({ levels: 2 });
    expect(drop(MAX_DROP_LEVELS + 1)).toBeUndefined();
    expect(drop(1.5)).toBeUndefined();
    expect(drop(0)).toBeUndefined();
  });

  it("caps what one burst may spend over its whole duration", () => {
    // A rate every plume may have, so only the duration decides the total.
    const RATE_PER_SECOND = 100;
    const MS_AT_THE_CAP = (MAX_BURST_PARTICLES / RATE_PER_SECOND) * 1000;
    const burstFor = (durationMs: number) =>
      parseTileTransitions({
        disappear: {
          durationMs,
          particles: { ...DEFAULT_PARTICLES, ratePerSecond: RATE_PER_SECOND },
        },
      })?.disappear?.particles;
    expect(burstFor(MS_AT_THE_CAP)).toBeDefined();
    expect(burstFor(MS_AT_THE_CAP + 1000)).toBeUndefined();
  });
});

describe("a tile carrying transitions", () => {
  const frame = {
    sprite: {
      tilesetId: "basic",
      rect: { x: 0, y: 0, w: 1, h: 1 },
      base: { x: 0, y: 0 },
    },
    durationMs: 200,
  };
  const tile = (transitions: unknown) =>
    normalizeTileDef({
      id: "flame",
      name: "Flame",
      height: 0,
      directional: false,
      variants: { default: [frame] },
      attributes: {},
      transitions,
    });

  it("keeps a block that parses", () => {
    expect(tile({ appear: flameAppear }).transitions?.appear?.durationMs).toBe(
      DURATION_MS,
    );
  });

  it("loads without one that does not", () => {
    const def = tile({ appear: { durationMs: "slowly" } });
    expect(def.transitions).toBeUndefined();
    expect("transitions" in def).toBe(false);
  });

  it("answers for exactly the sides it has", () => {
    const def = tile({ disappear: flameDisappear });
    expect(transitionOf(def, "disappear")).toBeDefined();
    expect(transitionOf(def, "appear")).toBeUndefined();
    expect(transitionOf(undefined, "appear")).toBeUndefined();
  });
});

describe("shownFraction", () => {
  it("climbs from the hidden end on the way in", () => {
    expect(shownFraction("appear", 0, DURATION_MS)).toBe(0);
    expect(shownFraction("appear", DURATION_MS / 2, DURATION_MS)).toBe(0.5);
    expect(shownFraction("appear", DURATION_MS, DURATION_MS)).toBe(1);
  });

  it("falls to the hidden end on the way out", () => {
    expect(shownFraction("disappear", 0, DURATION_MS)).toBe(1);
    expect(shownFraction("disappear", DURATION_MS / 2, DURATION_MS)).toBe(0.5);
    expect(shownFraction("disappear", DURATION_MS, DURATION_MS)).toBe(0);
  });

  it("holds at either end outside the duration", () => {
    expect(shownFraction("appear", -DURATION_MS, DURATION_MS)).toBe(0);
    expect(shownFraction("appear", DURATION_MS * 2, DURATION_MS)).toBe(1);
    expect(shownFraction("disappear", DURATION_MS * 2, DURATION_MS)).toBe(0);
  });
});
