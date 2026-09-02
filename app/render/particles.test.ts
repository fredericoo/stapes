import { describe, expect, it } from "vitest";
import {
  type ParticleEmitterSpec,
  type ParticleReading,
  ParticleSystem,
} from "./particles";
import {
  DEFAULT_PARTICLES,
  MAX_LIVE_PARTICLES,
  type StatusParticles,
} from "../lib/statusVfx";

/**
 * A plume, as arithmetic.
 *
 * Every one of these is a thing that looked wrong on screen first: a plume that
 * emitted nothing at a high frame rate, a fire that went out between two frames,
 * a pool that filled with one emitter's backlog. The dice are handed in so the
 * assertions are about the simulation rather than about luck.
 */

/** Dice that always come out at the same point of every range. */
const fixed = (value: number) => () => value;

const emitter = (
  over: Partial<ParticleEmitterSpec> = {},
  config: Partial<StatusParticles> = {},
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
    system.setEmitters([
      emitter({}, { ratePerSecond: 10, ttlFromMs: 5_000, ttlToMs: 5_000 }),
    ]);
    system.advance(1_000);
    expect(system.count).toBe(10);
  });

  it("still emits when a frame is worth less than one particle", () => {
    // The bug the spawn debt exists for. Eight per second at 120fps is 0.067 of
    // a particle per frame, and a plume that truncated would emit nothing at
    // all — forever, and only on fast machines.
    const system = new ParticleSystem(fixed(0.5));
    system.setEmitters([
      emitter({}, { ratePerSecond: 8, ttlFromMs: 5_000, ttlToMs: 5_000 }),
    ]);
    const frameMs = 1_000 / 120;
    for (let i = 0; i < 120; i++) system.advance(frameMs);
    // Seven or eight, not zero, and that is the whole assertion. A hundred and
    // twenty frames of 1000/120ms come to 999.9999999999999ms, so the eighth
    // particle is owed a rounding step later — the same accumulated-float slack
    // `TICK_EPSILON_MS` absorbs in the simulation, and here it costs one spark a
    // hundredth of a second. Pinning it to eight would be a test of floating
    // point rather than of the debt.
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
    // Dice pinned at 1, so every range lands on its far end.
    expect(p.x).toBeCloseTo(4.75);
    expect(p.y).toBeCloseTo(6.75);
    // Spawn elevation is measured from the tile's foot, not from the floor of
    // the world — a plume on a first-storey balcony starts at the balcony.
    expect(p.elev).toBeCloseTo(4);
  });

  it("carries the plume's draw order onto every particle", () => {
    const system = new ParticleSystem(fixed(0.5));
    const spec = emitter(
      {},
      { ratePerSecond: 4, ttlFromMs: 5_000, ttlToMs: 5_000 },
    );
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
    // Two emitters, because one cannot get there: the loudest legal plume is
    // `MAX_PARTICLE_RATE` a second living `MAX_PARTICLE_TTL_MS`, which settles
    // at 2000 against a pool of 2048. That the ceiling sits just above what one
    // emitter can do is the sizing working, not a coincidence — it takes a
    // second burning body to reach it.
    const system = new ParticleSystem(fixed(0.5));
    const loud = { ratePerSecond: 200, ttlFromMs: 10_000, ttlToMs: 10_000 };
    system.setEmitters([
      emitter({ id: "a" }, loud),
      emitter({ id: "b" }, loud),
    ]);
    for (let i = 0; i < 100; i++) system.advance(1_000);
    expect(system.count).toBe(MAX_LIVE_PARTICLES);
  });
});

describe("living and dying", () => {
  it("buries a particle once its lifetime is up", () => {
    const system = new ParticleSystem(fixed(0));
    system.setEmitters([
      emitter({}, { ratePerSecond: 1, ttlFromMs: 500, ttlToMs: 500 }),
    ]);
    system.advance(1_000);
    expect(system.count).toBe(1);
    system.advance(499);
    expect(system.count).toBe(1);
    system.advance(2);
    expect(system.count).toBe(0);
  });

  it("reads its life as the fraction of its own lifetime it has spent", () => {
    const system = new ParticleSystem(fixed(0));
    system.setEmitters([
      emitter({}, { ratePerSecond: 1, ttlFromMs: 1_000, ttlToMs: 1_000 }),
    ]);
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

    // Four height units a second against eight a second squared: the push is
    // spent at half a second, and everything after that is fallout.
    for (let i = 0; i < 8; i++) system.advance(250);
    expect(system.read(0, blank()).elev).toBeLessThan(rising);
  });
});

describe("plumes coming and going", () => {
  it("keeps a plume's particles when it merely moves", () => {
    const system = new ParticleSystem(fixed(0.5));
    system.setEmitters([
      emitter({}, { ratePerSecond: 4, ttlFromMs: 5_000, ttlToMs: 5_000 }),
    ]);
    system.advance(1_000);
    const before = system.count;

    // The same fire, one cell east — a burning creature took a step.
    system.setEmitters([
      emitter(
        { cx: 5.5 },
        { ratePerSecond: 4, ttlFromMs: 5_000, ttlToMs: 5_000 },
      ),
    ]);
    system.advance(0);
    expect(system.count).toBe(before);
  });

  it("lets the last sparks finish after the status ends", () => {
    const system = new ParticleSystem(fixed(0));
    system.setEmitters([
      emitter({}, { ratePerSecond: 2, ttlFromMs: 1_000, ttlToMs: 1_000 }),
    ]);
    system.advance(1_000);
    expect(system.count).toBe(2);

    // The status is over. A fire that vanished between two frames would read as
    // a rendering bug rather than as a fire going out.
    system.setEmitters([]);
    system.advance(500);
    expect(system.count).toBe(2);
    expect(system.emitterCount).toBe(1);

    system.advance(600);
    expect(system.count).toBe(0);
    expect(system.emitterCount).toBe(0);
  });

  it("keeps every surviving particle pointing at its own plume", () => {
    // The renumbering hazard: dropping a finished emitter shifts the indices of
    // everything after it, and a particle left pointing at the old slot would
    // draw in another plume's colours at another plume's depth.
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
    system.setEmitters([
      emitter({}, { ratePerSecond: 4, ttlFromMs: 5_000, ttlToMs: 5_000 }),
    ]);
    system.advance(1_000);
    system.clear();
    expect(system.count).toBe(0);
    expect(system.emitterCount).toBe(0);
  });
});
