export function AttentionDot({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`size-2.5 shrink-0 border-2 border-ink bg-interact ${className}`}
    />
  );
}
