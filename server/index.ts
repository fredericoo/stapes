import { Elysia } from "elysia";
import {
  ACTOR_COOKIE,
  CLOSE_OUTDATED_CLIENT,
  GAME_SOCKET_PATH,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_PARAM,
} from "../app/net/protocol";
import { readConfig } from "./config";
import { createApi } from "./api";
import { ClientBundle } from "./clientBundle";
import { GameSocket } from "./sockets";
import { World } from "./world";

/**
 * The whole server: the world, the API, and the client bundle, on one origin.
 *
 * One origin is not a convenience. The actor cookie is `HttpOnly` and has to
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

const app = new Elysia()
  .use(createApi(world, bundle, config))
  .ws(GAME_SOCKET_PATH, {
    /**
     * Identity and version are settled before the socket is a socket.
     *
     * The id comes from the cookie, never from the query string — a client
     * naming its own actor could drive somebody else's body. The cookie is set
     * by `GET /api/session`, which is the only thing that mints one.
     */
    beforeHandle({ cookie, status }) {
      if (!cookie[ACTOR_COOKIE]?.value) return status(403, "Visit /online first");
      return undefined;
    },

    open(ws) {
      const actorId = String(ws.data.cookie[ACTOR_COOKIE]!.value);
      const socket = new GameSocket({
        send: (data) => void ws.send(data),
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
      const claimed = Number(
        new URL(ws.data.request.url).searchParams.get(PROTOCOL_VERSION_PARAM),
      );
      if (claimed !== PROTOCOL_VERSION) {
        socket.send(
          JSON.stringify({ type: "outdated", serverVersion: PROTOCOL_VERSION }),
        );
        socket.close(CLOSE_OUTDATED_CLIENT, "protocol version");
        return;
      }

      if (!world.accepting) {
        socket.close(1012, "draining");
        return;
      }

      void world.join(socket, actorId);
    },

    message(ws, message) {
      const socket = sockets.get(ws.raw as object);
      if (!socket) return;
      void world.message(
        socket,
        typeof message === "string" ? message : JSON.stringify(message),
      );
    },

    close(ws) {
      const socket = sockets.get(ws.raw as object);
      if (socket) void world.leave(socket);
    },
  })
  /**
   * Mint the actor cookie.
   *
   * Identity is a random id in an `HttpOnly` cookie — enough to give somebody
   * their avatar back on reload, and deliberately not a login. `HttpOnly` is
   * what makes the socket handshake trustworthy: the page cannot read it, so it
   * cannot claim to be anybody else.
   */
  .get("/api/session", ({ cookie }) => {
    const existing = cookie[ACTOR_COOKIE]?.value;
    if (!existing) {
      cookie[ACTOR_COOKIE]!.set({
        value: crypto.randomUUID(),
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: config.PUBLIC_ORIGIN.startsWith("https:"),
        maxAge: 60 * 60 * 24 * 365,
      });
    }
    return { protocolVersion: PROTOCOL_VERSION };
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
      bundle.respond(new URL(request.url).pathname) ??
      status(404, "No client bundle"),
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
