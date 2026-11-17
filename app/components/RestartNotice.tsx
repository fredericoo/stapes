import { useEffect, useState } from "react";

const TICK_MS = 200;

const SYSTEM_MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

export function RestartNotice({ atMs }: { atMs: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const seconds = Math.ceil((atMs - now) / 1000);

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex justify-center p-3"
      role="alert"
      style={{ fontFamily: SYSTEM_MONO }}
    >
      <div className="flex max-w-md flex-col items-center gap-1 border-2 border-ink bg-amber-400 px-5 py-3 text-center text-ink shadow-[0_4px_0_rgba(0,0,0,0.6)]">
        <span className="text-sm font-bold uppercase tracking-widest tabular-nums">
          {seconds > 0 ? `Server restarting in ${seconds}s` : "Server restarting"}
        </span>
        <span className="text-xs leading-relaxed">
          Your progress is saved. You will reconnect automatically.
        </span>
      </div>
    </div>
  );
}
