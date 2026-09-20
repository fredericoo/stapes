import { startSession } from "../lib/api";
import {
  GAME_SOCKET_PATH,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_PARAM,
} from "./protocol";
import type { ClientSocket } from "./socket";

/**
 * How a page gets to a world.
 *
 * The one thing `/` and `/admin/play` do differently. Everything else about
 * them — the login door, the reconnect, the frames, the prediction, the
 * renderer, the death screen — is one page against one protocol, because a
 * second implementation of any of it would be a second thing to keep true, and
 * the whole reason `/admin/play` exists is to be the same thing.
 *
 * Two of these exist: {@link onlineLink} here, and `../local/link`'s
 * `localLink`, which opens a world in a worker in this tab.
 */
export interface WorldLink {
  /**
   * Which world this is, for the handful of things a tab remembers about being
   * in one. Logging in to the shared world is not logging in to the one running
   * in this tab, and a page that shared the key would come up already inside a
   * world nobody had asked to be in. @see ../components/WorldPage
   */
  readonly id: string;
  /**
   * Settle who is connecting, before anything connects.
   *
   * The Log in press, and the only step with a visible failure of its own: a
   * page that cannot mint an identity has nothing to be in the world with, so
   * the door stays up and says so. @see ../components/LoginScreen
   */
  enter(): Promise<void>;
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
 * Identity is the `HttpOnly` cookie `GET /api/session` mints, and it is never
 * named here: the handshake carries it because the browser attaches it to the
 * upgrade, so a page cannot claim to be somebody else by saying so.
 */
export const onlineLink: WorldLink = {
  id: "online",
  async enter() {
    await startSession();
  },
  open() {
    const url = new URL(GAME_SOCKET_PATH, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set(PROTOCOL_VERSION_PARAM, String(PROTOCOL_VERSION));
    return new WebSocket(url);
  },
};
