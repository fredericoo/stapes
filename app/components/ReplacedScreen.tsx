const SYSTEM_MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

export function ReplacedScreen() {
  return (
    <div
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-ink p-6 text-center"
      role="alert"
      style={{ fontFamily: SYSTEM_MONO }}
    >
      <span className="text-xs uppercase tracking-widest text-paper">Playing in another tab</span>
      <p className="max-w-sm text-xs leading-relaxed text-paper/70">
        This character was opened somewhere else, so this tab let go of it. Playing here closes the
        other one.
      </p>
      <button
        type="button"
        autoFocus
        onClick={() => window.location.reload()}
        className="border-2 border-paper px-3 py-1.5 text-xs uppercase tracking-widest text-paper hover:bg-paper hover:text-ink"
        style={{ fontFamily: SYSTEM_MONO }}
      >
        Play here
      </button>
    </div>
  );
}
