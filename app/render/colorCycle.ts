import * as THREE from "three";
import { PX_PER_HEIGHT } from "../lib/geometry";
import { CELL_SIZE, type MapFile, type TileColorCycle } from "../lib/types";
import { getStack } from "../lib/mapData";
import {
  FLOW_PERIOD,
  LIQUID_FADE_CELLS,
  cellBank,
  cellFlow,
  cellWaves,
  flowDelta,
} from "../lib/waterFlow";

export const MAX_CYCLE_STEPS = 32;

/** The squared sRGB distance under which an art pixel counts as the key colour, as in the reflection mask. */
const KEY_TOLERANCE_SQ = 1e-5;

/** Larger noise in art pixels bends the bands; the smaller one roughens their edges. */
const RIPPLE_WIDE_PX = 6;
const RIPPLE_FINE_PX = 2.5;
const RIPPLE_FINE_SHARE = 0.35;
/** The size of the gaps that break a band into dashes, in art pixels. */
const GAP_PX = 3.5;
/** The size of the patches in which a pixel takes the larger or the smaller of two wave counts it lies between. */
const WAVES_PATCH_PX = 9;
/** The size of the noise that roughens the edge of a liquid laid over another. */
const COVER_NOISE_PX = 3;
/**
 * A corner's cover is the share of the cells round it that hold the same
 * liquid (`coverCorners`). A cell's art shows nothing where the blended cover is
 * `COVER_FROM` and all of itself from `COVER_FROM + COVER_SPAN`, so a
 * straight edge fades over its two outer cells.
 */
const COVER_FROM = 0.35;
const COVER_SPAN = 0.55;
/**
 * Bands thin out from `CALM_FROM` cells off the nearest bank and are gone by
 * `CALM_TO`, so open water far from any shore is its own plain colour.
 */
const CALM_FROM = 4;
const CALM_TO = 20;
/** Waves are twice as long this many cells off the nearest bank, over a dithered patch `LONG_SPAN` cells wide. */
const LONG_FROM = 5;
const LONG_SPAN = 3;

export type Corners = readonly [number, number, number, number];

/** What a colour-cycled quad carries at its corners (north-west, north-east, south-west, south-east). */
export type CycleCorners = { flow: Corners; waves: Corners; bank: Corners; cover: Corners };

export const FULL_COVER: Corners = [1, 1, 1, 1];

export type ColorCycleUniforms = {
  uCycleKey: { value: THREE.Vector3 };
  uCycleRamp: { value: THREE.Vector3[] };
  uCycleSteps: { value: number };
  uCyclePerCell: { value: number };
  uCycleRipple: { value: number };
  uCycleGaps: { value: number };
  uCyclePhase: { value: number };
};

export function colorCycleUniforms(cycle: TileColorCycle): ColorCycleUniforms {
  const key = new THREE.Color(cycle.key).convertLinearToSRGB();
  const ramp = Array.from({ length: MAX_CYCLE_STEPS }, () => new THREE.Vector3());
  cycle.ramp.slice(0, MAX_CYCLE_STEPS).forEach((hex, i) => {
    const c = new THREE.Color(hex);
    ramp[i]!.set(c.r, c.g, c.b);
  });
  return {
    uCycleKey: { value: new THREE.Vector3(key.r, key.g, key.b) },
    uCycleRamp: { value: ramp },
    uCycleSteps: { value: Math.min(cycle.ramp.length, MAX_CYCLE_STEPS) },
    uCyclePerCell: { value: 1 / cycle.cellsPerCycle },
    uCycleRipple: { value: cycle.ripple },
    uCycleGaps: { value: cycle.gaps },
    uCyclePhase: { value: 0 },
  };
}

/**
 * How many cycles the clock has turned through, as a whole number of ramp
 * steps: the ramp turns a step at a time, as a palette does, so the picture
 * only changes when the step does. It counts up to the cycles in a stored
 * flow period and starts again. Wrapping after one cycle snapped every band at
 * the loop: a band drawing half as many waves jumped half a cycle, and every
 * band's count along the current, which picks its gaps, moved on. A stored
 * period is a whole number of cycles at every wave count and is what the
 * count is taken modulo, so wrapping there changes nothing.
 */
export function cyclePhaseAt(cycle: TileColorCycle, clockMs: number): number {
  const steps = Math.min(cycle.ramp.length, MAX_CYCLE_STEPS);
  const loopMs = cycle.msPerCycle * cyclesPerPeriod(cycle);
  const within = ((clockMs % loopMs) + loopMs) % loopMs;
  return Math.floor((within / cycle.msPerCycle) * steps) / steps;
}

