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

const config = readConfig();
const world = await World.open(config);
const bundle = new ClientBundle(config);

await bundle.restore(config.CLIENT_BUILD_ID);

const sockets = new WeakMap<object, GameSocket>();

const COMPRESS_MIN_LENGTH = 512;

const app = new Elysia({
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
        if (socket.closed) return;
        const admin = viewer.role === "ADMIN";
        if (world.maintenance.state && !admin) {
          socket.close(CLOSE_MAINTENANCE, "maintenance");
          return;
        }
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
