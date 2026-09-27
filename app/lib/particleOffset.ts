import { COMMON_FUNCTIONS, compileExpression, type Grammar } from "./expression";
import type { ParticleEmitterDef } from "./particleVfx";

/**
 * `SEED` is drawn once for each particle at birth, in `[0, 1)`, so it can
 * spread particles over a phase or a radius without any of them jittering.
 */
export type OffsetScope = {
  AGE_SEC: number;
  LIFE: number;
  SEED: number;
};

export type OffsetFormula = (scope: OffsetScope) => number;

export type ParticleOffsets = {
  x: OffsetFormula;
  y: OffsetFormula;
  elev: OffsetFormula;
};

const OFFSET_GRAMMAR: Grammar<OffsetScope> = {
  variables: {
    AGE_SEC: (scope) => scope.AGE_SEC,
    LIFE: (scope) => scope.LIFE,
    SEED: (scope) => scope.SEED,
    PI: () => Math.PI,
  },
  functions: {
    ...COMMON_FUNCTIONS,
    sin: { arity: 1, apply: Math.sin },
    cos: { arity: 1, apply: Math.cos },
    sqrt: { arity: 1, apply: Math.sqrt },
    pow: { arity: 2, apply: Math.pow },
  },
};

const STAY: OffsetFormula = () => 0;

/**
 * Not rounded, unlike a status formula: a particle moves by fractions of a
 * cell. A non-finite result is no offset, so `sqrt(-1)` or a division by zero
 * leaves the particle on its path instead of sending it off the map.
 */
export function parseOffsetFormula(source: string): OffsetFormula | null {
  const root = compileExpression(source, OFFSET_GRAMMAR);
  if (!root) return null;
  return (scope) => {
    const offset = root(scope);
    return Number.isFinite(offset) ? offset : 0;
  };
}

export function isOffsetFormula(source: string): boolean {
  return source.trim() === "" || parseOffsetFormula(source) !== null;
}

export function compileOffsets(def: ParticleEmitterDef): ParticleOffsets | null {
  const x = parseOffsetFormula(def.offsetX);
  const y = parseOffsetFormula(def.offsetY);
  const elev = parseOffsetFormula(def.offsetElev);
  if (!x && !y && !elev) return null;
  return { x: x ?? STAY, y: y ?? STAY, elev: elev ?? STAY };
}
