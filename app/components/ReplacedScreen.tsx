/**
 * What stands over the game once another tab has taken this player.
 *
 * The server keeps one connection per actor, and when the actor connects again
 * it closes the older one with `CLOSE_REPLACED`. This tab must not reconnect on
 * its own: it would take the actor back, the other tab would do the same, and
 * the two would trade the body on every retry. So it stops here until somebody
 * asks for it.
 *
 * The button reloads rather than reconnecting in place. A reload is the path
 * every other way into the world already takes, and it closes the other tab
 * the same way this one was closed.
 *
 * Set like `./OutdatedScreen`, which stands in the same slot for the other
 * close that ends the page's reconnect loop.
 */

/**
 * The system's own monospace. @see LoadingScreen, which explains why the theme's
 * face is not an option here.
 */
const SYSTEM_MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

export function ReplacedScreen() {
  return (
    <div
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-ink p-6 text-center"
      // An alert rather than a status, as in `OutdatedScreen`: it replaces the
      // world rather than being a stage in waiting for one.
      role="alert"
      style={{ fontFamily: SYSTEM_MONO }}
    >
      <span className="text-xs uppercase tracking-widest text-paper">
        Playing in another tab
      </span>
      <p className="max-w-sm text-xs leading-relaxed text-paper/70">
        This character was opened somewhere else, so this tab let go of it.
        Playing here closes the other one.
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
