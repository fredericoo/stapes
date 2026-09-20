import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { useLoaderData } from "react-router";
import type { Route } from "./+types/game";
import { AppShell } from "../components/AppShell";
import { DeathScreen } from "../components/DeathScreen";
import { FrameStatsReadout } from "../components/FrameStatsReadout";
import { GameViewport } from "../components/GameViewport";
import { InkDocument } from "../components/InkDocument";
import { LightingToggle } from "../components/LightingToggle";
import { CharacterScreen } from "../components/CharacterScreen";
import { LoadingScreen } from "../components/LoadingScreen";
import { SignInScreen } from "../components/SignInScreen";
import { LeaveWorldButton } from "../components/LeaveWorldButton";
import { OutdatedScreen } from "../components/OutdatedScreen";
import { ReplacedScreen } from "../components/ReplacedScreen";
import { WorldClock } from "../components/WorldClock";
import { type Equipment, emptyEquipment } from "../game/equipment";
import type { Conversation, TalkAction } from "../game/dialogRuntime";
import type { MasteryXp } from "../lib/mastery";
import { bindCastKeys, bindKeyboard, HeldDirections } from "../game/heldDirections";
import {
  applyInteraction,
  type InteractionOption,
} from "../game/interactionOptions";
import { activeStatuses, COMBAT_STATUS_ID, statusesById } from "../lib/status";
import { useGameAssets } from "../lib/gameAssets";
import { DEFAULT_PLAY_MINUTES, type MinutesOfDay } from "../lib/clock";
import type { ObjectRef } from "../game/affordances";
import type { OpenedContainer, SlotRef } from "../game/itemMoves";
import { type CastSlot, type SpellButton, spellPress } from "../game/casting";
import type { Direction } from "../lib/types";
import {
  CHARACTER_PARAM,
  CLOSE_OUTDATED_CLIENT,
  CLOSE_REPLACED,
  CLOSE_SIGNED_OUT,
  GAME_SOCKET_PATH,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_PARAM,
} from "../net/protocol";
import { fetchBootstrap } from "../lib/api";
import { fetchMe, signOut, type Me } from "../lib/auth";
import { MIN_PASSWORD_LENGTH } from "../lib/account";
import type { Character } from "../../server/characters";
import { NO_VITALS, type Vitals } from "../game/GameSession";
import { RemoteSession } from "../net/RemoteSession";
import type { FrameStats } from "../render/frameProfile";
import { GameRenderer } from "../render/GameRenderer";
import { debugViewRequested } from "../render/debugView";

