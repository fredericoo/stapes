/**
 * What a number box accepts, decided once the author has finished typing.
 *
 * Pure, so the rule can be tested without a DOM and read without one: the
 * component in `./NumberInput.tsx` only decides *when* to ask, which is on blur
 * and on Enter. Asking on every keystroke was the old behaviour, and it made
 * the box fight the person in it — clearing "1" to type "7" snapped straight
 * back to "1" before the 7 could be pressed.
 */
export type NumberRule = {
  min?: number;
  max?: number;
  /**
   * The granularity the value is rounded to. A normalisation rather than a
   * rule: typing 2.3 into a whole-number box commits 2, it does not complain.
   */
  step?: number;
  /** Whether an empty box is an answer (commits `null`) or an omission. */
  allowBlank?: boolean;
};

export type NumberParse =
  | { ok: true; value: number | null }
  | { ok: false; error: string };

/**
 * The nearest multiple of `step`, without the float dust.
 *
 * `Math.round(v / step) * step` is exact in decimal and not in binary — 0.1
 * steps land on things like `0.30000000000000004`, which is a number an author
 * did not type and would then see written into their file. Going back through
 * the step's own precision is what keeps the value the one on screen.
 */
export function roundToStep(value: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return Number((Math.round(value / step) * step).toFixed(decimals));
}

export function parseNumberInput(raw: string, rule: NumberRule): NumberParse {
  const text = raw.trim();
  if (text === "") {
    if (rule.allowBlank) return { ok: true, value: null };
    return { ok: false, error: "Required" };
  }

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return { ok: false, error: "Not a number" };

  if (rule.min !== undefined && rule.max !== undefined) {
    if (parsed < rule.min || parsed > rule.max) {
      return { ok: false, error: `${rule.min} to ${rule.max}` };
    }
  } else if (rule.min !== undefined && parsed < rule.min) {
    return { ok: false, error: `At least ${rule.min}` };
  } else if (rule.max !== undefined && parsed > rule.max) {
    return { ok: false, error: `At most ${rule.max}` };
  }

  const value = rule.step ? roundToStep(parsed, rule.step) : parsed;
  return { ok: true, value };
}
