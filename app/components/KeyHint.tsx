/**
 * The key that presses the control beside it, drawn small and faint.
 *
 * One component for the list of what is in reach and the conversation panel, so
 * the digit reads the same wherever the digit row is bound.
 *
 * Drawn for an empty label too, as an empty gutter of the same width, so a
 * column of controls stays aligned whether or not each one has a key.
 * `aria-hidden` because it is a keyboard hint, and the control beside it
 * already names what it does.
 */
export function KeyHint({ label }: { label: string }) {
  return (
    <span
      aria-hidden="true"
      className="w-3 shrink-0 text-center text-[10px] leading-none tabular-nums text-paper/50"
    >
      {label}
    </span>
  );
}
