import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { useLoaderData } from "react-router";
import { AppShell } from "../components/AppShell";
import { DeathScreen } from "../components/DeathScreen";
import { FrameStatsReadout } from "../components/FrameStatsReadout";
import { GameViewport } from "../components/GameViewport";
import { InkDocument } from "../components/InkDocument";
import { LightingToggle } from "../components/LightingToggle";
import { LoadingScreen } from "../components/LoadingScreen";
import { WorldClock } from "../components/WorldClock";
import { type Equipment, emptyEquipment } from "../game/equipment";
import type { Conversation, TalkAction } from "../game/dialogRuntime";
import type { MasteryXp } from "../lib/mastery";
import { bindCastKeys, bindKeyboard, HeldDirections } from "../game/heldDirections";
import { usePlayModes } from "../components/usePlayModes";
import {
  applyInteraction,
  type InteractionOption,
} from "../game/interactionOptions";
import { activeStatuses, statusesById } from "../lib/status";
import { useGameAssets } from "../lib/gameAssets";
import { DEFAULT_PLAY_MINUTES, type MinutesOfDay } from "../lib/clock";
import type { ObjectRef } from "../game/affordances";
import type { OpenedContainer, SlotRef } from "../game/itemMoves";
import type { CastSquare, SpellButton } from "../game/casting";
import type { Direction } from "../lib/types";
import {
  CLOSE_OUTDATED_CLIENT,
  GAME_SOCKET_PATH,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_PARAM,
} from "../net/protocol";
import { fetchBootstrap, startSession } from "../lib/api";
import type { Vitals } from "../game/GameSession";
import { RemoteSession } from "../net/RemoteSession";
import type { FrameStats } from "../render/frameProfile";
import { GameRenderer } from "../render/GameRenderer";

export async function clientLoader() {
  // The session call is what mints the `HttpOnly` actor cookie, and it has to
  // land before the socket opens: identity comes from that cookie and never
  // from anything this page could say about itself.
  const [{ protocolVersion }, bootstrap] = await Promise.all([
    startSession(),
    fetchBootstrap(),
  ]);
  return { ...bootstrap, socketPath: GAME_SOCKET_PATH, protocolVersion };
}

/** Backoff between reconnect attempts, capped. */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

/**
 * How soon to come back after an announced restart, and how much to smear it.
 *
 * A deploy closes every socket in the same instant. Without the jitter they all
 * return in the same instant too, and the fresh process pays for its cold load
 * once per player simultaneously.
 */
const RESTART_RECONNECT_MS = 250;
const RESTART_RECONNECT_JITTER_MS = 750;

/** Guards the reload-on-stale-client path against looping. */
const RELOADED_FOR_VERSION = "stapes:reloaded-for-version";

type Status = "connecting" | "live" | "reconnecting" | "restarting" | "outdated";

