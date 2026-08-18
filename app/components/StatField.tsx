import { Input } from "../ui";

/**
 * One numeric stat, with the sentence that says what it does to a fight.
 *
 * The readout is the point of this component. Every one of these numbers feeds a
 * curve — accuracy widens a band, speed is geometric, flee is measured against
 * half of somebody else's accuracy — and none of that is guessable from a box
 * with `50` in it. Showing what the current value *means* is what makes the
 * curves authorable rather than something to be discovered by fighting things.
 *
 * Shared by the Battle and Item tabs, which used to hold a copy each. They are
 * read side by side when balancing a weapon against the creature it is meant to
 * kill, and two components that were meant to look identical are two components
 * that will eventually not.
 */
export function StatField({
  label,
  hint,
  value,
  min,
  max,
  onChange,
  readout,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max?: number;
  onChange: (next: number) => void;
  readout?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="font-bold uppercase text-muted">{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        step={1}
        className="w-24"
        value={value}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (!Number.isFinite(next)) return;
          onChange(Math.max(min, Math.min(max ?? Infinity, Math.round(next))));
        }}
      />
      <span className="max-w-64 text-[11px] leading-snug text-muted">
        {hint}
        {readout ? <strong className="block text-ink">{readout}</strong> : null}
      </span>
    </label>
  );
}
