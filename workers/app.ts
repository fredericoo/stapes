import { createRequestHandler, RouterContextProvider } from "react-router";
import { cloudflareContext, dataStoreContext } from "../app/context";
import { createDataStore } from "../app/lib/storage.server";
import { ACTOR_COOKIE, GAME_SOCKET_PATH } from "../app/net/protocol";
import { gameServer } from "../app/net/gameServer.server";

export { GameServer } from "./GameServer";

const handleRequest = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

/** Read one cookie out of a request's Cookie header. */
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export default {
  fetch(request, env, ctx) {
    // WebSocket upgrades go straight to the world, ahead of the router: React
    // Router has no way to return a 101 with a socket attached, and the handful
    // of upgrade requests have no business running loaders.
    const url = new URL(request.url);
    if (url.pathname === GAME_SOCKET_PATH) {
      // Identity comes from the cookie the /online loader set, never from the
      // query string — a client naming its own actor could drive somebody
      // else's. The DO is addressed by cookie value, not by what was asked for.
      const actorId = readCookie(request, ACTOR_COOKIE);
      if (!actorId) {
        return new Response("Visit /online first", { status: 403 });
      }
      const forward = new URL(request.url);
      forward.searchParams.set("actor", actorId);
      return gameServer(env).fetch(new Request(forward, request));
    }

    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env, ctx });
    context.set(dataStoreContext, createDataStore(env, request));
    return handleRequest(request, context);
  },
} satisfies ExportedHandler<Env>;
