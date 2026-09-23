import { useEffect, useState } from "react";
import { fetchMaintenance } from "../lib/api";

/**
 * What stands over the game while the world is closed for maintenance.
 *
 * The server closes the socket with `CLOSE_MAINTENANCE`, and reconnecting would
 * be refused the same way until somebody opens the world again. So the page
 * stops its reconnect loop and puts this up, and this asks
 * `GET /api/maintenance` on a slow timer. When the answer is that the world is
 * open, it reloads: a reload is the path every other way into the world
 * already takes, and it runs the character chooser's checks again on the way.
 *
 * Set like `./ReplacedScreen`, which stands in the same slot for the other
 * close the page does not reconnect on.
 */

/** Slow on purpose: every closed tab is asking, and none of them is in a hurry. */
const POLL_MS = 30_000;

/** Said when whoever closed the world did not say why. */
const DEFAULT_MESSAGE = "The world is closed for maintenance.";

/**
 * The system's own monospace. @see LoadingScreen, which explains why the theme's
 * face is not an option here.
 */
const SYSTEM_MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

export function MaintenanceScreen() {
  /** Undefined until the first answer, so the default line does not flash first. */
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
      } catch {
        // The server is unreachable, which during maintenance is likely — it
        // may be the deploy the world was closed for. Ask again next time.
      }
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
      // An alert rather than a status, as in `ReplacedScreen`: it replaces the
      // world rather than being a stage in waiting for one.
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