export function cyclesPerPeriod(cycle: TileColorCycle): number {
  return FLOW_PERIOD / cycle.cellsPerCycle;
}

/**
 * The current at the four corners of a cell (north-west, north-east,
 * south-west, south-east), each the mean of the cells that meet there and
 * carry a `flow`. Each is brought within half a period of the cell's own
 * value, so a corner averaged across the point where the stored value wraps
 * is not dragged half a period away; neighbouring cells may then disagree on
 * a corner by whole periods, which the shader's `fract` cannot see.
 */
export function cycleCorners(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  own: number,
  cycling: ReadonlySet<string>,
): Corners {
  return currentCorners(map, x, y, z, own, 1, 1, cycling).flow;
}

const CORNER_CELLS = [
  [0, 1, 3, 4],
  [1, 2, 4, 5],
  [3, 4, 6, 7],
  [4, 5, 7, 8],
] as const;

/** `cycleCorners`, with the mean `waves` and `bank` of the same cells beside it. */
export function currentCorners(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  own: number,
  ownWaves: number,
  ownBank: number,
  cycling: ReadonlySet<string>,
): { flow: Corners; waves: Corners; bank: Corners } {
  const flows: (number | null)[] = [];
  const waves: number[] = [];
  const banks: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) {
        flows.push(own);
        waves.push(ownWaves);
        banks.push(ownBank);
        continue;
      }
      const stack = getStack(map, x + dx, y + dy, z);
      const f = cellFlow(stack, y + dy, cycling);
      flows.push(f === null ? null : own + flowDelta(own, f));
      waves.push(cellWaves(stack, cycling));
      banks.push(cellBank(stack, cycling));
    }
  }
  const corner = (cells: readonly number[]): [number, number, number] => {
    let flow = 0;
    let wave = 0;
    let bank = 0;
    let n = 0;
    for (const c of cells) {
      const f = flows[c];
      if (f === null || f === undefined) continue;
      flow += f;
      wave += waves[c]!;
      bank += banks[c]!;
      n++;
    }
    return [flow / n, wave / n, bank / n];
  };
  const at = CORNER_CELLS.map(corner);
  const pick = (k: number): Corners => [at[0]![k]!, at[1]![k]!, at[2]![k]!, at[3]![k]!];
  return { flow: pick(0), waves: pick(1), bank: pick(2) };
}

/**
 * At each corner of a cell, the share of the cells within `LIQUID_FADE_CELLS`
 * of it that hold `tileId` on this level: 1 deep inside a pool, a half on a
 * straight edge of one. The shader fades the liquid out where it is low.
 */
export function coverCorners(
  map: MapFile,
  x: number,
  y: number,
  z: number,
  tileId: string,
): Corners {
  const reach = LIQUID_FADE_CELLS;
  const side = 2 * reach + 1;
  const holds: boolean[] = [];
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      holds.push(getStack(map, x + dx, y + dy, z).some((p) => p.tileId === tileId));
    }
  }
  const block = 2 * reach;
  const corner = (ox: number, oy: number) => {
    let n = 0;
    for (let dy = 0; dy < block; dy++) {
      for (let dx = 0; dx < block; dx++) if (holds[(oy + dy) * side + ox + dx]) n++;
    }
    return n / (block * block);
  };
  return [corner(0, 0), corner(1, 0), corner(0, 1), corner(1, 1)];
}

export const COLOR_CYCLE_GLSL_VERTEX_COMMON = `
#ifdef COLOR_CYCLE
attribute vec4 aCycle;
attribute vec4 aCycleWaves;
attribute vec4 aCycleBank;
attribute vec4 aCycleCover;
varying vec4 vCycle;
varying vec4 vCycleWaves;
varying vec4 vCycleBank;
varying vec4 vCycleCover;
#endif
`;

export const COLOR_CYCLE_GLSL_VERTEX = `
#ifdef COLOR_CYCLE
vCycle = aCycle;
vCycleWaves = aCycleWaves;
vCycleBank = aCycleBank;
vCycleCover = aCycleCover;
#endif
`;

