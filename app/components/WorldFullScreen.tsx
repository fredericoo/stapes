const SYSTEM_MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

export function WorldFullScreen() {
  return (
    <div
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-ink p-6 text-center"
      role="alert"
      style={{ fontFamily: SYSTEM_MONO }}
    >
      <span className="text-xs uppercase tracking-widest text-paper">The world is full</span>
      <p className="max-w-sm text-xs leading-relaxed text-paper/70">
        Every place in the world is taken right now.
      </p>
      <p className="max-w-sm text-xs leading-relaxed text-paper/40">
        You will enter automatically when somebody leaves.
      </p>
    </div>
  );
}
