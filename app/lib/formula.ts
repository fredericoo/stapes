import { COMMON_FUNCTIONS, compileExpression, type Grammar } from "./expression";

export type FormulaScope = {
  DURATION_SEC: number;
  REMAINING_SEC: number;
  ELAPSED_SEC: number;
  MAX_HP: number;
  HP: number;
  statuses: ReadonlyArray<{ defId: string }>;
};

export const FORMULA_VARIABLES = [
  "DURATION_SEC",
  "REMAINING_SEC",
  "ELAPSED_SEC",
  "MAX_HP",
  "HP",
] as const satisfies ReadonlyArray<keyof FormulaScope>;

export type Formula = {
  readonly source: string;
  evaluate(scope: FormulaScope): number;
};

const STATUS_GRAMMAR: Grammar<FormulaScope> = {
  variables: Object.fromEntries(
    FORMULA_VARIABLES.map((name) => [name, (scope: FormulaScope) => scope[name]]),
  ),
  functions: COMMON_FUNCTIONS,
  lookups: {
    has_status: (id) => (scope) => (scope.statuses.some((status) => status.defId === id) ? 1 : 0),
  },
};

/**
 * Rounds half away from zero, unlike `Math.round`, which is asymmetric about
 * zero (`Math.round(-0.5)` is `-0` where `Math.round(0.5)` is `1`). A
 * non-finite result becomes 0 rather than `Infinity` or `NaN`, so a division
 * by zero in an authored formula cannot propagate into a body's hit points.
 */
export function integerise(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.sign(value) * Math.round(Math.abs(value));
}

export function constantFormula(value: number): Formula {
  const rounded = integerise(value);
  return { source: String(value), evaluate: () => rounded };
}

export function parseFormula(source: string): Formula | null {
  const root = compileExpression(source, STATUS_GRAMMAR);
  if (!root) return null;
  return {
    source,
    evaluate: (scope) => integerise(root(scope)),
  };
}
