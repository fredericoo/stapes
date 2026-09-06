import {
  ACTOR_COOKIE,
  GAME_SOCKET_PATH,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_PARAM,
} from "../../app/net/protocol";
import type { TileDef, TilesetDef } from "../../app/lib/types";

/**
 * How a bot reaches the world.
 *
 * A bot is a WebSocket client and nothing more, so this is the only place that
 * knows a world has an address. It is an interface rather than a call to
 * `new WebSocket` inside the runner for one reason: the suite drives a real
 * `GameServer` through `server/testHarness`'s socket pair, which is the same
 * arrangement `server/index.ts` wires Elysia's handlers into. Everything the
 * runner does above this line is then exercised against the real world, with no
 * network and no port.
 */

/**
 * The part of a `WebSocket` a session actually touches.
 *
 * Written down rather than taken from the DOM lib because two of the three
 * implementations are not browsers — Bun's socket and the harness's pair — and a
 * structural type is what says which four members have to be there. See
 * `BotBody`'s constructor for the single cast this costs.
 */
export interface BotSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
}

/**
 * A socket that has not opened yet, and can be told when it does.
 *
 * `BotSocket` is what a session needs; this is what a *connection* needs on top
 * of it, and the two are separate because only this file ever waits for a socket
 * to open.
 */
interface OpeningBotSocket extends BotSocket {
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(
    type: "open" | "error",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
}

/**
 * Bun's `WebSocket`, which takes headers on its constructor.
 *
 * The DOM's does not, and `lib: ["DOM"]` is what this file typechecks against —
 * so the one place the two runtimes genuinely differ is named here, with the
 * reason beside it, rather than cast inline at the call.
 */
const BunWebSocket = WebSocket as unknown as new (
  url: string | URL,
  options: { headers: Record<string, string> },
) => OpeningBotSocket;

/** Where a bot gets a body from, and the catalogue it reads the world with. */
export interface BotTransport {
  /** The tile catalogue, fetched the way the client's loader fetches it. */
  bootstrap(): Promise<{ tiles: TileDef[]; tilesets: TilesetDef[] }>;
  /**
   * Open one connection, with an identity of its own.
   *
   * Resolves once the socket is open, because a session that starts sending
   * before then drops the frames on the floor — the same reason the page waits
   * for `hello` before it draws.
   */
  connect(): Promise<BotSocket>;
}

/**
 * A world at an origin, reached exactly as a browser reaches it.
 *
 * `GET /api/session` mints the `HttpOnly` actor cookie and the socket carries it
 * back, which is the whole of identity here — the server reads the cookie and
 * never anything the client says about itself. There is no admin route in and no
 * way for a bot to name its own actor, which is deliberate for this tracer: a
 * stable id is a protocol change, and this one makes none.
 */
export class HttpBotTransport implements BotTransport {
  constructor(private readonly origin: string) {}

  async bootstrap(): Promise<{ tiles: TileDef[]; tilesets: TilesetDef[] }> {
    const response = await fetch(new URL("/api/bootstrap", this.origin));
    if (!response.ok) {
      throw new Error(`Could not read the tile catalogue: ${response.status}`);
    }
    const body = (await response.json()) as {
      tiles: TileDef[];
      tilesets: TilesetDef[];
    };
    return { tiles: body.tiles, tilesets: body.tilesets };
  }

  async connect(): Promise<BotSocket> {
    const cookie = await this.mintActorCookie();
    const url = new URL(GAME_SOCKET_PATH, this.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set(PROTOCOL_VERSION_PARAM, String(PROTOCOL_VERSION));
    // The cookie the server minted rides the upgrade exactly as a tab's does,
    // which is what makes a bot a first-class client. A browser cannot send a
    // header on an upgrade and does not have to — it has a cookie jar — so this
    // is the one place a bot and a tab differ mechanically.
    const socket = new BunWebSocket(url, { headers: { cookie } });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("Could not open the world socket")),
        { once: true },
      );
    });
    return socket;
  }

  /**
   * Ask for an identity, and take the cookie it comes back with.
   *
   * `fetch` will not put a `Set-Cookie` into a jar for us — there is no jar in a
   * server process — so the header is read off the response and carried by hand.
   * Only the name and value travel: the attributes are instructions to a browser
   * about a cookie it is storing, and a socket upgrade sends neither.
   */
  private async mintActorCookie(): Promise<string> {
    const response = await fetch(new URL("/api/session", this.origin));
    if (!response.ok) {
      throw new Error(`Could not start a session: ${response.status}`);
    }
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";", 1)[0]!;
      if (pair.startsWith(`${ACTOR_COOKIE}=`)) return pair;
    }
    throw new Error("The world minted no actor cookie");
  }
}
