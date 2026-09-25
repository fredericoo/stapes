import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { AppShell, type Destination, MenuRow } from "./AppShell";
import { InvisibleToggle } from "./InvisibleToggle";
import { DeathScreen } from "./DeathScreen";
import { FrameStatsReadout } from "./FrameStatsReadout";
import { GameViewport } from "./GameViewport";
import { InkDocument } from "./InkDocument";
import { LightingToggle } from "./LightingToggle";
import { LoadingScreen } from "./LoadingScreen";
import { LeaveWorldButton } from "./LeaveWorldButton";
import { MaintenanceScreen } from "./MaintenanceScreen";
import { OutdatedScreen } from "./OutdatedScreen";
import { ReplacedScreen } from "./ReplacedScreen";
import { WorldFullScreen } from "./WorldFullScreen";
import { WorldClock } from "./WorldClock";
import { type Equipment, emptyEquipment } from "../game/equipment";
import type { Conversation, TalkAction } from "../game/dialogRuntime";
import type { MasteryXp } from "../lib/mastery";
import { bindCastKeys, bindKeyboard, HeldDirections } from "../game/heldDirections";
import { applyInteraction, type InteractionOption } from "../game/interactionOptions";
import { activeStatuses, COMBAT_STATUS_ID, statusesById } from "../lib/status";
import { useGameAssets } from "../lib/gameAssets";
import { DEFAULT_PLAY_MINUTES, type MinutesOfDay } from "../lib/clock";
import type { ObjectRef } from "../game/affordances";
import type { OpenedContainer, SlotRef } from "../game/itemMoves";
import type { CraftingWindow } from "../game/craft";
import { type CastSlot, type SpellButton, spellPress } from "../game/casting";
import type { Direction, TileDef, TilesetDef } from "../lib/types";
import {
  CLOSE_MAINTENANCE,
  CLOSE_OUTDATED_CLIENT,
  CLOSE_REPLACED,
  CLOSE_SIGNED_OUT,
  CLOSE_WORLD_FULL,
  PROTOCOL_VERSION,
} from "../net/protocol";
import type { WorldLink } from "../net/link";
import type { ClientSocket } from "../net/socket";
import { NO_VITALS, type Vitals } from "../game/GameSession";
import { RemoteSession } from "../net/RemoteSession";
import type { FrameStats } from "../render/frameProfile";
import { GameRenderer } from "../render/GameRenderer";
import { debugViewRequested } from "../render/debugView";

/**
 * The game, whatever it is connected to.
 *
 * Both routes that draw a world draw this one: `/` against the shared world
 * over a socket, and `/admin/play` against a world running in a worker in the
 * same tab. **They are the same page rather than two pages kept in step**,
 * because the second exists to be a faithful stand-in for the first — a copy
 * would start diverging on the first change to either, and the divergence
 * would be invisible until somebody tested a fix on the wrong one.
 *
 * Everything here is therefore about a world at the other end of a wire, and
 * says nothing about where that wire goes. What differs is behind
 * {@link WorldLink}: opening a connection, and whether this page is allowed to
 * throw the world away and start again.
 *
 * **It does not ask who you are.** It used to hold a Log in button, and that
 * moved out to routes — `/sign-in`, `/characters` and the rest — because
 * "which account" and "which character" are questions with their own screens,
 * their own URLs and their own redirects. By the time this mounts, the answer
 * is settled: `/`'s loader has redirected anybody without one, and
 * `/admin/play` needs none. So this connects on mount and the loading screen
 * covers the wait.
 *
 * @see ../net/link
 * @see ../routes/player, the layout the game's screens share
 */

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

/**
 * How long to wait before knocking again on a full world, and how much to
 * smear it.
 *
 * Slow on purpose, on the terms `./MaintenanceScreen` polls slowly: every tab
 * refused is asking a server that is already at its limit. The jitter keeps
 * the tabs refused together from all asking again together.
 */
const WORLD_FULL_RETRY_MS = 20_000;
const WORLD_FULL_RETRY_JITTER_MS = 10_000;

/** Guards the reload-on-stale-client path against looping. */
const RELOADED_FOR_VERSION = "stapes:reloaded-for-version";

type Status =
  | "connecting"
  | "live"
  | "reconnecting"
  | "restarting"
  | "outdated"
  | "replaced"
  | "maintenance"
  | "full";

