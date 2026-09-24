import { Elysia } from "elysia";
import {
  CHARACTER_PARAM,
  CLOSE_MAINTENANCE,
  CLOSE_OUTDATED_CLIENT,
  CLOSE_SIGNED_OUT,
  GAME_SOCKET_PATH,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_PARAM,
} from "../app/net/protocol";
import { viewerOf } from "./auth";
import { readConfig } from "./config";
import { createApi } from "./api";
import { ClientBundle } from "./clientBundle";
import { GameSocket, PER_MESSAGE_DEFLATE } from "./sockets";
import { World } from "./world";

/**
 * The whole server: the world, the API, and the client bundle, on one origin.
 *
 * One origin is not a convenience. The session cookie is `HttpOnly` and has to
 * ride the socket upgrade; splitting the client onto its own hostname would
 * mean `SameSite=None`, a CORS policy, and credentialed fetches — three knobs
 * whose misconfiguration breaks identity silently. Serving the client from here
 * makes it first-party by construction, and costs nothing, because the client
 * is only files.
 */
const config = readConfig();
const world = await World.open(config);
const bundle = new ClientBundle(config);

// Come back up on whatever was being served before this process replaced the
// last one. Builds are on the mounted volume, so a server deploy does not touch
// them — see `ClientBundle.restore`.
await bundle.restore(config.CLIENT_BUILD_ID);

/** Actor id per connection, for the close handler after the socket is gone. */
const sockets = new WeakMap<object, GameSocket>();

/**
 * The shortest frame worth compressing, in characters.
 *
 * Deflate costs about 10µs a frame before it has read a byte, on the thread
 * that runs the tick, and each socket's copy is compressed separately. Under
 * this length that buys a few hundred bytes at most — a keepalive, a refused
 * step, a patch with nothing in it — so those go as they are. Patches of a
 * few kilobytes and up are the bulk of the traffic, and shrink about tenfold.
 */
const COMPRESS_MIN_LENGTH = 512;

const app = new Elysia({
  /**
   * Offer compression when a socket opens. The wire is JSON of tile stacks,
   * which is the most repetitive text there is: a `hello` goes from about
   * 2.5MB to under 180KB. The browser side accepts without being asked.
   *
   * **This only agrees to compress; it does not compress anything.** Bun
   * deflates a frame only when `send` is passed `true` — see the transport
   * below. Until that was added, every frame went out raw, and a hundred
   * players cost 17MB/s.
   *
   * Not `true`, because Safari's frames need a decompressor per connection:
   * see {@link PER_MESSAGE_DEFLATE}.
   */
  websocket: { perMessageDeflate: PER_MESSAGE_DEFLATE },
})
  .use(createApi(world, bundle, config))
  .ws(GAME_SOCKET_PATH, {
    open(ws) {
      const socket = new GameSocket({
        send: (data) => void ws.send(data, data.length >= COMPRESS_MIN_LENGTH),
        close: (code, reason) => void ws.close(code, reason),
        get closed() {
          return ws.readyState !== 1;
        },
      });
      sockets.set(ws.raw as object, socket);

      // A stale tab is told so and closed, rather than refused at the upgrade.
      // A browser reports a rejected upgrade to the page as an indistinguishable
      // failure, so a client refused that way cannot tell "reload me" from "the
      // server is down", and sits in its backoff instead of reloading.
      const url = new URL(ws.data.request.url);
      const claimed = Number(url.searchParams.get(PROTOCOL_VERSION_PARAM));
      if (claimed !== PROTOCOL_VERSION) {
        socket.send(JSON.stringify({ type: "outdated", serverVersion: PROTOCOL_VERSION }));
        socket.close(CLOSE_OUTDATED_CLIENT, "protocol version");
        return;
      }

      if (!world.accepting) {
        socket.close(1012, "draining");
        return;
      }

      /**
       * Who this socket is, settled after the upgrade rather than before it.
       *
       * **The account comes from the cookie and the body comes from the query
       * string, and only the first of those is trusted.** The cookie is signed
       * and `HttpOnly`, so the page cannot claim to be another account; the
       * character id is a plain parameter, so it is looked up *against that
       * account* and a character belonging to anybody else is simply not
       * found. That is the whole of the ownership rule — "two accounts cannot
       * share a character" is this query returning no row.
       *
       * Refused with a close rather than a 403 at the upgrade, on exactly the
       * terms the version check above is: a rejected upgrade reaches the page
       * as an indistinguishable failure, so a signed-out tab would sit in its
       * reconnect backoff instead of putting the sign-in screen back up.
       */
      void (async () => {
        const viewer = await viewerOf(world.auth, ws.data.request.headers);
        if (!viewer) {
          socket.close(CLOSE_SIGNED_OUT, "not signed in");
          return;
        }
        const wanted = url.searchParams.get(CHARACTER_PARAM);
        const character = wanted ? await world.characters.ownedBy(wanted, viewer.id) : null;
        if (!character) {
          socket.close(CLOSE_SIGNED_OUT, "not your character");
          return;
        }
        // Closed while we were asking — a tab shut in the half-millisecond the
        // two lookups took. Joining would seat a body for a connection that is
        // already gone, and nothing would take it off the board until the next
        // load reaped it.
        if (socket.closed) return;
        // Asked after the account rather than before it, because an
        // administrator is let in: the point of closing the world is usually
        // that somebody wants to look at it without players in it. @see
        // `./maintenance`
        const admin = viewer.role === "ADMIN";
        if (world.maintenance.state && !admin) {
          socket.close(CLOSE_MAINTENANCE, "maintenance");
          return;
        }
        // The role rides with the seating, from the same viewer the character
        // was looked up against. It is what lets the world tell an
        // administrator's `/mastery` from a fabricated frame — see
        // `GameServer`'s `Attachment`, which is where it is kept and why it is
        // kept there rather than on the body.
        await world.join(socket, character.id, { admin });
      })();
    },

    message(ws, message) {
      const socket = sockets.get(ws.raw as object);
      if (!socket) return;
      void world.message(socket, typeof message === "string" ? message : JSON.stringify(message));
    },

    close(ws) {
      const socket = sockets.get(ws.raw as object);
      if (socket) void world.leave(socket);
    },
  })
  /**
   * Everything else is the client.
   *
   * Last, so it cannot shadow the API or the socket. Returns 404 rather than
   * falling through when no bundle is loaded, which is the development case:
   * Vite serves the client there and proxies only `/api` and the socket here.
   */
  .get(
    "/*",
    ({ request, status }) =>
      bundle.respond(new URL(request.url).pathname) ?? status(404, "No client bundle"),
  )
  .onError(({ code, error }) => {
    if (code === "NOT_FOUND") return new Response("Not found", { status: 404 });
    console.error("[server]", error);
    return new Response("Internal error", { status: 500 });
  });

const server = app.listen(config.PORT);
const port = server.server?.port ?? config.PORT;
console.log(`[server] listening on ${port} (protocol v${PROTOCOL_VERSION})`);

/**
 * Stop cleanly on a deploy.
 *
 * `bun run --watch` sends this before each restart too, which means the drain
 * is exercised on every server edit in development rather than only in
 * production — the most safety-critical path in the system, run a hundred times
 * a day by people not thinking about it.
 *
 * `once`, because a second signal while draining should not start a second
 * drain; and the drain itself is idempotent for the same reason.
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.log(`[server] ${signal} — draining`);
    void world
      .drain()
      .catch((error: unknown) => console.error("[server] drain failed", error))
      .finally(() => {
        void server.stop();
        process.exit(0);
      });
  });
}

export type { Api } from "./api";
