import { rememberedCharacterId } from "../lib/playing";
import {
  CHARACTER_PARAM,
  GAME_SOCKET_PATH,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_PARAM,
} from "./protocol";
import type { ClientSocket } from "./socket";

/**
 * How a page gets to a world.
 *
 * The one thing `/` and `/admin/play` do differently. Everything else about
 * them — the reconnect, the frames, the prediction, the renderer, the death
 * screen — is one page against one protocol, because a second implementation of
 * any of it would be a second thing to keep true, and the whole reason
 * `/admin/play` exists is to be the same thing.
 *
 * Two of these exist: {@link onlineLink} here, and `../local/link`'s
 * `localLink`, which opens a world in a worker in this tab.
 *
 * **Identity is settled before a page gets here**, and that is why there is no
 * `enter` on this interface any more. The shared world is entered as a
 * character, chosen at `/characters` — a route, with its own redirect when
 * there is no account or no character behind it — and the local world is
 * entered by being opened at all. There is nothing left for a link to ask for.
 */
export interface WorldLink {
  /**
   * Which world this is, for the handful of things a tab remembers about being
   * in one. What a tab is doing in the shared world is not what it is doing in
   * the one running in this tab, and a page that shared the key would carry one
   * world's state into the other. @see ../components/WorldPage
   */
  readonly id: string;
  /** Begin a connection. Called again by every reconnect. */
  open(): ClientSocket;
  /**
   * Destroy the world and start again on the authored map.
   *
   * Absent online, where the world is everybody's and the button belongs behind
   * `POST /api/reset` and its secret. Present locally, where it is yours.
   */
  reset?(): Promise<void>;
}

/**
 * **A link is a module constant, not something a page builds.**
 *
 * It outlives every connection made over it, and it has to outlive the
 * component as well: a page that owned its link would tie a world's lifetime to
 * React's — to a remount, to a double-invoked effect, to the order two cleanups
 * happen to run in — and the local link *holds a worker*. Reaching the map
 * editor and coming back would be a world thrown away and read in again, if it
 * were thrown away at the right moment at all.
 *
 * So there is one of each, per tab, made the first time it is needed and let go
 * of when the tab goes. What a page does own is the connection, which it closes
 * on the way out exactly as it always has — and a world with no connections
 * goes to rest on its own.
 */

/**
 * The shared world, over a socket.
 *
 * **The account comes from the cookie and the body comes from the URL, and only
 * the first of those is trusted.** The signed `HttpOnly` session cookie is
 * never named here — the browser attaches it to the upgrade, so a page cannot
 * claim to be somebody else by saying so. The character id *is* named, because
 * only this tab knows which of the account's three it is playing; the server
 * looks it up against that session and refuses a character belonging to anybody
 * else. @see `server/index.ts`
 *
 * Read at open time rather than held, so a reconnect names whatever this tab is
 * playing now. Null is possible only for a tab that reached here without going
 * through `/characters`, which its loader makes impossible — and the server
 * closes such a socket rather than seating a body.
 */
export const onlineLink: WorldLink = {
  id: "online",
  open() {
    const url = new URL(GAME_SOCKET_PATH, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set(PROTOCOL_VERSION_PARAM, String(PROTOCOL_VERSION));
    const character = rememberedCharacterId();
    if (character) url.searchParams.set(CHARACTER_PARAM, character);
    return new WebSocket(url);
  },
};
