import { useCallback, useEffect, useRef, useState } from "react";
import { data, useLoaderData } from "react-router";
import type { Route } from "./+types/online";
import { AppShell } from "../components/AppShell";
import { FrameStatsReadout } from "../components/FrameStatsReadout";
import { GameViewport } from "../components/GameViewport";
import { LightingToggle } from "../components/LightingToggle";
import { LoadingScreen } from "../components/LoadingScreen";
import { bindKeyboard, HeldDirections } from "../game/heldDirections";
import { usePlayModes } from "../components/usePlayModes";
import {
  applyInteraction,
  type InteractionOption,
} from "../game/interactionOptions";
import { dataStore } from "../context";
import { useGameAssets } from "../lib/gameAssets";
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
  // No canvas until the assets are here, so no socket either: the connection is
  // opened by the same effect the renderer is built in. @see ../lib/gameAssets
  const assetsReady = useGameAssets(tilesets);
  // And the loading screen stays up past that, until there is a world on the
  // canvas. Here that covers a third wait as well as the renderer's textures:
  // the renderer is not even built until `hello` arrives, since there is nobody
  // to centre the camera on before it.
  const [painted, setPainted] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<GameRenderer | null>(null);
  const inputRef = useRef<HeldDirections | null>(null);
  const sessionRef = useRef<RemoteSession | null>(null);
  const pressDirection = useCallback(
    (d: Direction) => inputRef.current?.press(d),
    [],
  );
  const releaseDirection = useCallback(
    (d: Direction) => inputRef.current?.release(d),
    [],
  );
  // Through a ref for the same reason the directions are: a reconnect swaps the
  // session underneath while the page keeps the callback it was handed.
  const say = useCallback((text: string) => sessionRef.current?.say(text), []);
  const act = useCallback(
    (option: InteractionOption) => applyInteraction(sessionRef.current, option),
    [],
  );
  // Straight at the renderer rather than through state: an outline is a frame's
  // business, and routing it through React would re-render the page on every
  // row the cursor crosses.
  const hoverInteraction = useCallback(
    (optionId: string | null) => rendererRef.current?.setListHover(optionId),
    [],
  );
  // Focus is what makes held keys unreachable, so it is what has to drop them.
  const noteTyping = useCallback((typing: boolean) => {
    if (typing) inputRef.current?.clear();
  }, []);
  const [status, setStatus] = useState<Status>("connecting");
  // Placeholder until `hello` says what time it is out there. Nobody scrubs it:
  // the hour belongs to the world, not to whoever is looking at it.
  const [minutesOfDay, setMinutesOfDay] = useState<MinutesOfDay>(
    DEFAULT_PLAY_MINUTES,
  );
  const [stats, setStats] = useState<FrameStats | null>(null);
  // Null while there is no connection to have heard it from, which is not the
  // same as an empty world — an unknown headcount reads as a dash rather than
  // claiming nobody is here.
  const [players, setPlayers] = useState<number | null>(null);
  const [interactions, setInteractions] = useState<InteractionOption[]>([]);
  const [lightingEnabled, setLightingEnabled] = useState(true);
  const { looking, attacking, setLookLatched, setAttacking } = usePlayModes();
  // Same reason as the lighting ref below: a reconnect builds a fresh renderer,
  // and it has to come up in whatever mode the player is already in.
  const lookingRef = useRef(looking);
  lookingRef.current = looking;
  // And a fresh *session*, which is where attack mode lives — the server seats a
  // body that is not swinging at anybody, so the stance has to be said again on
  // every connection. See `RemoteSession`'s handling of `hello` for the other
  // half of this, when the world itself is replaced under a live socket.
  const attackingRef = useRef(attacking);
  attackingRef.current = attacking;
  // Through a ref because the renderer is built on `hello`, and a reconnect
  // builds another one — both must come up at whatever the toggle says now.
  const lightingRef = useRef(lightingEnabled);
  lightingRef.current = lightingEnabled;

  useEffect(() => {
    rendererRef.current?.setLightingEnabled(lightingEnabled);
  }, [lightingEnabled]);

  useEffect(() => {
    rendererRef.current?.setLookMode(looking);
  }, [looking]);

  // At the session rather than the renderer: the server is what swings, and the
  // outline colour comes back in the snapshot rather than being held twice.
  useEffect(() => {
    sessionRef.current?.setAttackMode(attacking);
  }, [attacking]);

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
      sessionRef.current = null;
      // Emptied with the session that answered for it: a list of things to
      // shove, left on screen across a reconnect, offers a board nobody is
      // simulating any more.
      setInteractions([]);
      // And the loading screen comes back for the same reason: the next
      // renderer starts with an empty canvas, and a reconnect can take a while.
      setPainted(false);
    };

    const connect = () => {
      if (disposed) return;
      const url = new URL(socketPath, window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);

      const remote = new RemoteSession(socket, tiles);
      session = remote;
      sessionRef.current = remote;
      // Before the socket has said anything, so the count in the first `hello`
      // is not missed — it lands well ahead of the renderer this page otherwise
      // waits for.
      remote.setOnPlayers(setPlayers);

      // The renderer only starts once there is a world: it centres on the
      // viewer's own actor, and before `hello` there is nobody to centre on.
      remote.setOnReady(() => {
        if (disposed || renderer) return;
        attempt = 0;
        setStatus("live");
        renderer = new GameRenderer(
          canvas,
          remote,
          tilesets,
          tiles,
          labelRef.current,
        );
        renderer.setLightingEnabled(lightingRef.current);
        renderer.setLookMode(lookingRef.current);
        renderer.setMinutesOfDay(remote.minutesOfDay());
        renderer.setOnClock(setMinutesOfDay);
        renderer.setOnStats(setStats);
        renderer.setOnInteractions(setInteractions);
        renderer.setOnFirstFrame(() => setPainted(true));
        rendererRef.current = renderer;
        renderer.start();
        // The fresh session knows nothing about keys held across the reconnect,
        // nor about a sword that was already drawn. Both are said again here
        // rather than when the socket was created, because until `hello` there
        // is nothing at the other end listening.
        input.resend();
        remote.setAttackMode(attackingRef.current);
      });

      socket.addEventListener("close", () => {
        if (disposed) return;
        teardownRenderer();
        setStatus("reconnecting");
        setStats(null);
        setPlayers(null);
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
      setPlayers(null);
    };
    // `assetsReady` is in here for the canvas rather than for itself — the
    // element only exists once it is true. It also holds the socket back until
    // then, which is right: a world being simulated for somebody who cannot see
    // it yet is a walk they never asked for.
  }, [tiles, tilesets, socketPath, assetsReady]);

  // Held in a variable because it rides in one of two slots. A world that is
  // simply connected is not news and folds away with everything else on a
  // phone; a world that is *not* has to be on screen, because it is the only
  // thing explaining why nothing is moving — and a player who has to open a
  // menu to find that out has already concluded the game is broken.
  const statusChip = (
    <span
      className="border-2 border-paper/40 px-1.5 py-0.5 text-xs uppercase text-paper"
      role="status"
    >
      {status}
    </span>
  );

  return (
    <AppShell
      menuExtras={
        <>
          <div
            className="flex items-center gap-2"
            // Announced, unlike the clock: the headcount changes only when
            // somebody actually arrives or leaves, which is worth hearing.
            role="status"
          >
            <span className="text-xs uppercase text-paper/70">Players</span>
            <span className="border-2 border-paper/40 px-1.5 py-0.5 text-xs tabular-nums text-paper">
              {players ?? "—"}
            </span>
          </div>
          <FrameStatsReadout stats={stats} />
          {status === "live" ? statusChip : null}
          <LightingToggle
            enabled={lightingEnabled}
            onChange={setLightingEnabled}
          />
        </>
      }
      trailing={
        <>
          {status === "live" ? null : statusChip}
          <span
            className="border-2 border-paper/40 px-1.5 py-0.5 text-xs tabular-nums text-paper"
            // Named rather than announced: the hour changes every second, so
            // a live region here would talk over everything else.
            aria-label={`Time of day, ${formatClock(minutesOfDay)}`}
          >
            {formatClock(minutesOfDay)}
          </span>
        </>
      }
    >
      {/* The screen sits over the game rather than instead of it, because it
          outlasts the moment the canvas mounts — see `painted`. */}
      <div className="relative h-full w-full">
        {assetsReady ? (
          <GameViewport
            canvasRef={canvasRef}
            labelRef={labelRef}
            onDirectionPress={pressDirection}
            onDirectionRelease={releaseDirection}
            onSay={say}
            onTypingChange={noteTyping}
            looking={looking}
            onLookingChange={setLookLatched}
            attacking={attacking}
            onAttackingChange={setAttacking}
            interactions={interactions}
            onInteract={act}
            onHoverInteraction={hoverInteraction}
            tiles={tiles}
            tilesets={tilesets}
          />
        ) : null}
        {painted ? null : <LoadingScreen />}
      </div>
    </AppShell>
  );
}