export default function OnlinePage() {
  const { tiles, tilesets, statuses, socketPath } =
    useLoaderData<typeof clientLoader>();
  // Both ends load the same catalogue: the server to run the effects, this side
  // to name and draw them. Only ids and clocks travel, which is what keeps a
  // status running for an hour to a handful of small messages.
  const statusDefs = useMemo(() => statusesById(statuses), [statuses]);
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
  const talk = useCallback(
    (action: TalkAction) => sessionRef.current?.talk(action),
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
  /**
   * Whether this player has been killed and has not asked for a body back.
   *
   * Page state rather than the renderer's, unlike the vitals beside it, because
   * what it changes is the page: everything under the death screen goes `inert`
   * for as long as it is true, and that is a React attribute on a real element
   * rather than something a frame can draw.
   */
  const [dead, setDead] = useState(false);
  const rebirth = useCallback(() => sessionRef.current?.rebirth(), []);
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
  const [equipment, setEquipment] = useState<Equipment>(emptyEquipment);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  /** What this player has learnt — theirs alone, beside the kit. */
  const [masteryXp, setMasteryXp] = useState<MasteryXp>({});
  /** What this player's body can take, and its ⭐. */
  const [vitals, setVitals] = useState<Vitals>({ hp: null, maxHp: null, rating: null, statuses: [] });
  const [openedContainer, setOpenedContainer] =
    useState<OpenedContainer | null>(null);
  /**
   * The stones this player could press, as the render loop last worked them out.
   *
   * Worked out on this side from the same pure rules the server honours a cast
   * with — see `../game/casting` — so a button dims the instant somebody walks
   * out of range rather than a round trip later. The cooldowns in it are the
   * server's figures, not a clock of this side's own.
   */
  const [spells, setSpells] = useState<SpellButton[]>([]);
  // Straight at the renderer, like the hover outline: which box is open is a
  // frame's business, and it is the render loop that knows when its contents
  // changed or when the player walked out of reach of it.
  const openContainer = useCallback(
    (ref: ObjectRef | null) => rendererRef.current?.setOpenedContainer(ref),
    [],
  );
  // Asked of the session rather than answered here, and answered locally rather
  // than by the server: both ends run the same rules, so a slot can light up the
  // instant the pointer is over it instead of a round trip later.
  const canMoveItem = useCallback(
    (from: SlotRef, to: SlotRef) =>
      sessionRef.current?.canMoveItem(from, to) ?? false,
    [],
  );
  const moveItem = useCallback((from: SlotRef, to: SlotRef) => {
    sessionRef.current?.moveItem(from, to);
  }, []);
  const consumeItem = useCallback((slot: SlotRef) => {
    sessionRef.current?.consume({ kind: "slot", slot });
  }, []);
  // Asked of the session, which asks the same question the server will and then
  // sends the message. Nothing is predicted: the button dims when the equipment
  // message comes back with a cooldown on the stone.
  const cast = useCallback((square: CastSquare) => {
    sessionRef.current?.cast(square);
  }, []);
  // Straight at the renderer, like the hover outline and for the same reason: a
  // ghost follows the pointer, and a page that re-rendered to move it would be
  // paying a frame's work per pixel of a drag.
  const dragOverWorld = useCallback(
    (drag: { from: SlotRef; tileId: string; x: number; y: number } | null) => {
      rendererRef.current?.setDropGhost(
        drag
          ? {
              from: drag.from,
              tileId: drag.tileId,
              clientX: drag.x,
              clientY: drag.y,
            }
          : null,
      );
    },
    [],
  );
  // Which cell a point is over is the renderer's question; what to do about it
  // is the session's. Neither knows the other, so the page asks both.
  const dropOnWorld = useCallback(
    (from: SlotRef, point: { x: number; y: number }) => {
      const cell = rendererRef.current?.dropCellAt(point.x, point.y);
      if (cell) sessionRef.current?.drop(from, cell);
      rendererRef.current?.setDropGhost(null);
    },
    [],
  );

  const [lightingEnabled, setLightingEnabled] = useState(true);
  const { mode, looking, attacking, setMode } = usePlayModes();
  // Same reason as the lighting ref below: a reconnect builds a fresh renderer,
  // and it has to come up in whatever mode the player is already in.
  const lookingRef = useRef(looking);
  lookingRef.current = looking;
  // Mirrored into a ref because the cast keys are bound once, with the socket,
  // and must read whatever the row is showing *now* rather than the empty list
  // it was carrying before the first `hello`.
  const spellsRef = useRef(spells);
  spellsRef.current = spells;
  // And a fresh *session*, which is where attack mode lives — the server seats a
  // body that is not swinging at anybody, so the stance has to be said again on
  // every connection. See `RemoteSession`'s handling of `hello` for the other
  // half of this, when the world itself is replaced under a live socket.
  const attackingRef = useRef(attacking);
  attackingRef.current = attacking;
  // Through a ref because the renderer is built on `hello`, and a reconnect
  // builds another one — both must come up at whatever the toggle says now.
  // Held in a ref as well as pushed, because the renderer is built by an effect
  // that deliberately does not depend on the catalogue: an editor save must not
  // tear down and rebuild a running world just to recolour a plume.
  const statusDefsRef = useRef(statusDefs);
  statusDefsRef.current = statusDefs;
  const lightingRef = useRef(lightingEnabled);
  lightingRef.current = lightingEnabled;

  useEffect(() => {
    rendererRef.current?.setLightingEnabled(lightingEnabled);
  }, [lightingEnabled]);

  // A re-authored catalogue reaches a world that is already running: saving a
  // status in the editor should recolour what is on screen, not require a
  // reload. Statuses are held by id, so a body under one keeps it — what
  // changes is only what that id looks like.
  useEffect(() => {
    rendererRef.current?.setStatuses(statusDefs);
  }, [statusDefs]);

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
    /** Whether the world said it was going before it closed the socket. */
    let restarting = false;

    // Reads `session` at call time, not at construction: a reconnect swaps the
    // session underneath while the same keys are still held.
    const input = new HeldDirections((i) => session?.setInput(i));
    inputRef.current = input;
    const unbindKeyboard = bindKeyboard(input);
    // Reads the session and the row at call time, not at construction: a
    // reconnect swaps the session underneath while the same keys are bound, and
    // the row is whatever the player is carrying at the moment they press.
    const unbindCast = bindCastKeys((index) => {
      const spell = spellsRef.current[index];
      if (spell) sessionRef.current?.cast(spell.square);
    });

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
      // And a bag from the world that just went away, whose contents the next
      // `hello` is about to replace outright.
      setEquipment(emptyEquipment());
      setConversation(null);
      setSpells([]);
      setMasteryXp({});
      setVitals({ hp: null, maxHp: null, rating: null, statuses: [] });
      setOpenedContainer(null);
      // And the loading screen comes back for the same reason: the next
      // renderer starts with an empty canvas, and a reconnect can take a while.
      setPainted(false);
      // A death belongs to the session that announced it. The next one opens
      // with a `hello`, which is a body by definition — so carrying the screen
      // across a reconnect would put a Rebirth button over a world this player
      // is already standing in.
      setDead(false);
    };

    const connect = () => {
      if (disposed) return;
      const url = new URL(socketPath, window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set(PROTOCOL_VERSION_PARAM, String(PROTOCOL_VERSION));
      socket = new WebSocket(url);

      const remote = new RemoteSession(socket, tiles);
      // Read in the close handler below, which is where the difference between
      // "the world went away" and "the world is being replaced" is acted on.
      restarting = false;
      remote.setOnRestarting(() => {
        restarting = true;
      });
      session = remote;
      sessionRef.current = remote;
      // Before the socket has said anything, so the count in the first `hello`
      // is not missed — it lands well ahead of the renderer this page otherwise
      // waits for.
      remote.setOnPlayers(setPlayers);
      // Registered here rather than in `setOnReady` for a sharper version of
      // the same reason: a death can only reach a session that is live, but a
      // *reconnect* builds a fresh one, and a listener attached on the renderer
      // path would be one the second session never got.
      remote.setOnDead(setDead);

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
        // Before the first frame: a renderer that draws once without a catalogue
        // draws a poisoned body untinted, and the correction on the next frame
        // is a visible flicker on the frame a player is most likely watching.
        renderer.setStatuses(statusDefsRef.current);
        renderer.setLightingEnabled(lightingRef.current);
        renderer.setLookMode(lookingRef.current);
        renderer.setMinutesOfDay(remote.minutesOfDay());
        renderer.setOnClock(setMinutesOfDay);
        renderer.setOnStats(setStats);
        renderer.setOnInteractions(setInteractions);
        renderer.setOnEquipment(setEquipment);
        renderer.setOnConversation(setConversation);
        renderer.setOnSpells(setSpells);
        renderer.setOnMasteries(setMasteryXp);
        renderer.setOnVitals(setVitals);
        renderer.setOnOpenedContainer(setOpenedContainer);
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

      socket.addEventListener("close", (event) => {
        if (disposed) return;

        // A stale tab cannot be fixed by reconnecting — the next socket would
        // be refused the same way — so it reloads instead. Guarded, because a
        // cached bundle that reloads into the same stale build would loop
        // forever: the second time round, say so and let the person choose.
        if (event.code === CLOSE_OUTDATED_CLIENT) {
          if (sessionStorage.getItem(RELOADED_FOR_VERSION) === "1") {
            setStatus("outdated");
            return;
          }
          sessionStorage.setItem(RELOADED_FOR_VERSION, "1");
          window.location.reload();
          return;
        }
        sessionStorage.removeItem(RELOADED_FOR_VERSION);

        teardownRenderer();
        setStatus(restarting ? "restarting" : "reconnecting");
        setStats(null);
        setPlayers(null);

        // A deploy closes every socket at once. Backing off would leave
        // everybody staring at a world that is already up; reconnecting in
        // lockstep would make them all pay for its cold load at the same
        // moment. So: promptly, and jittered.
        const delay = restarting
          ? RESTART_RECONNECT_MS + Math.random() * RESTART_RECONNECT_JITTER_MS
          : Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
        attempt += 1;
        retryTimer = setTimeout(connect, delay);
      });
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      unbindCast();
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
  // simply connected is not news and folds away into the menu with everything
  // else; a world that is *not* has to be on screen, beside the clock, because
  // it is the only thing explaining why nothing is moving — and a player who has
  // to open a menu to find that out has already concluded the game is broken.
  const statusChip = (
    <span
      className="border-2 border-paper/40 px-1.5 py-0.5 text-xs uppercase text-paper"
      role="status"
    >
      {status}
    </span>
  );

  return (
    <>
      {/* Everything the game is, taken out of reach in one place while this
          player is dead. `inert` rather than a pile of `disabled` props and a
          `pointer-events: none`: it is the browser's own answer to "this
          subtree is not interactive", so it covers the pointer, the tab order,
          the arrow keys reaching a focused field and anything read aloud —
          none of which an overlay drawn on top of them covers. The wrapper
          exists for the attribute and takes the height back, because the shell
          under it is sized against its parent. */}
      <div className="h-full" inert={dead}>
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
          // The bar goes away entirely on a phone, because the game draws the
          // menu itself — see `AppMenuButton` in the row of controls under the
          // world. Which is also why the readings below are handed to the
          // viewport rather than to the header: there is no header to hand them
          // to, and beside the world is where they belonged anyway.
          menuInPage
        >
          {/* Outside the wrapper below and not inside the viewport it is about: the
              viewport waits on its assets, and the document would be cream around
              the loading screen until they arrived. */}
          <InkDocument />
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
                mode={mode}
                onModeChange={setMode}
                readouts={
                  <>
                    {status === "live" ? null : statusChip}
                    <WorldClock minutesOfDay={minutesOfDay} />
                  </>
                }
                interactions={interactions}
                onInteract={act}
                onHoverInteraction={hoverInteraction}
                conversation={conversation}
                onTalk={talk}
                equipment={equipment}
                masteryXp={masteryXp}
                vitals={vitals}
                statuses={activeStatuses(vitals.statuses, statusDefs)}
                openedContainer={openedContainer}
                onOpenContainer={openContainer}
                canMoveItem={canMoveItem}
                onMoveItem={moveItem}
                onConsumeItem={consumeItem}
                onDragOverWorld={dragOverWorld}
                onDropOnWorld={dropOnWorld}
                spells={spells}
                onCast={cast}
                tiles={tiles}
                tilesets={tilesets}
              />
            ) : null}
            {painted ? null : <LoadingScreen />}
          </div>
        </AppShell>
      </div>
      {dead ? <DeathScreen onRebirth={rebirth} /> : null}
    </>
  );
}
