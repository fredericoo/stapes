import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { circleSlice, ParticleLayer, particleWorldPx } from "./particleLayer";
import type { ParticleEmitterSpec } from "./particles";
import { DEFAULT_PARTICLES, type ParticleEmitterDef } from "../lib/particleVfx";
import type { LevelLightUniforms } from "./worldQuads";
import type { RoofCut } from "../lib/levelVisibility";
import { coordKey } from "../lib/types";
import { CELL_SIZE, HEIGHT_PER_LEVEL } from "../lib/types";
import { PX_PER_HEIGHT } from "../lib/geometry";

/**
 * What actually reaches the buffers.
 *
 * The layer is the one part of this feature with no visible failure mode short
 * of looking at it: an attribute that never gets written draws *something*, just
 * not the something that was authored. `lit` shipped broken exactly that way —
 * the flag was read, the buffer was filled, and the geometry was handed a
 * different array.
 *
 * No GL context is needed for any of this. Geometry, attributes and materials
 * are plain objects until a renderer touches them.
 */

function lightUniforms(): LevelLightUniforms {
  return {
    uLightMap: { value: new THREE.Texture() },
    uLightOrigin: { value: new THREE.Vector2(0, 0) },
    uLightSize: { value: new THREE.Vector2(1, 1) },
    uLightingEnabled: { value: 1 },
    uAmbient: { value: new THREE.Vector3(1, 1, 1) },
  };
}

function layer() {
  // Dice pinned at the middle of every range, so a spawn is deterministic.
  return new ParticleLayer(() => lightUniforms(), () => 0.5);
}

function emitter(
  over: Partial<ParticleEmitterSpec> = {},
  config: Partial<ParticleEmitterDef> = {},
): ParticleEmitterSpec {
  return {
    id: "one",
    config: {
      ...DEFAULT_PARTICLES,
      ratePerSecond: 4,
      ttlFromMs: 5_000,
      ttlToMs: 5_000,
      ...config,
    },
    cx: 3.5,
    cy: 4.5,
    footElev: 0,
    z: 0,
    box: { eastPx: 32, southPx: 40, foot: 0, top: 2 },
    stackBias: 1,
    taper: 1,
    ...over,
  };
}

/** A cut over exactly the cells named — the shape `roofCutFor` hands back. */
const cutting = (
  floor: number,
  ...cells: Array<{ x: number; y: number; z: number }>
): RoofCut => {
  const byZ = new Map<number, Set<string>>();
  for (const cell of cells) {
    const level = byZ.get(cell.z) ?? new Set<string>();
    level.add(coordKey(cell.x, cell.y));
    byZ.set(cell.z, level);
  }
  return { floor, cells: byZ };
};

const attr = (l: ParticleLayer, name: string) =>
  l.mesh.geometry.getAttribute(name) as THREE.BufferAttribute;

