import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { circleSlice, ParticleLayer, particleWorldPx, SHAPE_SLOTS } from "./particleLayer";
import type { ParticleEmitterSpec } from "./particles";
import type { CellHidden } from "./tileEmitters";
import { DEFAULT_PARTICLES, type ParticleEmitterDef, PARTICLE_SHAPE_PX } from "../lib/particleVfx";
import type { LevelLightUniforms } from "./worldQuads";
import { type RoofCut, cutHides } from "../lib/levelVisibility";
import { coordKey } from "../lib/types";
import { CELL_SIZE, HEIGHT_PER_LEVEL } from "../lib/types";
import { PX_PER_HEIGHT } from "../lib/geometry";

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
  return new ParticleLayer(
    () => lightUniforms(),
    () => 0.5,
  );
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
    expect([...unlit.slice(0, 4)]).toEqual([0, 0, 0, 0]);
  });

  it("samples the light map at the cell the particle is over", () => {
    const l = layer();
    l.setEmitters([emitter({ cx: 3.5, cy: 4.5 }, { lit: true, spawnRadiusCells: 0 })]);
    l.update(1_000, undefined);

    const uv = attr(l, "aLightUv").array as Float32Array;
    expect([...uv.slice(0, 2)]).toEqual([3, 4]);
    const scale = attr(l, "aLightScale").array as Float32Array;
    expect([...scale.slice(0, 8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("gives each level its own draw group and material", () => {
    const l = layer();
    l.setEmitters([emitter({ id: "ground", z: 0 }), emitter({ id: "upstairs", z: 1 })]);
    l.update(1_000, undefined);

    expect(l.mesh.geometry.groups).toHaveLength(2);
    expect(l.mesh.material).toHaveLength(2);
    const indices = l.mesh.geometry.groups.map((g) => g.materialIndex);
    expect(new Set(indices).size).toBe(2);
  });

  it("leaves the draw range wide open, because groups are intersected with it", () => {
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

    l.update(16, cutting(0, { x: 3, y: 4, z: 2 }));
    expect(l.mesh.visible).toBe(false);
    expect(l.system.count).toBeGreaterThan(0);
  });

  it("keeps a plume on a structure the cut left standing", () => {
    const l = layer();
    l.setEmitters([emitter({ id: "next-door", z: 2 })]);
    l.update(1_000, cutting(0, { x: 9, y: 9, z: 2 }));

    expect(l.mesh.visible).toBe(true);
  });
});

describe("where a particle lands", () => {
  it("puts a point on screen without asking what level it is on", () => {
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

describe("the shapes", () => {
  const TOP_ROW = ["#####", ".....", ".....", ".....", "....."];

  function quadWidths(l: ParticleLayer, count: number): number[] {
    const pos = attr(l, "position").array as Float32Array;
    return Array.from({ length: count }, (_, q) => pos[q * 12 + 3]! - pos[q * 12]!);
  }

  function atlasOf(l: ParticleLayer): THREE.DataTexture {
    const material = (l.mesh.material as THREE.MeshBasicMaterial[])[0]!;
    return material.map as THREE.DataTexture;
  }

  it("draws a shaped particle at five pixels whatever the radius says", () => {
    const l = layer();
    l.setEmitters([emitter({}, { shape: TOP_ROW, radiusFromPx: 8, radiusToPx: 8 })]);
    l.update(1_000, undefined);
    expect(quadWidths(l, 1)).toEqual([PARTICLE_SHAPE_PX]);
  });

  it("puts the shape's top row at the top of the quad", () => {
    const l = layer();
    l.setEmitters([emitter({}, { shape: TOP_ROW })]);
    l.update(1_000, undefined);

    const pos = attr(l, "position").array as Float32Array;
    const uv = attr(l, "uv").array as Float32Array;
    const corners = [0, 1, 2, 3].map((c) => ({ y: pos[c * 3 + 1]!, v: uv[c * 2 + 1]! }));
    const topV = corners.reduce((a, b) => (b.y < a.y ? b : a)).v;
    const bottomV = corners.reduce((a, b) => (b.y > a.y ? b : a)).v;

    const atlas = atlasOf(l);
    const { data, width, height } = atlas.image as {
      data: Uint8Array;
      width: number;
      height: number;
    };
    const u0 = uv[0]!;
    const column = Math.floor(u0 * width);
    const alphaAt = (v: number, inward: number) => {
      const row = Math.floor(v * height) + inward;
      return data[(row * width + column) * 4 + 3];
    };
    const topInward = topV > bottomV ? -1 : 0;
    const bottomInward = topV > bottomV ? 0 : -1;
    expect(alphaAt(topV, topInward)).toBe(255);
    expect(alphaAt(bottomV, bottomInward)).toBe(0);
  });

  it("draws shapes past the last slot as circles until the next frame", () => {
    const l = layer();
    const shapes = Array.from({ length: SHAPE_SLOTS + 1 }, (_, i) =>
      Array.from({ length: 5 }, (_, y) =>
        Array.from({ length: 5 }, (_, x) => (((i + 1) >> (y * 5 + x)) & 1 ? "#" : ".")).join(""),
      ),
    );
    l.setEmitters(
      shapes.map((shape, i) =>
        emitter({ id: `shape-${i}` }, { shape, ratePerSecond: 1, radiusFromPx: 0, radiusToPx: 0 }),
      ),
    );
    const drawn = l.update(1_000, undefined) ? l.system.count : 0;
    const widths = quadWidths(l, drawn);
    expect(widths.filter((w) => w === PARTICLE_SHAPE_PX)).toHaveLength(SHAPE_SLOTS);
    expect(widths.filter((w) => w === 1)).toHaveLength(1);
  });
});
