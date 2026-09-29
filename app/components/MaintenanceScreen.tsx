import { useEffect, useState } from "react";
import { fetchMaintenance } from "../lib/api";

const POLL_MS = 30_000;

const DEFAULT_MESSAGE = "The world is closed for maintenance.";

const SYSTEM_MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

export function MaintenanceScreen() {
  const [message, setMessage] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    const check = async () => {
      try {
        const state = await fetchMaintenance();
        if (disposed) return;
        if (!state) {
          window.location.reload();
          return;
        }
        setMessage(state.message);
      } catch {}
    };
    void check();
    const timer = setInterval(() => void check(), POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-ink p-6 text-center"
      role="alert"
      style={{ fontFamily: SYSTEM_MONO }}
    >
      <span className="text-xs uppercase tracking-widest text-paper">Closed for maintenance</span>
      <p className="max-w-sm whitespace-pre-line text-xs leading-relaxed text-paper/70">
        {message === undefined ? "\u00a0" : (message ?? DEFAULT_MESSAGE)}
      </p>
      <p className="max-w-sm text-xs leading-relaxed text-paper/40">
        You will enter the world automatically when it opens.
      </p>
    </div>
  );
}
