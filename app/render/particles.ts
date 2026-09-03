import type { DepthBox } from "../lib/geometry";
import {
  compileRamp,
  MAX_LIVE_PARTICLES,
  type ParticleEmitterDef,
} from "../lib/particleVfx";

/**
 * The particle pool: where every spark on screen is, and where it is going.
 *
 * **No THREE in here, and none coming.** What a particle *is* — a position in
 * cells, a velocity, an age against a lifetime — is arithmetic, and keeping it
 * arithmetic is what lets a plume be asserted in a unit test instead of eyeballed
 * against a canvas. The layer that turns this into quads is `./particleLayer`,
 * and it reads this rather than owning it.
 *
 * ## Typed arrays and a fixed pool
 *
 * Parallel `Float32Array`s rather than an array of objects, on the terms
 * docs/notes.md sets for anything in the frame path: this is walked in full
 * thirty to a hundred and twenty times a second, and an array of objects at
 * this rate is a garbage collector running in the middle of the frame budget.
 *
 * The pool is allocated once at {@link MAX_LIVE_PARTICLES} and never grows.
 * A world that asks for more than that gets fewer particles, not a bigger
 * allocation mid-frame — an emitter that can make the renderer allocate is an
 * emitter that can make the renderer stutter, and a spark nobody counted is not
 * worth a hitch.
 *
 * ## Death is a swap, not a splice
 *
 * A dead particle is overwritten by the last live one and the count drops. That
 * reorders the pool constantly, which is exactly why **nothing outside may hold
 * an index between frames** — there is no particle identity here, on purpose.
 * A particle is a thing that is drawn and then is not.
 */

/** Where the world's dice would go, if this needed any. It does not — see below. */
export type Random = () => number;

/**
 * One plume, attached to a cell.
 *
 * Carries its own draw order rather than deriving one, because the rule is a
 * statement about the *body*, not about the particle: a plume sorts as though it
 * were a two-high tile standing on top of the affected stack, wherever the
 * individual sparks have drifted to. See {@link ParticleSystem} — that is what
 * keeps a fire from flickering in and out behind the thing that is on fire.
 */
export type ParticleEmitterSpec = {
  /** Stable across frames, and how a plume is recognised as the same plume. */
  id: string;
  config: ParticleEmitterDef;
  /** Cell centre the plume is anchored to, in cells. */
  cx: number;
  cy: number;
  /** Absolute height units the plume's floor sits at. */
  footElev: number;
  /** The level it is drawn on — decides its light and its roof-cut. */
  z: number;
  /** The order every particle of this plume takes. */
  box: DepthBox;
  stackBias: number;
  /**
   * How much of this effect is left, 1 for a status not yet winding down.
   *
   * Rewritten every frame from what the status has to run — see `taperAt`. It
   * scales how many particles are born; each one then *keeps* the value it was
   * born under, which is what makes a plume thin out and shrink rather than
   * having every spark in the air shrivel at once. @see ParticleReading.taper
   */
  taper: number;
};

/**
 * A plume the system is tracking, plus what it costs to keep tracking one.
 *
 * `ramp` is compiled once here rather than per particle per frame, which is the
 * only reason a colour ramp is affordable at all — see `compileRamp`.
 */
type EmitterState = {
  spec: ParticleEmitterSpec;
  ramp: Float32Array;
  /**
   * Particles owed but not yet born, carried across frames.
   *
   * Without it every emitter under one particle per frame emits at the frame
   * rate's mercy: eight per second at 120fps is 0.0667 per frame, which truncates
   * to zero every single frame and produces a plume that emits nothing at all.
   */
  spawnDebt: number;
  /**
   * Set when the status ended but the last sparks are still in the air.
   *
   * A retired emitter emits nothing and is dropped once its final particle dies.
   * The alternative — killing a plume with its status — makes a fire go out
   * between two frames, which reads as a rendering bug rather than as a fire
   * going out.
   */
  retired: boolean;
  /** Live particles pointing at this emitter, so retirement knows when it is done. */
  refs: number;
};

/**
 * What one particle looks like right now, and everything needed to draw it.
 *
 * The plume's draw data is copied onto the reading rather than reached through a
 * handle to the emitter, so nothing outside this file needs a name for the
 * emitter's private state — and no caller gets the chance to hold one across a
 * frame that retired it.
 */