export async function clientLoader() {
  // The catalogues and who this browser is, together: the page cannot decide
  // what to draw without both, and they are independent requests, so asking
  // for them in sequence would be two waits in front of a door.
  //
  // Nothing is *opened* here. The socket waits for a character to open it as —
  // see {@link CharacterScreen} — so a tab that never gets that far costs the
  // world nothing: no body on the board, no chunks sent.
  const [bootstrap, me] = await Promise.all([fetchBootstrap(), fetchMe()]);
  return { ...bootstrap, me, socketPath: GAME_SOCKET_PATH };
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

/**
 * Which character this tab was playing, so a reload comes back as them.
 *
 * Two of the page's own paths end in `location.reload()` — a client refused for
 * its protocol version, and taking the player back from another tab — and both
 * are the app reloading itself mid-session rather than somebody arriving. Left
 * to the character screen they would drop a player at a menu in the middle of
 * playing.
 *
 * **The tab's own storage, not the browser's**, and that is the point rather
 * than a convenience: an account holds three characters, and two tabs playing
 * two of them is a reasonable thing to do. A cookie or `localStorage` would
 * make the second tab silently change the first. It dies with the tab, which
 * is right — a new tab is somebody arriving, and arriving means choosing.
 *
 * Never trusted on its own. The id is checked against the account at the
 * socket, and checked here against the characters `/api/me` just listed, so a
 * character deleted in the database is a tab that lands on the chooser rather
 * than one that hangs on a refusal.
 */
const PLAYING = "stapes:playing";

type Status =
  | "connecting"
  | "live"
  | "reconnecting"
  | "restarting"
  | "outdated"
  | "replaced";

export default function GamePage() {
  const {
    tiles,
    tilesets,
    statuses,
    me: loadedMe,
    socketPath,
  } = useLoaderData<typeof clientLoader>();
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
  /**
   * Who this browser is and what it may play, as of the last time we asked.
   *
   * Seeded from the loader and replaced after every sign-in, sign-out and
   * character creation — the three things that change the answer. Held here
   * rather than re-fetched per screen so that the two doors below are reading
   * the same list.
   */
  const [me, setMe] = useState<Me>(loadedMe);
  /**
   * The character this tab is in the world as, or null for a tab standing at
   * one of the doors.
   *
   * **This is what opens the socket**, and nothing below opens one while it is
   * null: the connecting effect wants a canvas, and there is no canvas behind a
   * door. It is also what the socket names itself with — see
   * {@link CHARACTER_PARAM} — which the server checks against the session
   * rather than believes.
   */
  const [playing, setPlaying] = useState<Character | null>(() => {
    const remembered = sessionStorage.getItem(PLAYING);
    // Against the list the loader just fetched, not against the id alone: a
    // character somebody deleted, or a session that has moved to another
    // account, should land on the chooser rather than on a refused socket.
    return loadedMe.characters.find((one) => one.id === remembered) ?? null;
  });
  /**
   * Whether this tab is in the world, as opposed to standing at a door.
   *
   * Derived rather than held, because a second flag saying the same thing as
   * {@link playing} is a second flag to get out of step with it.
   */
  const inWorld = playing !== null;
  /**
   * Whether the world has been on screen at all since this character was
   * chosen.
   *
   * Beside {@link painted} rather than derived from it, because they answer
   * different questions: `painted` is *is there a frame up now*, which a
   * reconnect takes back, and this is *has this player got in yet*, which
   * nothing but leaving the character takes back. The chooser reads the second
   * one — see {@link entering} — so a reconnect gets the loading screen and its
   * status chip rather than a door claiming somebody is still arriving.
   */
  const [entered, setEntered] = useState(false);
  /**
   * Enter the world as this character.
   *
   * Written down before it is acted on, so a reload mid-session comes back as
   * the same body rather than at the chooser. @see PLAYING
   */
  const play = useCallback((character: Character) => {
    sessionStorage.setItem(PLAYING, character.id);
    setPlaying(character);
  }, []);
  /**
   * Ask the server again who this browser is.
   *
   * The one way {@link me} is ever refreshed, and it is called after each of
   * the three things that change the answer: signing in, signing out, and
   * making a character. Deriving it instead — patching the list locally after a
   * create, say — would be this page keeping a second opinion about what the
   * account holds.
   */
  const refreshMe = useCallback(() => {
    void fetchMe().then(setMe);
  }, []);
  /**
   * Take this character out of the world, keeping the account signed in.
   *
   * Dropping {@link playing} is the whole of it: the connecting effect below is
   * torn down with the canvas, which takes the renderer, the session and this
   * player's body out of the world. The status goes back to what a fresh page
   * says, so the chip does not read `live` over a door.
   *
   * **The session is deliberately left alone.** Leaving the world is not
   * signing out — those are two different things in this game, and this is the
   * first of them. It is how somebody swaps to another of their three, and
   * coming back to the one they left is the same body standing where it was.
   * What that costs is the one thing the button warns about: a body in combat
   * stays on the board after its socket goes.
   * @see ../components/LeaveWorldButton
   */
  const leaveWorld = useCallback(() => {
    sessionStorage.removeItem(PLAYING);
    setStatus("connecting");
    setEntered(false);
    setPlaying(null);
  }, []);
  /**
   * End the session — the account's own door, offered only on the chooser.
   *
   * Takes the body out of the world on the way, because the socket is torn down
   * with the canvas exactly as {@link leaveWorld} does it. A signed-out tab
   * holding a live connection would be a body nobody can sign in as, standing
   * in the square.
   *
   * **Optimistic, then reconciled.** The page forgets who it was before the
   * request has been answered, because waiting would leave somebody who pressed
   * Sign out looking at their own characters; and then it asks `/api/me`, which
   * is the only thing that actually knows. A sign-out that failed to reach the
   * server puts the chooser back rather than leaving a browser that believes it
   * is signed out while the cookie still works.
   */
  const signOutOfAccount = useCallback(() => {
    sessionStorage.removeItem(PLAYING);
    setStatus("connecting");
    setEntered(false);
    setPlaying(null);
    setMe({ user: null, characters: [] });
    void signOut().then(() => void fetchMe().then(setMe));
  }, []);
  /**
   * What the server said it speaks, once it has refused us for speaking
   * something else. Null until then, and null for a refusal that closed without
   * a word. @see ../components/OutdatedScreen
   */
  const [serverVersion, setServerVersion] = useState<number | null>(null);
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
  // Through the ref on `say`'s terms. Nothing is kept here: what the button
  // draws comes back on the broadcast, so the switch cannot show a state the
  // server did not agree to. @see ../game/pvp
  const setPvp = useCallback((on: boolean) => {
    sessionRef.current?.setPvp(on);
  }, []);
  const act = useCallback(
    (option: InteractionOption) =>
      // The renderer beside the session, because one row is not the board's
      // business: following is walking, and the walking is the renderer's.
      // @see ../game/interactionOptions' Follower
      applyInteraction(sessionRef.current, option, rendererRef.current),
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
  const [vitals, setVitals] = useState<Vitals>(NO_VITALS);
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
  const dropOnWorld = useCallback(
    (from: SlotRef, point: { x: number; y: number }) => {
      const cell = rendererRef.current?.dropCellAt(point.x, point.y);
      if (cell) sessionRef.current?.drop(from, cell);
      rendererRef.current?.setDropGhost(null);
    },
    [],
  );

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

  // One way, and only per login: the door comes down against a world being on
  // the canvas, and a reconnect taking the frame back does not put it up again.
  useEffect(() => {
    if (painted) setEntered(true);
  }, [painted]);

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

  /**
   * The id the socket names itself with, and the effect's own dependency.
   *
   * The id rather than the character object, because {@link refreshMe} builds a
   * new list after every sign-in and creation — and a live world torn down and
   * rebuilt because an equal-but-different object arrived would be a full
   * `hello`, the whole map, for nothing.
   */
  const characterId = playing?.id ?? null;

  useEffect(() => {
    // No canvas until this player has picked a character and the assets are
    // decoded, and no socket without a canvas: a world simulating somebody who
    // is not watching is a body standing in a square for nothing.
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Belt and braces with the canvas above: the element only exists once
    // there is a character, and naming one is how this effect is allowed to
    // open a socket at all.
    if (!characterId) return;

    let disposed = false;
    let socket: WebSocket | null = null;
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
      // The same question the button asks, so `1` on the stone being cast
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
      const url = new URL(socketPath, window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set(PROTOCOL_VERSION_PARAM, String(PROTOCOL_VERSION));
      // Which of this account's characters to be. Not a claim the server takes
      // on trust: it looks the id up against the session cookie, and a
      // character belonging to anybody else is a close rather than a body.
      // @see `server/index.ts`
      url.searchParams.set(CHARACTER_PARAM, characterId);
      socket = new WebSocket(url);

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
      remote.setOnClockSet((minutes) =>
        rendererRef.current?.setMinutesOfDay(minutes),
      );

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
        // and says which. @see ../components/OutdatedScreen
        if (event.code === CLOSE_OUTDATED_CLIENT) {
          const serverBehind =
            refusedVersion !== null && refusedVersion < PROTOCOL_VERSION;
          if (serverBehind || sessionStorage.getItem(RELOADED_FOR_VERSION) === "1") {
            setStatus("outdated");
            return;
          }
          sessionStorage.setItem(RELOADED_FOR_VERSION, "1");
          window.location.reload();
          return;
        }
        sessionStorage.removeItem(RELOADED_FOR_VERSION);

        // The session expired, or this character is no longer this account's.
        // Reconnecting would be refused the same way every time, so the tab
        // stops and goes back to the doors — which is where somebody can
        // actually do something about it. Asking the server who we are now is
        // what decides which of the two they land on.
        if (event.code === CLOSE_SIGNED_OUT) {
          teardownRenderer();
          sessionStorage.removeItem(PLAYING);
          setStatus("connecting");
          setEntered(false);
          setPlaying(null);
          setStats(null);
          setPlayers(null);
          void fetchMe().then(setMe);
          return;
        }

        // Another tab has this player now. Reconnecting would take the actor
        // back, the other tab would reconnect and take it again, and the two
        // would trade it for ever — so this one stops and waits to be asked.
        // @see ../components/ReplacedScreen
        if (event.code === CLOSE_REPLACED) {
          teardownRenderer();
          setStatus("replaced");
          setStats(null);
          setPlayers(null);
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
    // `assetsReady` and `characterId` are in here for the canvas rather than
    // for themselves — the element only exists once there is a character and
    // the assets are decoded. They also hold the socket back until then, which
    // is right: a world being simulated for somebody who cannot see it yet is a
    // walk they never asked for. The id rather than the character object, so
    // that re-fetching the list does not tear a live world down.
  }, [tiles, tilesets, socketPath, assetsReady, characterId]);

  /**
   * Whether the press is still being answered — anywhere between a character
   * being chosen and the world appearing.
   *
   * **Getting in is one wait and reads as one.** Opening the socket, waiting on
   * `hello` and waiting for the first frame are three things, and a screen
   * apiece is a page flickering through states a player cannot act on and did
   * not ask about. So the chooser stays up, with the pressed row reading
   * `Entering…`, until there is a world behind it — which is {@link entered},
   * the first frame, and not `hello`: the renderer is built on `hello` and
   * paints some way after it, and that gap was the seam this exists to close.
   *
   * Signing in is deliberately not part of this. It ends in another question
   * rather than in a world, so the account screen goes the moment the cookie
   * lands and the chooser takes over.
   *
   * **The moment something is wrong it stands down**, because the statuses it
   * covers are the two that mean the wait is going normally. A socket that
   * closes before the first frame puts `reconnecting` or `restarting` on the
   * page, and then the loading screen and its chip take over and say so — a
   * chooser reading `Entering…` at somebody whose server is down is a screen
   * that explains nothing. `outdated` and `replaced` are ends of the road and
   * draw their own screens for the same reason.
   */
  const entering =
    inWorld && !entered && (status === "connecting" || status === "live");

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
      {!inWorld ? null : (
        // `entering` is in here for the same reason the death is: the door is
        // drawn over this, and an overlay stops a pointer but not a tab key —
        // a world nobody can see yet is not one to be able to reach into.
        <div className="h-full" inert={dead || rebirthing || entering}>
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
                {/* Last in the row, and last in the menu on a phone: it is the
                    only thing here that takes this body out of the world rather
                    than changing what is on screen.

                    **The account's controls are deliberately not here.**
                    Signing out and changing a password are on the chooser,
                    because that is the screen the account lives on — see
                    ./ChangePassword. A menu offering both would be the one
                    place teaching people that leaving the world and signing
                    out are the same act. */}
                <LeaveWorldButton
                  inCombat={vitals.statuses.some(
                    (status) => status.defId === COMBAT_STATUS_ID,
                  )}
                  onLeave={leaveWorld}
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
              {/* The wait, and the two cases where it is not a wait. A refused
                  version, or another tab taking this player, is the end of the
                  road for this tab — there is no reconnect pending and no world
                  coming — so each takes the loading screen's place rather than
                  sitting behind it, whether or not the canvas ever painted. */}
              {status === "outdated" ? (
                <OutdatedScreen serverVersion={serverVersion} />
              ) : status === "replaced" ? (
                <ReplacedScreen />
              ) : painted || entering ? null : (
                <LoadingScreen />
              )}
            </div>
          </AppShell>
        </div>
      )}
      {/* The two doors, and the wait behind the second of them.

          In this order because they are the two questions in order: who is
          this, and which body. Over the shell rather than inside it, so that
          the press that opens the world does not move the page under it — the
          chooser is in the middle of the page before the press, and the wait
          is in the middle of the page after it.

          Signing in is not a wait: the account screen goes the moment the
          cookie lands, because what follows is another question rather than a
          world. Entering is, which is why the chooser stays up reading
          `Entering…` until there is a frame. @see entering */}
      {!me.user ? (
        <SignInScreen
          onSignedIn={refreshMe}
          minPasswordLength={MIN_PASSWORD_LENGTH}
        />
      ) : !inWorld || entering ? (
        <CharacterScreen
          username={me.user.username}
          characters={me.characters}
          onPlay={play}
          // Straight into the world on a fresh character: somebody who has just
          // typed a name has said what they want to do next, and a list with
          // one new row on it and nothing selected is a screen asking them to
          // say it twice.
          onMade={(character) => {
            refreshMe();
            play(character);
          }}
          onSignOut={signOutOfAccount}
          entering={entering}
        />
      ) : null}

      {/* One screen for the whole time this player has no body to act with,
          which is why the wait is a state of it rather than a second overlay:
          the death outlasts the press, and the wait outlasts the death. */}
      {dead || rebirthing ? (
        <DeathScreen onRebirth={rebirth} pending={rebirthing} />
      ) : null}
    </>
  );
}
