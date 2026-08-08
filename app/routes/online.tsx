import { useEffect, useRef, useState } from "react";
import { data, useLoaderData } from "react-router";
import type { Route } from "./+types/online";
import { AppShell } from "../components/AppShell";
import { FrameStatsReadout } from "../components/FrameStatsReadout";
import { dataStore } from "../context";
import {
  DEFAULT_PLAY_MINUTES,
  formatClock,
  MINUTES_PER_DAY,
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

const KEY_TO_DIR: Record<string, Direction> = {
  ArrowUp: "n",
  ArrowDown: "s",
  ArrowLeft: "w",
  ArrowRight: "e",
  KeyW: "n",
  KeyS: "s",
  KeyA: "w",
  KeyD: "e",
};

/** Backoff between reconnect attempts, capped. */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

type Status = "connecting" | "live" | "reconnecting";

export default function OnlinePage() {
  const { tiles, tilesets, socketPath } = useLoaderData<typeof loader>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GameRenderer | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [minutesOfDay, setMinutesOfDay] = useState<MinutesOfDay>(
    DEFAULT_PLAY_MINUTES,
  );
  const [stats, setStats] = useState<FrameStats | null>(null);
  const minutesRef = useRef(minutesOfDay);
  minutesRef.current = minutesOfDay;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let socket: WebSocket | null = null;
    let session: RemoteSession | null = null;
    let renderer: GameRenderer | null = null;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const held: Direction[] = [];
    let faceOnly = false;
    let preferDescend = false;

    const syncInput = () => {
      session?.setInput({ directions: [...held], faceOnly, preferDescend });
    };

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
        renderer.setMinutesOfDay(minutesRef.current);
        renderer.setOnClock(setMinutesOfDay);
        renderer.setOnStats(setStats);
        rendererRef.current = renderer;
        renderer.start();
        syncInput();
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

    const syncModifiers = (e: KeyboardEvent) => {
      faceOnly = e.shiftKey;
      preferDescend = e.altKey;
      syncInput();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      syncModifiers(e);
      const dir = KEY_TO_DIR[e.code];
      if (!dir) return;
      e.preventDefault();
      if (e.repeat) return;
      const idx = held.indexOf(dir);
      if (idx >= 0) held.splice(idx, 1);
      held.push(dir);
      syncInput();
    };

    const onKeyUp = (e: KeyboardEvent) => {
      syncModifiers(e);
      const dir = KEY_TO_DIR[e.code];
      if (dir) {
        e.preventDefault();
        const idx = held.indexOf(dir);
        if (idx >= 0) held.splice(idx, 1);
      }
      syncInput();
    };

    // Losing the window drops every key: without this a held direction sticks
    // on the server and the avatar walks off on its own.
    const onBlur = () => {
      held.length = 0;
      faceOnly = false;
      preferDescend = false;
      syncInput();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      teardownRenderer();
      socket?.close();
      setStats(null);
    };
  }, [tiles, tilesets, socketPath]);

  const scrubTime = (m: MinutesOfDay) => {
    setMinutesOfDay(m);
    rendererRef.current?.setMinutesOfDay(m);
  };

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
            <input
              type="range"
              min={0}
              max={MINUTES_PER_DAY - 1}
              step={1}
              value={Math.floor(minutesOfDay)}
              onChange={(e) => scrubTime(Number(e.target.value))}
              aria-label="Time of day"
              aria-valuetext={formatClock(minutesOfDay)}
              className="hard-slider w-36"
            />
            <span className="border-2 border-paper/40 px-1.5 py-0.5 text-xs tabular-nums text-paper">
              {formatClock(minutesOfDay)}
            </span>
          </div>
        </>
      }
    >
      <div className="relative h-full w-full bg-ink">
        <canvas
          ref={canvasRef}
          className="block h-full w-full touch-none"
          style={{ imageRendering: "pixelated" }}
        />
        <div className="pointer-events-none absolute bottom-3 left-3 text-xs text-paper/70">
          Arrows / WASD move · Shift face · Option descend · Click an adjacent
          object to push or switch it
        </div>
      </div>
    </AppShell>
  );
}