export type ParticleReading = {
  /** Fractional cell position. */
  x: number;
  y: number;
  /** Absolute height units. */
  elev: number;
  /** 0 at birth, 1 at death. What every ramp and every lerp is sampled against. */
  life: number;
  config: ParticleEmitterDef;
  /** The plume's colours, flattened. @see compileRamp */
  ramp: Float32Array;
  /** The level this plume is drawn on. */
  z: number;
  /** The order every particle of this plume takes. */
  box: DepthBox;
  stackBias: number;
  /**
   * The plume's taper at the moment this particle was born.
   *
   * Frozen rather than read live, and that is an art decision: a spark that kept
   * up with its emitter would visibly shrink in mid-air every time the status
   * ticked down a step. Held at birth, the plume instead emits fewer and smaller
   * sparks as it winds down while the ones already flying finish the size they
   * started — which is what a fire dying down actually looks like.
   */
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
  /** @see ParticleReading.taper */
  private readonly birthTaper = new Float32Array(MAX_LIVE_PARTICLES);
  private liveCount = 0;

  /** Insertion-ordered, so an index survives a frame that changed nothing. */
  private emitters: EmitterState[] = [];
  private emitterById = new Map<string, number>();

  private readonly random: Random;

  /**
   * The dice are this system's own, and that is the one place this feature
   * departs from the world's discipline.
   *
   * Everything else that rolls in this codebase rolls on the session's seeded
   * generator so two worlds on one seed agree. Particles do not need to agree
   * and must not try: they are client-side, they are not on the wire, and a
   * player who looks away and back is *expected* to come back to a different
   * plume. Drawing them from the world's dice would put a per-frame, per-client,
   * per-spark consumer in front of every roll the simulation makes and desync
   * two clients that were otherwise identical.
   *
   * Injectable so a test can hand it a counter and assert the arithmetic.
   */
  constructor(random: Random = Math.random) {
    this.random = random;
  }

  /** How many particles are in the air. */
  get count(): number {
    return this.liveCount;
  }

  /** How many plumes are tracked, retired ones included. */
  get emitterCount(): number {
    return this.emitters.length;
  }

  /**
   * Reconcile the tracked plumes against what this frame says exists.
   *
   * Matched by id, so a plume that merely moved keeps its debt and its
   * particles: a burning creature that takes a step is the same fire, and one
   * that restarted every step would emit in bursts synchronised to its walk.
   *
   * A spec that has stopped appearing is *retired* rather than dropped, and its
   * particles are left to finish. A spec whose config changed is re-compiled in
   * place — that is what makes the editor's preview respond to a dragged slider
   * without the plume blinking out and starting again.
   */
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
      // The ramp is the expensive half and almost never changes, so it is
      // recompiled only when the stops are not the same objects the last frame
      // handed over. In play they never are — the catalogue is resolved once per
      // load — and in the editor they change on every keystroke, which is the
      // only place this costs anything and the one place it has to be right.
      if (state.spec.config.ramp !== spec.config.ramp) {
        state.ramp = compileRamp(spec.config.ramp);
      }
      state.spec = spec;
      state.retired = false;
    }
  }

  /**
   * Move time forward: age everything, bury what is done, and emit what is owed.
   *
   * Emission comes last so a particle born this frame is drawn at its birth
   * position rather than a frame's travel past it — a plume whose first frame of
   * every spark is already in flight has a visible hole at its mouth.
   */
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
      const vElev = this.vElev[i]! + config.gravity * dtSec;
      this.vElev[i] = vElev;
      this.x[i] = this.x[i]! + this.vx[i]! * dtSec;
      this.y[i] = this.y[i]! + this.vy[i]! * dtSec;
      this.elev[i] = this.elev[i]! + vElev * dtSec;
      i++;
    }

    for (let e = 0; e < this.emitters.length; e++) {
      const state = this.emitters[e]!;
      if (state.retired) continue;
      // The taper is spent here and nowhere else for emission: fewer born per
      // second as the status winds down, reaching none exactly as it ends.
      state.spawnDebt +=
        state.spec.config.ratePerSecond * state.spec.taper * dtSec;
      while (state.spawnDebt >= 1) {
        state.spawnDebt -= 1;
        // The debt is spent whether or not the pool had room. Keeping it would
        // mean a full pool banking an unbounded backlog that fires as one burst
        // the instant a slot frees — a plume that stutters worse the longer it
        // was starved.
        if (!this.spawn(e, state)) break;
      }
    }

    this.dropFinishedEmitters();
  }

  /**
   * The level one particle belongs to, without reading the rest of it.
   *
   * Its own accessor because the layer has to bucket every live particle by
   * level before it writes any of them, and a full {@link read} per particle
   * for one number is the sort of thing that is free once and not free at two
   * thousand.
   */
  levelAt(index: number): number {
    return this.emitters[this.emitterIdx[index]!]!.spec.z;
  }

  /**
   * One particle's state, for whoever is drawing it.
   *
   * Written into a caller-owned object rather than returned fresh, because this
   * is called once per particle per frame and the allocation would be the most
   * expensive thing about drawing one.
   */
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

  /** Forget every plume and every particle. */
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
    this.elev[i] =
      state.spec.footElev + lerp(c.spawnElevFrom, c.spawnElevTo, r());
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

  /** A roll in -1..1, which is what every symmetric spread here wants. */
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

  /**
   * Drop retired plumes that have nothing left in the air.
   *
   * Emitter indices are stored per particle, so removing one has to renumber
   * every particle that pointed past it. Retirement is rare — a status ending —
   * and the list is one entry per effect per body on screen, so the sweep is
   * over single digits and only runs on a frame that actually retired something.
   */
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
