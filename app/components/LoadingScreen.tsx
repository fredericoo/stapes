const SYSTEM_MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

export function LoadingScreen() {
  return (
    <div
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-ink"
      role="status"
    >
      <img
        src="/crystal-spinner.gif"
        alt=""
        width={64}
        height={64}
        style={{ imageRendering: "pixelated" }}
      />
      <span
        className="text-xs uppercase tracking-widest text-paper/70"
        style={{ fontFamily: SYSTEM_MONO }}
      >
        Loading…
      </span>
    </div>
  );
}