describe("what the buffers say", () => {
  it("flags an unlit plume so the shader skips the light map", () => {
    const l = layer();
    l.setEmitters([emitter({}, { lit: false })]);
    l.update(1_000, undefined);

    const unlit = attr(l, "aUnlit").array as Float32Array;
    expect(unlit[0]).toBe(1);
  });

  it("flags a lit plume so the shader reaches for it", () => {
    const l = layer();
    l.setEmitters([emitter({}, { lit: true })]);
    l.update(1_000, undefined);

    const unlit = attr(l, "aUnlit").array as Float32Array;
    // All four corners, because the flag is a varying and one stray vertex
    // would light a triangle and not its neighbour.
    expect([...unlit.slice(0, 4)]).toEqual([0, 0, 0, 0]);
  });

  it("samples the light map at the cell the particle is over", () => {
    const l = layer();
    l.setEmitters([
      emitter({ cx: 3.5, cy: 4.5 }, { lit: true, spawnRadiusCells: 0 }),
    ]);
    l.update(1_000, undefined);

    const uv = attr(l, "aLightUv").array as Float32Array;
    // The cell's integer coordinate, which is where a light-map texel's centre
    // is. A fractional value lands on a texel boundary and a nearest sample
    // picks a neighbour at random.
    expect([...uv.slice(0, 2)]).toEqual([3, 4]);
    // Flat across the quad: a particle is smaller than the cell lighting it, so
    // there is no gradient to walk.
    const scale = attr(l, "aLightScale").array as Float32Array;
    expect([...scale.slice(0, 8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("gives each level its own draw group and material", () => {
    const l = layer();
    l.setEmitters([
      emitter({ id: "ground", z: 0 }),
      emitter({ id: "upstairs", z: 1 }),
    ]);
    l.update(1_000, undefined);

    // Two levels, two groups, two materials — the light map is bound per level,
    // so a spark upstairs must not be lit by the room below it.
    expect(l.mesh.geometry.groups).toHaveLength(2);
    expect(l.mesh.material).toHaveLength(2);
    const indices = l.mesh.geometry.groups.map((g) => g.materialIndex);
    expect(new Set(indices).size).toBe(2);
  });

  it("leaves the draw range wide open, because groups are intersected with it", () => {
    // The regression this test exists for: a geometry pinned to a zero-length
    // draw range draws nothing at all, however many groups it carries. Groups
    // bound the draw; the range must not also try to.
    const l = layer();
    l.setEmitters([emitter()]);
    l.update(1_000, undefined);

    const { start, count } = l.mesh.geometry.drawRange;
    const [group] = l.mesh.geometry.groups;
    expect(start).toBe(0);
    expect(count).toBeGreaterThanOrEqual(group!.start + group!.count);
  });

  it("draws one group when every plume is on one level, which is the usual case", () => {
    const l = layer();
    l.setEmitters([emitter({ id: "a", z: -1 }), emitter({ id: "b", z: -1 })]);
    l.update(1_000, undefined);

    expect(l.mesh.geometry.groups).toHaveLength(1);
    expect(l.mesh.material).toHaveLength(1);
  });

  it("leaves out a plume the roof cut hides, without killing it", () => {
    const l = layer();
    l.setEmitters([emitter({ id: "above", z: 2 })]);
    l.update(1_000, undefined);
    expect(l.mesh.visible).toBe(true);

    // The emitter hangs from cell (3, 4) — see `emitter` — so that is the cell
    // the cut has to name.
    l.update(16, cutting(0, { x: 3, y: 4, z: 2 }));
    expect(l.mesh.visible).toBe(false);
    // Still in the air. Walking under a roof and back out should find the fire
    // burning, not restarted.
    expect(l.system.count).toBeGreaterThan(0);
  });

  it("keeps a plume on a structure the cut left standing", () => {
    // Same level as the cut, different cell: the cut is a building now, not a
    // storey, so being high up is no longer a reason to be hidden.
    const l = layer();
    l.setEmitters([emitter({ id: "next-door", z: 2 })]);
    l.update(1_000, cutting(0, { x: 9, y: 9, z: 2 }));

    expect(l.mesh.visible).toBe(true);
  });
});

describe("where a particle lands", () => {
  it("puts a point on screen without asking what level it is on", () => {
    // The level term cancels: a storey shifts a cell by CELL_SIZE, and an
    // absolute elevation already carries that shift back.
    const cell = 3;
    const localElev = 1;
    const z = 2;
    const absolute = z * HEIGHT_PER_LEVEL + localElev;
    const viaProjection = cell * CELL_SIZE - CELL_SIZE * z - PX_PER_HEIGHT * localElev;
    expect(particleWorldPx(cell, absolute)).toBeCloseTo(viaProjection);
  });
});

describe("the circles", () => {
  it("cuts a tight square per integer radius", () => {
    expect(circleSlice(0).sizePx).toBe(1);
    expect(circleSlice(1).sizePx).toBe(3);
    expect(circleSlice(2.4).sizePx).toBe(5);
  });

  it("clamps rather than reading off the end of the atlas", () => {
    const far = circleSlice(1_000);
    expect(far.u1).toBeLessThanOrEqual(1);
    expect(far.v1).toBeLessThanOrEqual(1);
    expect(circleSlice(-5).sizePx).toBe(1);
  });
});
