import type { ReactNode } from "react";
import { FieldLabel, NumberInput } from "../ui";

export function StatField({
  label,
  info,
  hint,
  value,
  min,
  max,
  onChange,
  readout,
  step = 1,
}: {
  label: string;
  info?: ReactNode;
  hint?: string;
  value: number;
  min: number;
  max?: number;
  onChange: (next: number) => void;
  readout?: string;
  step?: number;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <FieldLabel info={info}>{label}</FieldLabel>
      <NumberInput
        min={min}
        max={max}
        step={step}
        className="w-24"
        value={value}
        onChange={onChange}
      />
      {hint || readout ? (
        <span className="max-w-64 text-[11px] leading-snug text-muted">
          {hint}
          {readout ? <strong className="block text-ink">{readout}</strong> : null}
        </span>
      ) : null}
    </label>
  );
}
