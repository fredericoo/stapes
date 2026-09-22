/**
 * The key that presses the control beside it, drawn as a key: a pale rounded
 * cap standing on a darker edge two pixels below it, so it reads as raised.
 *
 * One component for every drawn shortcut — the list of what is in reach, the
 * conversation panel, the spell bar and the editors — so a key looks the same
 * wherever one is offered. A shortcut named inside a tooltip's sentence is
 * text, not a drawing, and does not use this.
 *
 * The thin ink border is for light surfaces, where a pale cap on a pale field
 * would otherwise have no outline; on the game's dark column it all but
 * disappears into the edge below it.
 *
 * Dimmed with a disabled control around it, so a greyed Trade does not keep a
 * bright key that promises the press will work.
 *
 * Drawn for an empty label too, as an empty gutter of the same width, so a
 * column of controls stays aligned whether or not each one has a key.
 * `aria-hidden` because it is a hint for the eye, and the control beside it
 * already names what it does.
 */
export function KeyHint({ label, className = "" }: { label: string; className?: string }) {
  if (!label) return <span aria-hidden="true" className={`w-3.5 shrink-0 ${className}`} />;
  return (
    <kbd
      aria-hidden="true"
      className={[
        // `mb-0.5` makes room for the edge, which is a shadow and takes none.
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
