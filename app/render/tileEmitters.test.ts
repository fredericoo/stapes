import { describe, expect, it } from "vitest";
import type { ParticleEmitterSpec } from "./particles";
import {
  appendVisibleTileEmitters,
  type CellHidden,
  MAX_VISIBLE_TILE_EMITTERS,
  PARTICLE_WINDOW_MARGIN,
  tileEmitterId,
  tileEmitterPrefix,
} from "./tileEmitters";
import { DEFAULT_PARTICLES } from "../lib/particleVfx";
import { type RoofCut, cutHides } from "../lib/levelVisibility";
import { emptyMap, replaceStack } from "../lib/mapData";
import { tile } from "../lib/testTile";
import type { MapFile } from "../lib/types";
import { coordKey } from "../lib/types";
import { isCellVisible } from "./cameraSight";

const cutting = (
  floor: number,
  ...cells: Array<{ x: number; y: number; z: number }>
): CellHidden => {
  const byZ = new Map<number, Set<string>>();
  for (const cell of cells) {
    const level = byZ.get(cell.z) ?? new Set<string>();
    level.add(coordKey(cell.x, cell.y));
    byZ.set(cell.z, level);
  }
  const cut: RoofCut = { floor, cells: byZ };
  return (x, y, z) => cutHides(cut, x, y, z);
};

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

  it("keeps a plume just off screen, whose sparks can still drift into it", () => {
    const justOutside = at(WINDOW.x1 + PARTICLE_WINDOW_MARGIN, 5);
    const wellOutside = at(WINDOW.x1 + PARTICLE_WINDOW_MARGIN + 1, 5);
    const out = appendVisibleTileEmitters(byLevel(justOutside, wellOutside), WINDOW, undefined, []);
    expect(out).toEqual([justOutside]);
  });

  it("gives each level its own reach rather than the union of every level", () => {
    const eastEdge = WINDOW.x1 + PARTICLE_WINDOW_MARGIN;
    const beyondGround = at(eastEdge + 2, 5, 2);
    const out = appendVisibleTileEmitters(byLevel(beyondGround), WINDOW, undefined, []);
    expect(out).toEqual([beyondGround]);

    expect(
      appendVisibleTileEmitters(byLevel(at(eastEdge + 2, 5, 0)), WINDOW, undefined, []),
    ).toEqual([]);
  });

  it("drops a plume the roof-cut is hiding anyway", () => {
    const under = at(5, 5, 0);
    const out = appendVisibleTileEmitters(
      byLevel(under, at(6, 6, 1), at(7, 7, 2)),
      WINDOW,
      cutting(0, { x: 6, y: 6, z: 1 }, { x: 7, y: 7, z: 2 }),
      [],
    );
    expect(out).toEqual([under]);
  });

  it("keeps a chimney on the roof next door, which the cut left standing", () => {
    const neighbour = at(8, 8, 1);
    const out = appendVisibleTileEmitters(
      byLevel(at(6, 6, 1), neighbour),
      WINDOW,
      cutting(0, { x: 6, y: 6, z: 1 }),
      [],
    );
    expect(out).toEqual([neighbour]);
  });

  it("shows every level when nothing is cut", () => {
    const out = appendVisibleTileEmitters(byLevel(at(5, 5, 0), at(6, 6, 1)), WINDOW, undefined, []);
    expect(out).toHaveLength(2);
  });

  it("leaves the caller's plumes in front of the board's", () => {
    const status = { ...at(5, 5), id: "rat:burning" };
    const out = appendVisibleTileEmitters(byLevel(at(6, 6)), WINDOW, undefined, [status]);
    expect(out[0]).toBe(status);
    expect(out).toHaveLength(2);
  });

  it("caps the board's own without ever counting the caller's", () => {
    const crowd = Array.from({ length: MAX_VISIBLE_TILE_EMITTERS + 20 }, (_, i) => ({
      ...at(5, 5),
      id: tileEmitterId(`0:5,5:${i}`),
    }));
    const status = { ...at(5, 5), id: "rat:burning" };
    const out = appendVisibleTileEmitters(byLevel(...crowd), WINDOW, undefined, [status]);
    expect(out).toHaveLength(MAX_VISIBLE_TILE_EMITTERS + 1);
  });
});

describe("a plume under the ground the viewer stands on", () => {
  const tilesById = { ground: tile({ id: "ground", height: 0 }) };
  const FIRE = at(5, 5, -1);

  function cave(hole = false): MapFile {
    let map = emptyMap();
    for (let x = 0; x <= 12; x++) {
      for (let y = 0; y <= 12; y++) {
        map = replaceStack(map, x, y, -1, [{ tileId: "ground" }]);
        if (hole && x === y && (x === 5 || x === 6)) continue;
        map = replaceStack(map, x, y, 0, [{ tileId: "ground" }]);
      }
    }
    return map;
  }

  const seenFrom =
    (map: MapFile, viewerZ: number, cut?: RoofCut): CellHidden =>
    (x, y, z) =>
      !isCellVisible(map, tilesById, { x, y, z }, viewerZ, cut);

  it("drops a fire one storey down from a viewer on the ground above it", () => {
    expect(appendVisibleTileEmitters(byLevel(FIRE), WINDOW, seenFrom(cave(), 0), [])).toEqual([]);
  });

  it("keeps it when the ground over it is open", () => {
    const out = appendVisibleTileEmitters(byLevel(FIRE), WINDOW, seenFrom(cave(true), 0), []);
    expect(out).toEqual([FIRE]);
  });

  it("keeps it for a viewer down in the cave, whose cut takes the ground away", () => {
    const whole: RoofCut = { floor: -1, cells: null };
    const out = appendVisibleTileEmitters(byLevel(FIRE), WINDOW, seenFrom(cave(), -1, whole), []);
    expect(out).toEqual([FIRE]);
  });
});

describe("addressing one cell's plumes", () => {
  it("gives every plume of a cell the prefix that cell is cleared by", () => {
    expect(tileEmitterId("2:7,3:1").startsWith(tileEmitterPrefix(2, 7, 3))).toBe(true);
    expect(tileEmitterId("2:7,3:1").startsWith(tileEmitterPrefix(2, 7, 4))).toBe(false);
  });

  it("does not read a neighbouring cell as its own", () => {
    expect(tileEmitterId("0:1,20:0").startsWith(tileEmitterPrefix(0, 1, 2))).toBe(false);
  });
});
