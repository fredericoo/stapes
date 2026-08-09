import { useCallback, useEffect, useRef, useState } from "react";
import { data, useLoaderData } from "react-router";
import type { Route } from "./+types/online";
import { AppShell } from "../components/AppShell";
import { FrameStatsReadout } from "../components/FrameStatsReadout";
import { GameViewport } from "../components/GameViewport";
import { bindKeyboard, HeldDirections } from "../game/heldDirections";
import { dataStore } from "../context";
import {
  DEFAULT_PLAY_MINUTES,
  formatClock,
  type MinutesOfDay,
} from "../lib/clock";
import type { Direction } from "../lib/types";
import { ACTOR_COOKIE, GAME_SOCKET_PATH } from "../net/protocol";
import { RemoteSession } from "../net/RemoteSession";
import type { FrameStats } from "../render/frameProfile";
import { GameRenderer } from "../render/GameRenderer";

/** A year. The id is a handle for an avatar, not an account. */
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const store = dataStore(context);
  const [tiles, tilesets] = await Promise.all([
    store.readTiles(),
    store.readTilesets(),
  ]);

  // Identity is a random id in an HttpOnly cookie: enough to tell two players
  // apart and give someone their avatar back on reload, and deliberately not a
  // login. HttpOnly because page scripts never need it — the socket handshake
  // sends it automatically, which is also how the server learns who is
  // connecting without trusting anything the client says.
  const existing = readCookie(request, ACTOR_COOKIE);
  const actorId = existing ?? crypto.randomUUID();

  const payload = { tiles, tilesets, socketPath: GAME_SOCKET_PATH };
  if (existing) return payload;

  return data(payload, {
    headers: {
      "Set-Cookie": `${ACTOR_COOKIE}=${actorId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}${
        new URL(request.url).protocol === "https:" ? "; Secure" : ""
      }`,
    },
  });
}

/** Backoff between reconnect attempts, capped. */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

type Status = "connecting" | "live" | "reconnecting";

export default function OnlinePage() {
  const { tiles, tilesets, socketPath } = useLoaderData<typeof loader>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GameRenderer | null>(null);
  const inputRef = useRef<HeldDirections | null>(null);
  const pressDirection = useCallback(
    (d: Direction) => inputRef.current?.press(d),
    [],
  );
  const releaseDirection = useCallback(
    (d: Direction) => inputRef.current?.release(d),
    [],
  );
  const [status, setStatus] = useState<Status>("connecting");
  // Placeholder until `hello` says what time it is out there. Nobody scrubs it:
  // the hour belongs to the world, not to whoever is looking at it.
  const [minutesOfDay, setMinutesOfDay] = useState<MinutesOfDay>(
    DEFAULT_PLAY_MINUTES,
  );
  const [stats, setStats] = useState<FrameStats | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let socket: WebSocket | null = null;
    let session: RemoteSession | null = null;
    let renderer: GameRenderer | null = null;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    // Reads `session` at call time, not at construction: a reconnect swaps the
    // session underneath while the same keys are still held.
    const input = new HeldDirections((i) => session?.setInput(i));
    inputRef.current = input;
    const unbindKeyboard = bindKeyboard(input);

    const teardownRenderer = () => {
      rendererRef.current = null;
      renderer?.dispose();
      renderer = null;
      session?.dispose();
      session = null;
    };

    const connect = () => {
      if (disposed) return;
      const url = new URL(socketPath, window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);

      const remote = new RemoteSession(socket, tiles);
      session = remote;

      // The renderer only starts once there is a world: it centres on the
      // viewer's own actor, and before `hello` there is nobody to centre on.
      remote.setOnReady(() => {
        if (disposed || renderer) return;
        attempt = 0;
        setStatus("live");
        renderer = new GameRenderer(canvas, remote, tilesets, tiles);
        // Shared world: everyone on screen is somebody, so everyone is named.
        renderer.setShowNames(true);
        renderer.setMinutesOfDay(remote.minutesOfDay());
        renderer.setOnClock(setMinutesOfDay);
        renderer.setOnStats(setStats);
        rendererRef.current = renderer;
        renderer.start();
        // The fresh session knows nothing about keys held across the reconnect.
        input.resend();
      });

      socket.addEventListener("close", () => {
        if (disposed) return;
        teardownRenderer();
        setStatus("reconnecting");
        setStats(null);
        const delay = Math.min(
          RECONNECT_MAX_MS,
          RECONNECT_BASE_MS * 2 ** attempt,
        );
        attempt += 1;
        retryTimer = setTimeout(connect, delay);
      });
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      unbindKeyboard();
      inputRef.current = null;
      teardownRenderer();
      socket?.close();
      setStats(null);
    };
  }, [tiles, tilesets, socketPath]);

  return (
    <AppShell
      trailing={
        <>
          <FrameStatsReadout stats={stats} />
          <span
            className="border-2 border-paper/40 px-1.5 py-0.5 text-xs uppercase text-paper"
            role="status"
          >
            {status}
          </span>
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase text-paper/70">Time</span>
            <span
              className="border-2 border-paper/40 px-1.5 py-0.5 text-xs tabular-nums text-paper"
              // Named rather than announced: the hour changes every second, so
              // a live region here would talk over everything else.
              aria-label={`Time of day, ${formatClock(minutesOfDay)}`}
            >
              {formatClock(minutesOfDay)}
            </span>
          </div>
        </>
      }
    >
      <GameViewport
        canvasRef={canvasRef}
        onDirectionPress={pressDirection}
        onDirectionRelease={releaseDirection}
        hint="Arrows / WASD move · Shift face · Option descend · Click an adjacent object to push or switch it"
      />
    </AppShell>
  );
}
