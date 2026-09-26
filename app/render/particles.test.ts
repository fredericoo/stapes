import { describe, expect, it } from "vitest";
import { type ParticleEmitterSpec, type ParticleReading, ParticleSystem } from "./particles";
import { DEFAULT_PARTICLES, MAX_LIVE_PARTICLES, type ParticleEmitterDef } from "../lib/particleVfx";

const fixed = (value: number) => () => value;

const emitter = (
  over: Partial<ParticleEmitterSpec> = {},
  config: Partial<ParticleEmitterDef> = {},
): ParticleEmitterSpec => ({
  id: "rat:burning",
  config: { ...DEFAULT_PARTICLES, ...config },
  cx: 4.5,
  cy: 6.5,
  footElev: 2,
  z: 1,
  box: { eastPx: 40, southPx: 56, foot: 2, top: 4 },
  stackBias: 3,
  taper: 1,
  ...over,
});

const blank = (): ParticleReading => ({
  x: 0,
  y: 0,
  elev: 0,
  life: 0,
  config: DEFAULT_PARTICLES,
  ramp: new Float32Array(0),
  z: 0,
  box: { eastPx: 0, southPx: 0, foot: 0, top: 0 },
  stackBias: 0,
  taper: 1,
});

describe("emitting", () => {
  it("emits at the authored rate over a second", () => {
    const system = new ParticleSystem(fixed(0.5));
    system.setEmitters([emitter({}, { ratePerSecond: 10, ttlFromMs: 5_000, ttlToMs: 5_000 })]);
    system.advance(1_000);
    expect(system.count).toBe(10);
  });

  it("still emits when a frame is worth less than one particle", () => {
    const system = new ParticleSystem(fixed(0.5));
    system.setEmitters([emitter({}, { ratePerSecond: 8, ttlFromMs: 5_000, ttlToMs: 5_000 })]);
    const frameMs = 1_000 / 120;
    for (let i = 0; i < 120; i++) system.advance(frameMs);
    expect(system.count).toBeGreaterThanOrEqual(7);
    expect(system.count).toBeLessThanOrEqual(8);
  });

  it("draws a birth position inside the authored spread", () => {
    const system = new ParticleSystem(fixed(1));
    system.setEmitters([
      emitter(
        {},
        {
          ratePerSecond: 1,
          spawnRadiusCells: 0.25,
          spawnElevFrom: 0,
          spawnElevTo: 2,
          ttlFromMs: 5_000,
          ttlToMs: 5_000,
        },
      ),
    ]);
    system.advance(1_000);
    const p = system.read(0, blank());
    expect(p.x).toBeCloseTo(4.75);
    expect(p.y).toBeCloseTo(6.75);
    expect(p.elev).toBeCloseTo(4);
  });

  it("carries the plume's draw order onto every particle", () => {
    const system = new ParticleSystem(fixed(0.5));
    const spec = emitter({}, { ratePerSecond: 4, ttlFromMs: 5_000, ttlToMs: 5_000 });
    system.setEmitters([spec]);
    system.advance(1_000);
    for (let i = 0; i < system.count; i++) {
      const p = system.read(i, blank());
      expect(p.box).toEqual(spec.box);
      expect(p.stackBias).toBe(spec.stackBias);
      expect(p.z).toBe(spec.z);
    }
  });

  it("stops at the pool ceiling rather than growing", () => {
    const system = new ParticleSystem(fixed(0.5));
    const loud = { ratePerSecond: 200, ttlFromMs: 10_000, ttlToMs: 10_000 };
    system.setEmitters([emitter({ id: "a" }, loud), emitter({ id: "b" }, loud)]);
    for (let i = 0; i < 100; i++) system.advance(1_000);
    expect(system.count).toBe(MAX_LIVE_PARTICLES);
  });
});

