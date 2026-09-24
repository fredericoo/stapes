/**
 * What stands over the game while the world is at its player limit.
 *
 * The server closes the socket with `CLOSE_WORLD_FULL`. Unlike maintenance, the
 * page keeps trying on its own — a seat opens whenever somebody leaves — so
 * this screen has nothing to do but say so. It comes down when a connection is
 * let in. @see ./WorldPage, which owns the retry
 *
 * Set like `./MaintenanceScreen`, which stands in the same slot.
 */

/**
 * The system's own monospace. @see LoadingScreen, which explains why the theme's
 * face is not an option here.
 */
const SYSTEM_MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

export function WorldFullScreen() {
  return (
    <div
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-ink p-6 text-center"
      // An alert rather than a status, as in `MaintenanceScreen`: it replaces
      // the world rather than being a stage in waiting for one.
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
