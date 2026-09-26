export type NumberRule = {
  min?: number;
  max?: number;
  step?: number;
  allowBlank?: boolean;
};

export type NumberParse = { ok: true; value: number | null } | { ok: false; error: string };

/**
 * `Math.round(value / step) * step` is exact in decimal and not in binary — 0.1
 * steps can land on values like `0.30000000000000004`. Rounding back through
 * the step's own decimal precision removes that dust.
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