describe("living and dying", () => {
  it("buries a particle once its lifetime is up", () => {
    const system = new ParticleSystem(fixed(0));
    system.setEmitters([emitter({}, { ratePerSecond: 1, ttlFromMs: 500, ttlToMs: 500 })]);
    system.advance(1_000);
    expect(system.count).toBe(1);
    system.advance(499);
    expect(system.count).toBe(1);
    system.advance(2);
    expect(system.count).toBe(0);
  });

  it("reads its life as the fraction of its own lifetime it has spent", () => {
    const system = new ParticleSystem(fixed(0));
    system.setEmitters([emitter({}, { ratePerSecond: 1, ttlFromMs: 1_000, ttlToMs: 1_000 })]);
    system.advance(1_000);
    system.advance(250);
    expect(system.read(0, blank()).life).toBeCloseTo(0.25);
  });

  it("rises, then falls back under gravity", () => {
    const system = new ParticleSystem(fixed(0));
    system.setEmitters([
      emitter(
        {},
        {
          ratePerSecond: 1,
          ttlFromMs: 9_000,
          ttlToMs: 9_000,
          spawnElevFrom: 0,
          spawnElevTo: 0,
          riseFrom: 4,
          riseTo: 4,
          gravity: -8,
          driftCellsPerSecond: 0,
        },
      ),
    ]);
    system.advance(1_000);
    const start = system.read(0, blank()).elev;

    system.advance(250);
    const rising = system.read(0, blank()).elev;
    expect(rising).toBeGreaterThan(start);

    for (let i = 0; i < 8; i++) system.advance(250);
    expect(system.read(0, blank()).elev).toBeLessThan(rising);
  });

  it("bends away under the wind rather than leaning from birth", () => {
    const system = new ParticleSystem(fixed(0.5));
    system.setEmitters([
      emitter(
        {},
        {
          ratePerSecond: 1,
          ttlFromMs: 9_000,
          ttlToMs: 9_000,
          driftCellsPerSecond: 0,
          windX: 2,
          windY: 0,
        },
      ),
    ]);
    system.advance(1_000);
    const born = system.read(0, blank());
    expect(born.x).toBeCloseTo(4.5);

    system.advance(1_000);
    const first = system.read(0, blank()).x - 4.5;
    system.advance(1_000);
    const second = system.read(0, blank()).x - 4.5 - first;
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
  });

  it("leaves a still plume where the drift put it", () => {
    const system = new ParticleSystem(fixed(0.5));
    system.setEmitters([
      emitter(
        {},
        {
          ratePerSecond: 1,
          ttlFromMs: 9_000,
          ttlToMs: 9_000,
          driftCellsPerSecond: 0,
        },
      ),
    ]);
    system.advance(1_000);
    system.advance(2_000);
    const reading = system.read(0, blank());
    expect(reading.x).toBeCloseTo(4.5);
    expect(reading.y).toBeCloseTo(6.5);
  });
});

describe("plumes coming and going", () => {
  it("keeps a plume's particles when it merely moves", () => {
    const system = new ParticleSystem(fixed(0.5));
    system.setEmitters([emitter({}, { ratePerSecond: 4, ttlFromMs: 5_000, ttlToMs: 5_000 })]);
    system.advance(1_000);
    const before = system.count;

    system.setEmitters([
      emitter({ cx: 5.5 }, { ratePerSecond: 4, ttlFromMs: 5_000, ttlToMs: 5_000 }),
    ]);
    system.advance(0);
    expect(system.count).toBe(before);
  });

  it("lets the last sparks finish after the status ends", () => {
    const system = new ParticleSystem(fixed(0));
    system.setEmitters([emitter({}, { ratePerSecond: 2, ttlFromMs: 1_000, ttlToMs: 1_000 })]);
    system.advance(1_000);
    expect(system.count).toBe(2);

    system.setEmitters([]);
    system.advance(500);
    expect(system.count).toBe(2);
    expect(system.emitterCount).toBe(1);

    system.advance(600);
    expect(system.count).toBe(0);
    expect(system.emitterCount).toBe(0);
  });

  it("keeps every surviving particle pointing at its own plume", () => {
    const system = new ParticleSystem(fixed(0));
    const shortLived = emitter(
      { id: "a" },
      {
        ratePerSecond: 1,
        ttlFromMs: 400,
        ttlToMs: 400,
      },
    );
    const lasting = emitter(
      { id: "b", stackBias: 99, z: 7 },
      {
        ratePerSecond: 1,
        ttlFromMs: 9_000,
        ttlToMs: 9_000,
      },
    );
    system.setEmitters([shortLived, lasting]);
    system.advance(1_000);
    expect(system.count).toBe(2);

    system.setEmitters([lasting]);
    system.advance(500);

    expect(system.emitterCount).toBe(1);
    expect(system.count).toBe(1);
    const survivor = system.read(0, blank());
    expect(survivor.stackBias).toBe(99);
    expect(survivor.z).toBe(7);
  });

  it("forgets everything on clear", () => {
    const system = new ParticleSystem(fixed(0.5));
    system.setEmitters([emitter({}, { ratePerSecond: 4, ttlFromMs: 5_000, ttlToMs: 5_000 })]);
    system.advance(1_000);
    system.clear();
    expect(system.count).toBe(0);
    expect(system.emitterCount).toBe(0);
  });
});
