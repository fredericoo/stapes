import { PROTOCOL_VERSION } from "../net/protocol";

/**
 * What stands over the game when this tab and the world cannot talk to
 * each other.
 *
 * The server refuses a socket whose protocol version is not its own — see
 * `PROTOCOL_VERSION` — and until this existed the refusal had no picture at all.
 * The page reloaded once, hit the same wall, and then sat behind `LoadingScreen`
 * saying "Loading…" for ever, with the word OUTDATED in a chip beside the clock
 * that nobody reads while they are waiting for a world to appear. A wait that
 * will never end has to say so.
 *
 * **There are two of these and they need opposite advice**, which is the whole
 * reason the version is carried out of `RemoteSession` rather than the close
 * code alone being acted on:
 *
 * - The **tab is behind** — the usual case, an open tab during a deploy.
 *   Reloading fetches the new bundle and fixes it, and the page has already
 *   tried once automatically; the button is for the case where a cached bundle
 *   came back the same age it went in.
 * - The **server is behind**, which happens on a preview deployment built from
 *   an older commit than the client bundle it is serving. Reloading is a wait
 *   that never ends, so the screen says so rather than offering a button that
 *   cannot work.
 *
 * Typeset in the system's own monospace, on the same terms `./LoadingScreen` is:
 * it stands in the same slot, at the same moment, and both of the page's faces
 * are downloads.
 */

/**
 * The system's own monospace. @see LoadingScreen, which explains why the theme's
 * face is not an option here.
 */
const SYSTEM_MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

export function OutdatedScreen({
  serverVersion,
}: {
  /**
   * What the server said it speaks, or null if it closed without saying.
   *
   * Null is treated as the tab being behind, which is the commoner case by far
   * and the one where the advice is at least actionable.
   */
  serverVersion: number | null;
}) {
  const serverBehind =
    serverVersion !== null && serverVersion < PROTOCOL_VERSION;

  return (
    <div
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-ink p-6 text-center"
      // An alert rather than a status: it arrives instead of the world the
      // player was waiting for, and it is the end of the wait rather than a
      // stage in it.
      role="alert"
      style={{ fontFamily: SYSTEM_MONO }}
    >
      <span className="text-xs uppercase tracking-widest text-paper">
        {serverBehind ? "The server is out of date" : "This tab is out of date"}
      </span>
      <p className="max-w-sm text-xs leading-relaxed text-paper/70">
        {serverBehind
          ? `This page speaks version ${PROTOCOL_VERSION} and the server speaks ${serverVersion}, so it is the server that has to catch up. Reloading will not help.`
          : `The world has moved on to a newer version of the game. Reloading did not pick it up, which usually means a cached copy of this page.`}
      </p>
      {serverBehind ? null : (
        // Not the `ui` Button: this screen is up before the page's own font has
        // arrived, and a control set in a face that is still downloading is a
        // control nobody can read. A plain reload rather than a hard one,
        // because there is no such thing in the platform — a person who is
        // still stuck after this needs their browser's own empty-cache reload.
        <button
          type="button"
          autoFocus
          onClick={() => window.location.reload()}
          className="border-2 border-paper px-3 py-1.5 text-xs uppercase tracking-widest text-paper hover:bg-paper hover:text-ink"
          style={{ fontFamily: SYSTEM_MONO }}
        >
          Reload
        </button>
      )}
    </div>
  );
}
