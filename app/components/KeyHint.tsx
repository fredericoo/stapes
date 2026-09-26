import { useKeyboardLikely } from "./useKeyboardLikely";

export function KeyHint({ label, className = "" }: { label: string; className?: string }) {
  const keyboard = useKeyboardLikely();
  if (!keyboard) return null;
  if (!label) return <span aria-hidden="true" className={`w-3.5 shrink-0 ${className}`} />;
  return (
    <kbd
      aria-hidden="true"
      className={[
        "mb-0.5 inline-grid h-3.5 min-w-3.5 shrink-0 place-items-center rounded-[4px] border border-ink/60 bg-paper px-0.5",
        "font-mono text-[9px] leading-none font-bold text-ink shadow-[0_2px_0_var(--color-muted)]",
        "in-aria-disabled:opacity-40",
        className,
      ].join(" ")}
    >
      {label}
    </kbd>
  );
}
