import { describe, expect, it } from "vitest";
import type { ParticleEmitterSpec } from "./particles";
import {
  appendVisibleTileEmitters,
  MAX_VISIBLE_TILE_EMITTERS,
  tileEmitterId,
  tileEmitterPrefix,
} from "./tileEmitters";
import { DEFAULT_PARTICLES } from "../lib/particleVfx";

/**
 * Which chimneys are worth simulating.
 *
 * Every one of these is a cost that does not show up on screen when it is
 * wrong: an emitter two rooms away still fills the pool, and one above the
 * roof-cut is simulated in full and then hidden.
 */

const WINDOW = { x0: 0, y0: 0, x1: 10, y1: 10 };

const at = (x: number, y: number, z = 0): ParticleEmitterSpec => ({
  id: tileEmitterId(`${z}:${x},${y}:0`),
  config: DEFAULT_PARTICLES,
  cx: x + 0.5,
  cy: y + 0.5,
  footElev: 0,
  z,
  box: { eastPx: 0, southPx: 0, foot: 0, top: 0 },
  stackBias: 0,
  taper: 1,
});

const byLevel = (...specs: ParticleEmitterSpec[]) => {
  const map = new Map<number, ParticleEmitterSpec[]>();
  for (const spec of specs) {
    const list = map.get(spec.z) ?? [];
    list.push(spec);
    map.set(spec.z, list);
  }
  return map;
};

describe("culling the board's plumes", () => {
  it("keeps what the camera can reach and drops what it cannot", () => {
    const inside = at(5, 5);
    const out = appendVisibleTileEmitters(
      byLevel(inside, at(40, 5), at(5, 40)),
      WINDOW,
      undefined,
      [],
    );
    expect(out).toEqual([inside]);
  });

  it("drops a plume the roof-cut is hiding anyway", () => {
    const under = at(5, 5, 0);
    const out = appendVisibleTileEmitters(
      byLevel(under, at(6, 6, 1), at(7, 7, 2)),
      WINDOW,
      0,
      [],
    );
    expect(out).toEqual([under]);
  });

  it("shows every level when nothing is cut", () => {
    const out = appendVisibleTileEmitters(
      byLevel(at(5, 5, 0), at(6, 6, 1)),
      WINDOW,
      undefined,
      [],
    );
    expect(out).toHaveLength(2);
  });

  it("leaves the caller's plumes in front of the board's", () => {
    // The pool is served in emitter order, so a status has to come first: a
    // board crowded with smoke should thin its smoke, not stop drawing the fire
    // on the rat.
    const status = { ...at(5, 5), id: "rat:burning" };
    const out = appendVisibleTileEmitters(byLevel(at(6, 6)), WINDOW, undefined, [
      status,
    ]);
    expect(out[0]).toBe(status);
    expect(out).toHaveLength(2);
  });

  it("caps the board's own without ever counting the caller's", () => {
    const crowd = Array.from({ length: MAX_VISIBLE_TILE_EMITTERS + 20 }, (_, i) =>
      // Stacked on one cell rather than spread, so every one of them is inside
      // the window and the cap is the only thing that can be doing the cutting.
      ({ ...at(5, 5), id: tileEmitterId(`0:5,5:${i}`) }),
    );
    const status = { ...at(5, 5), id: "rat:burning" };
    const out = appendVisibleTileEmitters(byLevel(...crowd), WINDOW, undefined, [
      status,
    ]);
    expect(out).toHaveLength(MAX_VISIBLE_TILE_EMITTERS + 1);
  });
});

describe("addressing one cell's plumes", () => {
  it("gives every plume of a cell the prefix that cell is cleared by", () => {
    // The two have to agree or a rebuilt cell keeps emitting from the tile it
    // used to hold — which looks like a chimney that never goes out.
    expect(tileEmitterId("2:7,3:1").startsWith(tileEmitterPrefix(2, 7, 3))).toBe(
      true,
    );
    expect(tileEmitterId("2:7,3:1").startsWith(tileEmitterPrefix(2, 7, 4))).toBe(
      false,
    );
  });

  it("does not read a neighbouring cell as its own", () => {
    // `1,2` must not be cleared by a rebuild of `1,20` — the trap every
    // prefix-matched index has, and the reason the separator is in the prefix.
    expect(
      tileEmitterId("0:1,20:0").startsWith(tileEmitterPrefix(0, 1, 2)),
    ).toBe(false);
  });
});