function glsl(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

export const COLOR_CYCLE_GLSL_COMMON = `
#ifdef COLOR_CYCLE
uniform vec3 uCycleKey;
uniform vec3 uCycleRamp[${MAX_CYCLE_STEPS}];
uniform float uCycleSteps;
uniform float uCyclePerCell;
uniform float uCycleRipple;
uniform float uCycleGaps;
uniform float uCyclePhase;
varying vec4 vCycle;
varying vec4 vCycleWaves;
varying vec4 vCycleBank;
varying vec4 vCycleCover;
float cycleCorners(vec4 corners, vec2 uv) {
  return mix(mix(corners.x, corners.y, uv.x), mix(corners.z, corners.w, uv.x), uv.y);
}
float cycleHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float cycleNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(cycleHash(i), cycleHash(i + vec2(1.0, 0.0)), f.x),
    mix(cycleHash(i + vec2(0.0, 1.0)), cycleHash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}
#endif
`;

/**
 * `uCycleRamp[0]` is the water's own colour: a gap in a band shows it.
 *
 * Runs straight after the texture is sampled, before the reflection reads
 * `sampledDiffuseColor`, so the reflection mask sees the cycled colour and a
 * crest can be left out of it. The cell's corners are blended bilinearly at
 * the art pixel's centre: a quad is two triangles, and leaving the blend to
 * the varying would crease every band along the diagonal.
 */
export const COLOR_CYCLE_GLSL_FRAGMENT = `
#if defined(COLOR_CYCLE) && defined(USE_MAP)
{
  vec3 cycleD = sRGBTransferOETF(sampledDiffuseColor).rgb - uCycleKey;
  if (dot(cycleD, cycleD) < ${KEY_TOLERANCE_SQ.toExponential()}) {
    vec2 cyclePx = floor(vWorldPx) + 0.5;
    vec2 cycleUv = clamp(
      (cyclePx - vBox.xy + ${glsl(CELL_SIZE)} + vBox.z * ${glsl(PX_PER_HEIGHT)}) / ${glsl(CELL_SIZE)},
      0.0,
      1.0
    );
    float cycleCover = (cycleCorners(vCycleCover, cycleUv) - ${glsl(COVER_FROM)}) / ${glsl(COVER_SPAN)};
    float cycleCoverKey =
      0.35 * fxBayer4(cyclePx) + 0.65 * cycleNoise(cyclePx / ${glsl(COVER_NOISE_PX)} + 71.0);
    if (cycleCover < cycleCoverKey) diffuseColor.a = 0.0;
    float cycleFlow = cycleCorners(vCycle, cycleUv);
    // A whole number of waves, halved far from a bank, so a stored period
    // still holds a whole number of cycles and the bands meet where the
    // stored flow wraps; between two counts a pixel takes one or the other in
    // patches.
    float cycleBank = cycleCorners(vCycleBank, cycleUv);
    float cycleLong = step(
      1.0,
      (cycleBank - ${glsl(LONG_FROM)}) / ${glsl(LONG_SPAN)} + cycleNoise(cyclePx / ${glsl(WAVES_PATCH_PX)} + 41.0)
    );
    float cycleWaves = clamp(
      floor(cycleCorners(vCycleWaves, cycleUv) + cycleNoise(cyclePx / ${glsl(WAVES_PATCH_PX)} + 13.0)),
      1.0,
      3.0
    ) * (1.0 - 0.5 * cycleLong);
    // The noise shrinks half as fast as the waves, or a river's dashes break
    // up into single pixels.
    vec2 cycleScaledPx = cyclePx * (0.5 + 0.5 * cycleWaves);
    float cycleRipple =
      (1.0 - ${glsl(RIPPLE_FINE_SHARE)}) * cycleNoise(cycleScaledPx / ${glsl(RIPPLE_WIDE_PX)}) +
      ${glsl(RIPPLE_FINE_SHARE)} * cycleNoise(cycleScaledPx / ${glsl(RIPPLE_FINE_PX)} + 31.0);
    float cycleRun =
      cycleWaves * (cycleFlow * uCyclePerCell - uCyclePhase) +
      (cycleRipple - 0.5) * uCycleRipple / uCycleSteps;
    float cycleAt = fract(cycleRun);
    vec3 cycleColor = uCycleRamp[int(min(floor(cycleAt * uCycleSteps), uCycleSteps - 1.0))];
    // Each band has its own gaps, picked by its count along the current. The
    // count is taken modulo the cycles in a stored period, because two cells
    // either side of where the stored flow wraps count their bands from
    // different starts.
    float cycleBand = mod(floor(cycleRun), cycleWaves * ${glsl(FLOW_PERIOD)} * uCyclePerCell);
    float cycleGap = cycleNoise(cycleScaledPx / ${glsl(GAP_PX)} + cycleHash(vec2(cycleBand, 5.0)) * 97.0);
    float cycleCalm = smoothstep(${glsl(CALM_FROM)}, ${glsl(CALM_TO)}, cycleBank);
    if (cycleGap < mix(uCycleGaps, 1.0, cycleCalm)) cycleColor = uCycleRamp[0];
    sampledDiffuseColor.rgb = cycleColor;
    diffuseColor.rgb = diffuse * cycleColor;
  }
}
#endif
`;
