import type { WorldLink } from "../net/link";
import { PROTOCOL_VERSION } from "../net/protocol";
import { LocalSocket } from "./LocalSocket";
import type { FromWorld, ToWorld } from "./workerProtocol";

/**
 * A world running in this tab, over a worker port.
 *
 * The other half of `../net/link`: same page, same protocol, same frames — the
 * only difference is that the far end is a thread rather than a machine. See
 * `./world.worker.ts`, which is the server, and `docs/notes.md`'s
 * "`/admin/play` runs the server in the tab".
 *
 * **No network and no account.** That is what it is for: `/admin/play` is the
 * path that goes on working while `/` grows a login, so hand-testing a change
 * to the world does not mean hand-testing the way in to it first.
 */
export const localLink: WorldLink = (() => {
  let worker: Worker | null = null;
  /** Connections made over the life of this link, which is what numbers them. */
  let opened = 0;
  const connections = new Map<number, LocalSocket>();

  const ensureWorker = (): Worker => {
    if (worker) return worker;
    worker = new Worker(new URL("./world.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.addEventListener("message", (event: MessageEvent) => {
      const message = event.data as FromWorld;
      const socket = connections.get(message.id);
      if (!socket) return;
      if (message.kind === "frame") return socket.deliver(message.data);
      connections.delete(message.id);
      socket.ended(message.code, message.reason);
    });
    return worker;
  };

  return {
    id: "local",
    enter() {
      // Minted here for the same reason `GET /api/session` mints the cookie
      // there: identity is settled before anything connects, and it outlives
      // the connection. `localStorage` rather than a cookie because there is no
      // server to make it `HttpOnly` for — the page cannot lie to a world it is
      // running itself.
      actorId();
      return Promise.resolve();
    },

    open() {
      const id = ++opened;
      const port = ensureWorker();
      const socket = new LocalSocket((message) => port.postMessage(message), id);
      connections.set(id, socket);
      port.postMessage({
        kind: "open",
        id,
        actorId: actorId(),
        protocolVersion: PROTOCOL_VERSION,
      } satisfies ToWorld);
      return socket;
    },

    reset() {
      // Nothing to wait for and nothing to answer: `resetWorld` sends every
      // connected socket a fresh `hello`, which arrives as an ordinary frame
      // and redraws the page into the new world.
      ensureWorker().postMessage({ kind: "reset" } satisfies ToWorld);
      return Promise.resolve();
    },
  };
})();

/** Where this tab's identity is kept. The local stand-in for the actor cookie. */
const ACTOR_STORAGE_KEY = "stapes:local-actor";

/**
 * Who this tab is, minting one if it is new here.
 *
 * Survives a reload, because a body you come back to is the whole of what
 * identity buys a player. Cleared by clearing site data, which also clears the
 * world it was standing in — the two belong together.
 */
function actorId(): string {
  try {
    const existing = localStorage.getItem(ACTOR_STORAGE_KEY);
    if (existing) return existing;
    const minted = crypto.randomUUID();
    localStorage.setItem(ACTOR_STORAGE_KEY, minted);
    return minted;
  } catch {
    // A private window with storage blocked. A fresh body every load is worse
    // than a durable one and much better than a page that will not open.
    return crypto.randomUUID();
  }
}
