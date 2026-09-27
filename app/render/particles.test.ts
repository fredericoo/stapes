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

const STILL: Partial<ParticleEmitterDef> = {
  ratePerSecond: 1,
  ttlFromMs: 9_000,
  ttlToMs: 9_000,
  spawnRadiusCells: 0,
  spawnElevFrom: 0,
  spawnElevTo: 0,
  riseFrom: 0,
  riseTo: 0,
  driftCellsPerSecond: 0,
  gravity: 0,
};

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

  it("goes round a circle when its offsets are one", () => {
    const system = new ParticleSystem(fixed(0.5));
    system.setEmitters([
      emitter(
        {},
        {
          ...STILL,
          offsetX: "cos(PI * AGE_SEC)",
          offsetY: "sin(PI * AGE_SEC)",
        },
      ),
    ]);
    system.advance(1_000);
    const expectAt = (x: number, y: number) => {
      const p = system.read(0, blank());
      expect(p.x).toBeCloseTo(x);
      expect(p.y).toBeCloseTo(y);
      expect(p.elev).toBeCloseTo(2);
    };
    expectAt(5.5, 6.5);
    system.advance(500);
    expectAt(4.5, 7.5);
    system.advance(500);
    expectAt(3.5, 6.5);
  });

  it("gives every particle a seed of its own, and keeps it when another dies", () => {
    let draws = 0;
    const system = new ParticleSystem(() => (draws++ * 0.137) % 1);
    const seeded = { ...STILL, offsetElev: "SEED" };
    const shortLived = emitter({ id: "a" }, { ...seeded, ttlFromMs: 400, ttlToMs: 400 });
    const lasting = emitter({ id: "b", footElev: 10 }, seeded);
    system.setEmitters([shortLived, lasting]);
    system.advance(1_000);
    const doomedSeed = system.read(0, blank()).elev - 2;
    const survivorSeed = system.read(1, blank()).elev - 10;
    expect(survivorSeed).not.toBeCloseTo(doomedSeed);

    system.setEmitters([lasting]);
    system.advance(500);
    expect(system.count).toBe(1);
    expect(system.read(0, blank()).elev - 10).toBeCloseTo(survivorSeed);
  });

  it("takes up an edited offset on a plume that is still running", () => {
    const system = new ParticleSystem(fixed(0.5));
    system.setEmitters([emitter({}, { ...STILL, ttlFromMs: 2_000, ttlToMs: 2_000 })]);
    system.advance(1_000);
    system.advance(500);
    expect(system.read(0, blank()).x).toBeCloseTo(4.5);

    system.setEmitters([
      emitter({}, { ...STILL, ttlFromMs: 2_000, ttlToMs: 2_000, offsetX: "4 * LIFE" }),
    ]);
    expect(system.read(0, blank()).x).toBeCloseTo(5.5);
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
