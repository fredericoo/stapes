/**
 * What stands in front of the world until somebody asks to be let in.
 *
 * **The button is what opens the socket.** Nothing connects on load: the page
 * fetches the tile and status catalogues, decodes the tilesets, and then waits
 * here. A tab left open on the front door costs the world nothing — no actor to
 * simulate, no chunks to send, no body standing in the square somebody else is
 * trying to walk through.
 *
 * It is also where a login will go. Today the press mints the anonymous actor
 * cookie and that is all it does; when there are accounts, the account is asked
 * for here and the rest of the page does not change, because the rest of the
 * page already waits for this button.
 *
 * Set in a font that is already on the machine, like `./LoadingScreen` and for
 * the same reason: both of the page's own faces are downloads, and this is the
 * first thing anybody sees.
 */

/** @see LoadingScreen, which explains why the theme's face is not an option. */
const SYSTEM_MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

export function LoginScreen({
  onLogIn,
  pending,
  error,
}: {
  onLogIn: () => void;
  /** A press is being answered. The button says so rather than going away. */
  pending: boolean;
  /** Why the last press did not let anybody in, if it did not. */
  error: string | null;
}) {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-4 bg-ink p-6 text-center"
      style={{ fontFamily: SYSTEM_MONO }}
    >
      <button
        type="button"
        autoFocus
        disabled={pending}
        onClick={onLogIn}
        className="border-2 border-paper px-6 py-3 text-xs uppercase tracking-widest text-paper hover:bg-paper hover:text-ink disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-paper"
        style={{ fontFamily: SYSTEM_MONO }}
      >
        {pending ? "Logging in…" : "Log in"}
      </button>
      {error ? (
        // An alert rather than a status: it is the answer to a press, and a
        // press that appeared to do nothing is what this has to explain.
        <p className="max-w-sm text-xs leading-relaxed text-paper/70" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
