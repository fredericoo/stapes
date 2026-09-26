import type { DepthBox } from "../lib/geometry";
import { compileRamp, MAX_LIVE_PARTICLES, type ParticleEmitterDef } from "../lib/particleVfx";

export type Random = () => number;

export type ParticleEmitterSpec = {
  id: string;
  config: ParticleEmitterDef;
  cx: number;
  cy: number;
  footElev: number;
  z: number;
  box: DepthBox;
  stackBias: number;
  taper: number;
};

type EmitterState = {
  spec: ParticleEmitterSpec;
  ramp: Float32Array;
  spawnDebt: number;
  retired: boolean;
  refs: number;
};

export type ParticleReading = {
  x: number;
  y: number;
  elev: number;
  life: number;
  config: ParticleEmitterDef;
  ramp: Float32Array;
  z: number;
  box: DepthBox;
  stackBias: number;
  taper: number;
};

export class ParticleSystem {
  private readonly x = new Float32Array(MAX_LIVE_PARTICLES);
  private readonly y = new Float32Array(MAX_LIVE_PARTICLES);
  private readonly elev = new Float32Array(MAX_LIVE_PARTICLES);
  private readonly vx = new Float32Array(MAX_LIVE_PARTICLES);
  private readonly vy = new Float32Array(MAX_LIVE_PARTICLES);
  private readonly vElev = new Float32Array(MAX_LIVE_PARTICLES);
  private readonly ageMs = new Float32Array(MAX_LIVE_PARTICLES);
  private readonly ttlMs = new Float32Array(MAX_LIVE_PARTICLES);
  private readonly emitterIdx = new Int32Array(MAX_LIVE_PARTICLES);
  private readonly birthTaper = new Float32Array(MAX_LIVE_PARTICLES);
  private liveCount = 0;

  private emitters: EmitterState[] = [];
  private emitterById = new Map<string, number>();

  private readonly random: Random;

  constructor(random: Random = Math.random) {
    this.random = random;
  }

  get count(): number {
    return this.liveCount;
  }

  get emitterCount(): number {
    return this.emitters.length;
  }

  setEmitters(specs: readonly ParticleEmitterSpec[]) {
    for (const state of this.emitters) state.retired = true;

    for (const spec of specs) {
      const existing = this.emitterById.get(spec.id);
      if (existing === undefined) {
        this.emitterById.set(spec.id, this.emitters.length);
        this.emitters.push({
          spec,
          ramp: compileRamp(spec.config.ramp),
          spawnDebt: 0,
          retired: false,
          refs: 0,
        });
        continue;
      }
      const state = this.emitters[existing]!;
      if (state.spec.config.ramp !== spec.config.ramp) {
        state.ramp = compileRamp(spec.config.ramp);
      }
      state.spec = spec;
      state.retired = false;
    }
  }

  advance(dtMs: number) {
    if (dtMs <= 0) return;
    const dtSec = dtMs / MS_PER_SECOND;

    let i = 0;
    while (i < this.liveCount) {
      const age = this.ageMs[i]! + dtMs;
      if (age >= this.ttlMs[i]!) {
        this.emitters[this.emitterIdx[i]!]!.refs--;
        this.swapRemove(i);
        continue;
      }
      this.ageMs[i] = age;
      const config = this.emitters[this.emitterIdx[i]!]!.spec.config;
      const vx = this.vx[i]! + config.windX * dtSec;
      const vy = this.vy[i]! + config.windY * dtSec;
      const vElev = this.vElev[i]! + config.gravity * dtSec;
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vElev[i] = vElev;
      this.x[i] = this.x[i]! + vx * dtSec;
      this.y[i] = this.y[i]! + vy * dtSec;
      this.elev[i] = this.elev[i]! + vElev * dtSec;
      i++;
    }

    for (let e = 0; e < this.emitters.length; e++) {
      const state = this.emitters[e]!;
      if (state.retired) continue;
      state.spawnDebt += state.spec.config.ratePerSecond * state.spec.taper * dtSec;
      while (state.spawnDebt >= 1) {
        state.spawnDebt -= 1;
        if (!this.spawn(e, state)) break;
      }
    }

    this.dropFinishedEmitters();
  }

  specAt(index: number): ParticleEmitterSpec {
    return this.emitters[this.emitterIdx[index]!]!.spec;
  }

  read(index: number, into: ParticleReading): ParticleReading {
    into.x = this.x[index]!;
    into.y = this.y[index]!;
    into.elev = this.elev[index]!;
    const ttl = this.ttlMs[index]!;
    into.life = ttl <= 0 ? 1 : this.ageMs[index]! / ttl;
    const state = this.emitters[this.emitterIdx[index]!]!;
    into.config = state.spec.config;
    into.ramp = state.ramp;
    into.z = state.spec.z;
    into.box = state.spec.box;
    into.stackBias = state.spec.stackBias;
    into.taper = this.birthTaper[index]!;
    return into;
  }

  clear() {
    this.liveCount = 0;
    this.emitters = [];
    this.emitterById.clear();
  }

  private spawn(emitterIndex: number, state: EmitterState): boolean {
    if (this.liveCount >= MAX_LIVE_PARTICLES) return false;
    const i = this.liveCount++;
    const c = state.spec.config;
    const r = this.random;

    this.x[i] = state.spec.cx + this.signed() * c.spawnRadiusCells;
    this.y[i] = state.spec.cy + this.signed() * c.spawnRadiusCells;
    this.elev[i] = state.spec.footElev + lerp(c.spawnElevFrom, c.spawnElevTo, r());
    this.vx[i] = this.signed() * c.driftCellsPerSecond;
    this.vy[i] = this.signed() * c.driftCellsPerSecond;
    this.vElev[i] = lerp(c.riseFrom, c.riseTo, r());
    this.ageMs[i] = 0;
    this.ttlMs[i] = lerp(c.ttlFromMs, c.ttlToMs, r());
    this.emitterIdx[i] = emitterIndex;
    this.birthTaper[i] = state.spec.taper;
    state.refs++;
    return true;
  }

  private signed(): number {
    return this.random() * 2 - 1;
  }

  private swapRemove(index: number) {
    const last = --this.liveCount;
    if (index === last) return;
    this.x[index] = this.x[last]!;
    this.y[index] = this.y[last]!;
    this.elev[index] = this.elev[last]!;
    this.vx[index] = this.vx[last]!;
    this.vy[index] = this.vy[last]!;
    this.vElev[index] = this.vElev[last]!;
    this.ageMs[index] = this.ageMs[last]!;
    this.ttlMs[index] = this.ttlMs[last]!;
    this.emitterIdx[index] = this.emitterIdx[last]!;
    this.birthTaper[index] = this.birthTaper[last]!;
  }

  private dropFinishedEmitters() {
    let finished = false;
    for (const state of this.emitters) {
      if (state.retired && state.refs === 0) {
        finished = true;
        break;
      }
    }
    if (!finished) return;

    const remap = new Int32Array(this.emitters.length);
    const kept: EmitterState[] = [];
    for (let e = 0; e < this.emitters.length; e++) {
      const state = this.emitters[e]!;
      if (state.retired && state.refs === 0) {
        remap[e] = -1;
        continue;
      }
      remap[e] = kept.length;
      kept.push(state);
    }

    for (let i = 0; i < this.liveCount; i++) {
      this.emitterIdx[i] = remap[this.emitterIdx[i]!]!;
    }
    this.emitters = kept;
    this.emitterById.clear();
    for (let e = 0; e < kept.length; e++) {
      this.emitterById.set(kept[e]!.spec.id, e);
    }
  }
}

const MS_PER_SECOND = 1_000;

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}