export function WorldPage({
  link,
  tiles,
  tilesets,
  statuses,
  destinations,
  menuExtras,
  admin = false,
  onLeave,
  onRefused,
}: {
  /** How this page gets to a world, and the only thing `/` and `/admin/play` disagree about. */
  link: WorldLink;
  tiles: TileDef[];
  tilesets: TilesetDef[];
  statuses: unknown[];
  /**
   * Where this page's menu can take you. Empty for the game, which offers a
   * player no way into the editors; `ADMIN_DESTINATIONS` under `/admin`, where
   * every other authoring page has the same row.
   */
  destinations?: Destination[];
  /** Controls this page has and the other does not, in the same menu. */
  menuExtras?: React.ReactNode;
  /**
   * Whether the account is an administrator's, which is what draws the
   * **Invisible** switch. Only the game passes it: `/admin/play` is a world of
   * one, with nobody in it to hide from.
   */
  admin?: boolean;
  /**
   * Take this character out of the world, if there is anywhere to take it.
   *
   * Given by the game, where leaving means going back to the character chooser
   * — see `../routes/game`. Absent under `/admin/play`, where there is nothing
   * to leave *to*: that world is this tab's and closing the tab is the way out
   * of it. The menu draws **Leave world** only when this is here.
   */
  onLeave?: () => void;
  /**
   * The world refused this connection for who it was opened as.
   *
   * Only the shared world can answer that — see {@link CLOSE_SIGNED_OUT} — and
   * only the game supplies it. Reconnecting would be refused the same way every
   * time, so the page stops and lets the route decide where somebody goes.
   */
  onRefused?: () => void;
}) {
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
  const reloadedKey = `${RELOADED_FOR_VERSION}:${link.id}`;
  /**
   * What the server said it speaks, once it has refused us for speaking
   * something else. Null until then, and null for a refusal that closed without
   * a word. @see ./OutdatedScreen
   */
  const [serverVersion, setServerVersion] = useState<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<GameRenderer | null>(null);
  const inputRef = useRef<HeldDirections | null>(null);
  const sessionRef = useRef<RemoteSession | null>(null);
  const pressDirection = useCallback((d: Direction) => inputRef.current?.press(d), []);
  const releaseDirection = useCallback((d: Direction) => inputRef.current?.release(d), []);
  // Through a ref for the same reason the directions are: a reconnect swaps the
  // session underneath while the page keeps the callback it was handed.
  const say = useCallback((text: string) => sessionRef.current?.say(text), []);
  // Through the ref on `say`'s terms. Nothing is kept here: what the button
  // draws comes back on the broadcast, so the switch cannot show a state the
  // server did not agree to. @see ../game/pvp
  const setPvp = useCallback((on: boolean) => {
    sessionRef.current?.setPvp(on);
  }, []);
  const act = useCallback((option: InteractionOption) => {
    const renderer = rendererRef.current;
    // The row as the renderer holds it this frame, not as React was last handed
    // it: a body that walked keeps its row and changes cell, and the ref in
    // the copy held here is where it stood when the row appeared. A row that is
    // no longer listed does nothing. @see GameRenderer's listOption
    const current = renderer ? renderer.listOption(option.id) : option;
    if (!current) return;
    // The renderer beside the session, because one row is not the board's
    // business: following is walking, and the walking is the renderer's.
    // @see ../game/interactionOptions' Follower
    applyInteraction(sessionRef.current, current, renderer);
  }, []);
  const talk = useCallback((action: TalkAction) => sessionRef.current?.talk(action), []);
  const craft = useCallback(
    (ref: ObjectRef, recipeIndex: number) => sessionRef.current?.craft(ref, recipeIndex),
    [],
  );
  // Straight at the renderer, like opening a box: which forge's window is open
  // is a frame's business, and it is the render loop that knows when the
  // player walked away or ran out of anything to spend.
  const closeCrafting = useCallback(() => rendererRef.current?.setCrafting(null), []);
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
   * for as long as it or {@link rebirthing} is true, and that is a React
   * attribute on a real element rather than something a frame can draw.
   */
  const [dead, setDead] = useState(false);
  /**
   * Whether a body has been asked for and the world it comes with is not drawn.
   *
   * Beside {@link dead} rather than inside it, because the two do not end at
   * the same moment: the `hello` answering a rebirth clears the death on the
   * message, and this outlasts it by however long the renderer takes to build
   * the map that message carried. The screen is one thing to the person
   * watching, so it comes down once, at the end of both.
   */
  const [rebirthing, setRebirthing] = useState(false);
  const rebirth = useCallback(() => {
    const session = sessionRef.current;
    // Asked of the session rather than of this page's own `dead`, because the
    // server drops a `rebirth` from anybody it does not hold a death for — and
    // a wait shown for a message that was never sent is a wait nothing ends.
    if (!session?.isDead()) return;
    session.rebirth();
    setRebirthing(true);
  }, []);
  // Placeholder until `hello` says what time it is out there. Nobody scrubs it:
  // the hour belongs to the world, not to whoever is looking at it.
  const [minutesOfDay, setMinutesOfDay] = useState<MinutesOfDay>(DEFAULT_PLAY_MINUTES);
  const [stats, setStats] = useState<FrameStats | null>(null);
  // Null while there is no connection to have heard it from, which is not the
  // same as an empty world — an unknown headcount reads as a dash rather than
  // claiming nobody is here.
  const [players, setPlayers] = useState<number | null>(null);
  /** Whether the server says this body is hidden. @see InvisibleToggle */
  const [hidden, setHidden] = useState(false);
  const [interactions, setInteractions] = useState<InteractionOption[]>([]);
  const [equipment, setEquipment] = useState<Equipment>(emptyEquipment);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  /** What this player has learnt — theirs alone, beside the kit. */
  const [masteryXp, setMasteryXp] = useState<MasteryXp>({});
  /** What this player's body can take, and its ⭐. */
  const [vitals, setVitals] = useState<Vitals>(NO_VITALS);
  const [openedContainer, setOpenedContainer] = useState<OpenedContainer | null>(null);
  const [crafting, setCrafting] = useState<CraftingWindow | null>(null);
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
    (from: SlotRef, to: SlotRef) => sessionRef.current?.canMoveItem(from, to) ?? false,
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
  const cast = useCallback((slot: CastSlot) => {
    sessionRef.current?.cast(slot);
  }, []);
  const stopCast = useCallback(() => {
    sessionRef.current?.cancelCast();
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
  const dropOnWorld = useCallback((from: SlotRef, point: { x: number; y: number }) => {
    const cell = rendererRef.current?.dropCellAt(point.x, point.y);
    if (cell) sessionRef.current?.drop(from, cell);
    rendererRef.current?.setDropGhost(null);
  }, []);

  const [lightingEnabled, setLightingEnabled] = useState(true);
  // Mirrored into a ref because the cast keys are bound once, with the socket,
  // and must read whatever the row is showing *now* rather than the empty list
  // it was carrying before the first `hello`.
  const spellsRef = useRef(spells);
  spellsRef.current = spells;
  // Through a ref because the renderer is built on `hello`, and a reconnect
  // builds another one — both must come up at whatever the toggle says now.
  // Held in a ref as well as pushed, because the renderer is built by an effect
  // that deliberately does not depend on the catalogue: an editor save must not
  // tear down and rebuild a running world just to recolour a plume.
  const statusDefsRef = useRef(statusDefs);
  statusDefsRef.current = statusDefs;
  const lightingRef = useRef(lightingEnabled);
  lightingRef.current = lightingEnabled;
  /**
   * The route's two callbacks, read at call time rather than named as
   * dependencies of the connecting effect.
   *
   * Neither is a reason to throw a live world away, and a caller that passed an
   * inline arrow — which is every caller — would rebuild the connection on
   * every render if they were in that list. This is the discipline every other
   * long-lived callback in that effect already follows.
   */
  const handlersRef = useRef({ onLeave, onRefused });
  handlersRef.current = { onLeave, onRefused };
  /** The connecting effect's teardown, while it has a world to tear down. @see leave */
  const stopRef = useRef<(() => void) | null>(null);
  /**
   * **Leave world**: out of the world at the press, and only then to wherever
   * the route sends a character that has left.
   *
   * The connection is closed here rather than left to the unmount the route's
   * navigation causes, because that unmount can be a long time coming. React
   * Router commits a navigation inside `startTransition`, which gives way to
   * every ordinary update, and a live world keeps making them — the clock, the
   * frame readout, the vitals, the list of what is within reach — between
   * frames that take most of a slow machine's time. There, the press did
   * nothing for seconds, or never did anything, while the body stood in the
   * world. With the socket closed and the renderer stopped there is nothing
   * left for the navigation to give way to. @see `docs/notes.md`, "An account
   * signs in; a character enters"
   */
  const leave = useCallback(() => {
    stopRef.current?.();
    handlersRef.current.onLeave?.();
  }, []);

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
    // No canvas until this player has logged in and the assets are decoded, and
    // no socket without a canvas: a world simulating somebody who is not
    // watching is a body standing in a square for nothing.
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let socket: ClientSocket | null = null;
    let session: RemoteSession | null = null;
    let renderer: GameRenderer | null = null;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    /** Whether the world said it was going before it closed the socket. */
    let restarting = false;
    /**
     * What protocol the server said it speaks, when it refused us for speaking
     * another. Null for every other kind of close.
     */
    let refusedVersion: number | null = null;

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
      if (!spell) return;
      // The same question the button asks, so `Q` on the stone being cast
      // stops it exactly as a tap on it does. @see `../game/casting`'s `spellPress`
      if (spellPress(spell.castability) === "stop") sessionRef.current?.cancelCast();
      else sessionRef.current?.cast(spell.slot);
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
      setVitals(NO_VITALS);
      setOpenedContainer(null);
      setCrafting(null);
      // And the loading screen comes back for the same reason: the next
      // renderer starts with an empty canvas, and a reconnect can take a while.
      setPainted(false);
      // A death belongs to the session that announced it. The next one opens
      // with a `hello`, which is a body by definition — so carrying the screen
      // across a reconnect would put a Rebirth button over a world this player
      // is already standing in.
      setDead(false);
      // And with it the wait for a body, whose answer went away with the socket
      // that owed it. What stands over the page from here is the reconnect's
      // own loading screen, which says what is being waited for.
      setRebirthing(false);
    };

    const connect = () => {
      if (disposed) return;
      socket = link.open();

      // The status catalogue goes in with the tiles: both are authored data the
      // session derives a walking pace from, and a pace never travels.
      const remote = new RemoteSession(socket, tiles, statusDefsRef.current);
      // Read in the close handler below, which is where the difference between
      // "the world went away" and "the world is being replaced" is acted on.
      restarting = false;
      refusedVersion = null;
      remote.setOnRestarting(() => {
        restarting = true;
      });
      // Read in the close handler below, which is where the two ways round of
      // being out of date are told apart.
      remote.setOnOutdated((version) => {
        refusedVersion = version;
        setServerVersion(version);
      });
      session = remote;
      sessionRef.current = remote;
      // Before the socket has said anything, so the count in the first `hello`
      // is not missed — it lands well ahead of the renderer this page otherwise
      // waits for.
      remote.setOnPlayers(setPlayers);
      remote.setOnHidden(setHidden);
      // Registered here rather than in `setOnReady` for a sharper version of
      // the same reason: a death can only reach a session that is live, but a
      // *reconnect* builds a fresh one, and a listener attached on the renderer
      // path would be one the second session never got.
      remote.setOnDead((isDead) => {
        setDead(isDead);
        if (isDead) return;
        // A body again — but the `hello` that said so carries a whole map, and
        // nothing has been drawn from it yet: a rebirth somewhere else dirties
        // every chunk on screen, and `syncChunks` rebuilds them all inside one
        // frame. Taking the screen down on the message would hand the player
        // that frame, which is the world they died in, frozen, for as long as
        // the rebuild takes. So it comes down against the world appearing,
        // exactly as the loading screen does.
        //
        // No renderer is no frame to wait for, and the wait has to end anyway.
        if (!rendererRef.current) {
          setRebirthing(false);
          return;
        }
        rendererRef.current.setOnNextFrame(() => {
          setRebirthing(false);
          // And the loading screen's own wait, which is the same wait: the hook
          // is one shot, so a death in the gap between the first `hello` and
          // the first paint would otherwise take its turn and leave it up for
          // good. A frame on the canvas is what it was waiting for too.
          setPainted(true);
        });
      });
      // The renderer runs the clock forward from one anchor, so a `/time` has
      // to reach it as a new anchor. Before the first `hello` there is no
      // renderer yet, and `setOnReady` below reads the hour for itself.
      remote.setOnClockSet((minutes) => rendererRef.current?.setMinutesOfDay(minutes));

      // The renderer only starts once there is a world: it centres on the
      // viewer's own actor, and before `hello` there is nobody to centre on.
      remote.setOnReady(() => {
        if (disposed || renderer) return;
        attempt = 0;
        setStatus("live");
        renderer = new GameRenderer(canvas, remote, tilesets, tiles, labelRef.current);
        // Before the first frame: a renderer that draws once without a catalogue
        // draws a poisoned body untinted, and the correction on the next frame
        // is a visible flicker on the frame a player is most likely watching.
        renderer.setStatuses(statusDefsRef.current);
        renderer.setLightingEnabled(lightingRef.current);
        // Undocumented on purpose — `?debug=1`, and `docs/notes.md`
        // is where it is written down. @see ../render/debugView
        renderer.setDebugView(debugViewRequested(window.location.search));
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
        renderer.setOnCrafting(setCrafting);
        renderer.setOnNextFrame(() => setPainted(true));
        // The keys, the on-screen pad and a click on the world all press the
        // same list, which is what settles between them: taking the keys back
        // ends a clicked walk, and neither has to know the other exists. The
        // list outlives the renderer, so a reconnect hands it to the new one.
        renderer.setDirections(input);
        rendererRef.current = renderer;
        renderer.start();
        // The fresh session knows nothing about keys held across the reconnect.
        // They are said again here rather than when the socket was created,
        // because until `hello` there is nothing at the other end listening.
        //
        // The stance is not re-sent, and needs no longer be: a fresh body is
        // swinging at nobody and has nobody picked, and swinging is now
        // something you ask for about one creature rather than a mode you could
        // be left in. The next press on a body says both halves again.
        input.resend();
      });

      socket.addEventListener("close", (event) => {
        if (disposed) return;

        // A stale tab cannot be fixed by reconnecting — the next socket would
        // be refused the same way — so it reloads instead. Two things stop it:
        // a reload that already happened, because a cached bundle coming back
        // the same age it went in would loop forever; and a server that is
        // *older* than this page, where a newer bundle is not the fix and no
        // number of reloads will make it one. Either way the screen takes over
        // and says which. @see ./OutdatedScreen
        if (event.code === CLOSE_OUTDATED_CLIENT) {
          const serverBehind = refusedVersion !== null && refusedVersion < PROTOCOL_VERSION;
          if (serverBehind || sessionStorage.getItem(reloadedKey) === "1") {
            setStatus("outdated");
            return;
          }
          sessionStorage.setItem(reloadedKey, "1");
          window.location.reload();
          return;
        }
        sessionStorage.removeItem(reloadedKey);

        // The session expired, or this character is no longer this account's.
        // Reconnecting would be refused the same way every time, so the page
        // stops and lets the route decide where somebody goes. Only the shared
        // world can answer this; locally there is nobody to refuse you.
        if (event.code === CLOSE_SIGNED_OUT) {
          teardownRenderer();
          setStats(null);
          setPlayers(null);
          handlersRef.current.onRefused?.();
          return;
        }

        // Another tab has this player now. Reconnecting would take the actor
        // back, the other tab would reconnect and take it again, and the two
        // would trade it for ever — so this one stops and waits to be asked.
        // @see ./ReplacedScreen
        if (event.code === CLOSE_REPLACED) {
          teardownRenderer();
          setStatus("replaced");
          setStats(null);
          setPlayers(null);
          return;
        }

        // The world is closed to players. Reconnecting would be refused the
        // same way until it opens, and the screen is what finds out when that
        // is. @see ./MaintenanceScreen
        if (event.code === CLOSE_MAINTENANCE) {
          teardownRenderer();
          setStatus("maintenance");
          setStats(null);
          setPlayers(null);
          return;
        }

        // The world is at its player limit. Unlike maintenance, a seat opens
        // whenever somebody leaves, so this does try again — on a slow timer of
        // its own, and without growing the backoff for the next ordinary drop.
        // The screen stays up until a `hello` sets the page live.
        // @see ./WorldFullScreen
        if (event.code === CLOSE_WORLD_FULL) {
          teardownRenderer();
          setStatus("full");
          setStats(null);
          setPlayers(null);
          retryTimer = setTimeout(
            connect,
            WORLD_FULL_RETRY_MS + Math.random() * WORLD_FULL_RETRY_JITTER_MS,
          );
          return;
        }

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

    // What the unmount does, and what **Leave world** does first, so it is safe
    // to run twice. @see leave
    const stop = () => {
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
    stopRef.current = stop;

    connect();

    return () => {
      if (stopRef.current === stop) stopRef.current = null;
      stop();
    };
    // `assetsReady` is in here for the canvas rather than for itself — the
    // element only exists once it is true. It also holds the connection back
    // until then, which is right: a world being simulated for somebody who
    // cannot see it yet is a walk they never asked for.
    //
    // Nothing else belongs here. Every entry is a reason to throw a live world
    // away and ask for another one, which is a fresh `hello` — the whole map.
    // That is why the two callbacks are read through {@link handlersRef}.
  }, [tiles, tilesets, link, assetsReady]);

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
      {/* **Nothing of the game is in the page before the press**: no canvas, so
          no socket — see the effect above. The catalogues and the tilesets load
          behind the door either way, because `useGameAssets` runs whether or
          not the world is being drawn, so the longer somebody looks at the
          button the less the press has left to wait for.

          The wrapper below is everything the game is, taken out of reach in one
          place while this player is dead. `inert` rather than a pile of
          `disabled` props and a `pointer-events: none`: it is the browser's own
          answer to "this subtree is not interactive", so it covers the pointer,
          the tab order, the arrow keys reaching a focused field and anything
          read aloud — none of which an overlay drawn on top of them covers. It
          exists for the attribute and takes the height back, because the shell
          under it is sized against its parent. */}
      <div
        className="h-full"
        inert={dead || rebirthing}
        // The connection's state where a test can wait on it without opening
        // the menu the chip that says it lives in.
        data-world-status={status}
      >
        <AppShell
          destinations={destinations}
          menuExtras={
            <>
              {/* Announced, unlike the clock: the headcount changes only when
                  somebody actually arrives or leaves, which is worth hearing.
                  Only an administrator is sent it, so for everybody else the
                  count stays null and the row is not drawn. */}
              {players === null ? null : (
                <div role="status">
                  <MenuRow label="Players">
                    <span className="border-2 border-paper/40 px-1.5 py-0.5 text-xs tabular-nums text-paper">
                      {players}
                    </span>
                  </MenuRow>
                </div>
              )}
              {status === "live" ? <MenuRow label="Connection">{statusChip}</MenuRow> : null}
              <MenuRow label="Frame rate">
                <FrameStatsReadout stats={stats} />
              </MenuRow>
              <MenuRow label="Lighting">
                <LightingToggle enabled={lightingEnabled} onChange={setLightingEnabled} />
              </MenuRow>
              {admin ? (
                <MenuRow label="Invisible">
                  <InvisibleToggle
                    hidden={hidden}
                    onChange={(next) => sessionRef.current?.setHidden(next)}
                  />
                </MenuRow>
              ) : null}
              {menuExtras}
              {/* Last in the menu: it is the only thing here that ends the
                  session rather than changing what is on screen. */}
              {onLeave ? (
                <div className="py-2">
                  <LeaveWorldButton
                    inCombat={vitals.statuses.some((status) => status.defId === COMBAT_STATUS_ID)}
                    onLeave={leave}
                  />
                </div>
              ) : null}
            </>
          }
          // No bar at all, on any device, because the game draws the menu
          // itself — see `AppMenuButton` in the row of controls beside the
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
                onPvp={setPvp}
                onTypingChange={noteTyping}
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
                crafting={crafting}
                onCraft={craft}
                onCloseCrafting={closeCrafting}
                equipment={equipment}
                masteryXp={masteryXp}
                vitals={vitals}
                statuses={activeStatuses(vitals.statuses, statusDefs)}
                statusDefs={statusDefs}
                openedContainer={openedContainer}
                onOpenContainer={openContainer}
                canMoveItem={canMoveItem}
                onMoveItem={moveItem}
                onConsumeItem={consumeItem}
                onDragOverWorld={dragOverWorld}
                onDropOnWorld={dropOnWorld}
                spells={spells}
                onCast={cast}
                onStopCast={stopCast}
                tiles={tiles}
                tilesets={tilesets}
              />
            ) : null}
            {/* The wait, and the cases where it is not an ordinary wait. A
                  refused version, another tab taking this player, a world closed
                  for maintenance or a world that is full each takes the loading
                  screen's place rather than sitting behind it, whether or not the
                  canvas ever painted. */}
            {status === "outdated" ? (
              <OutdatedScreen serverVersion={serverVersion} />
            ) : status === "replaced" ? (
              <ReplacedScreen />
            ) : status === "maintenance" ? (
              <MaintenanceScreen />
            ) : status === "full" ? (
              <WorldFullScreen />
            ) : painted ? null : (
              <LoadingScreen />
            )}
          </div>
        </AppShell>
      </div>

      {/* One screen for the whole time this player has no body to act with,
          which is why the wait is a state of it rather than a second overlay:
          the death outlasts the press, and the wait outlasts the death. */}
      {dead || rebirthing ? <DeathScreen onRebirth={rebirth} pending={rebirthing} /> : null}
    </>
  );
}
