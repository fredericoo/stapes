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

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

const RESTART_RECONNECT_MS = 250;
const RESTART_RECONNECT_JITTER_MS = 750;

const WORLD_FULL_RETRY_MS = 20_000;
const WORLD_FULL_RETRY_JITTER_MS = 10_000;

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
  link: WorldLink;
  tiles: TileDef[];
  tilesets: TilesetDef[];
  statuses: unknown[];
  destinations?: Destination[];
  menuExtras?: React.ReactNode;
  admin?: boolean;
  onLeave?: () => void;
  onRefused?: () => void;
}) {
  const statusDefs = useMemo(() => statusesById(statuses), [statuses]);
  const assetsReady = useGameAssets(tilesets);
  const [painted, setPainted] = useState(false);
  const reloadedKey = `${RELOADED_FOR_VERSION}:${link.id}`;
  const [serverVersion, setServerVersion] = useState<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<GameRenderer | null>(null);
  const inputRef = useRef<HeldDirections | null>(null);
  const sessionRef = useRef<RemoteSession | null>(null);
  const pressDirection = useCallback((d: Direction) => inputRef.current?.press(d), []);
  const releaseDirection = useCallback((d: Direction) => inputRef.current?.release(d), []);
  const say = useCallback((text: string) => sessionRef.current?.say(text), []);
  const setPvp = useCallback((on: boolean) => {
    sessionRef.current?.setPvp(on);
  }, []);
  const act = useCallback((option: InteractionOption) => {
    const renderer = rendererRef.current;
    const current = renderer ? renderer.listOption(option.id) : option;
    if (!current) return;
    applyInteraction(sessionRef.current, current, renderer);
  }, []);
  const talk = useCallback((action: TalkAction) => sessionRef.current?.talk(action), []);
  const craft = useCallback(
    (ref: ObjectRef, recipeIndex: number) => sessionRef.current?.craft(ref, recipeIndex),
    [],
  );
  const closeCrafting = useCallback(() => rendererRef.current?.setCrafting(null), []);
  const hoverInteraction = useCallback(
    (optionId: string | null) => rendererRef.current?.setListHover(optionId),
    [],
  );
  const noteTyping = useCallback((typing: boolean) => {
    if (typing) inputRef.current?.clear();
  }, []);
  const [status, setStatus] = useState<Status>("connecting");
  const [dead, setDead] = useState(false);
  const [rebirthing, setRebirthing] = useState(false);
  const rebirth = useCallback(() => {
    const session = sessionRef.current;
    if (!session?.isDead()) return;
    session.rebirth();
    setRebirthing(true);
  }, []);
  const [minutesOfDay, setMinutesOfDay] = useState<MinutesOfDay>(DEFAULT_PLAY_MINUTES);
  const [stats, setStats] = useState<FrameStats | null>(null);
  const [players, setPlayers] = useState<number | null>(null);
  const [hidden, setHidden] = useState(false);
  const [interactions, setInteractions] = useState<InteractionOption[]>([]);
  const [equipment, setEquipment] = useState<Equipment>(emptyEquipment);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [masteryXp, setMasteryXp] = useState<MasteryXp>({});
  const [vitals, setVitals] = useState<Vitals>(NO_VITALS);
  const [openedContainer, setOpenedContainer] = useState<OpenedContainer | null>(null);
  const [crafting, setCrafting] = useState<CraftingWindow | null>(null);
  const [spells, setSpells] = useState<SpellButton[]>([]);
  const openContainer = useCallback(
    (ref: ObjectRef | null) => rendererRef.current?.setOpenedContainer(ref),
    [],
  );
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
  const cast = useCallback((slot: CastSlot) => {
    sessionRef.current?.cast(slot);
  }, []);
  const stopCast = useCallback(() => {
    sessionRef.current?.cancelCast();
  }, []);
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
  const dropOnWorld = useCallback((from: SlotRef, point: { x: number; y: number }) => {
    const cell = rendererRef.current?.dropCellAt(point.x, point.y);
    if (cell) sessionRef.current?.drop(from, cell);
    rendererRef.current?.setDropGhost(null);
  }, []);

  const [lightingEnabled, setLightingEnabled] = useState(true);
  const spellsRef = useRef(spells);
  spellsRef.current = spells;
  const statusDefsRef = useRef(statusDefs);
  statusDefsRef.current = statusDefs;
  const lightingRef = useRef(lightingEnabled);
  lightingRef.current = lightingEnabled;
  const handlersRef = useRef({ onLeave, onRefused });
  handlersRef.current = { onLeave, onRefused };
  const stopRef = useRef<(() => void) | null>(null);
  const leave = useCallback(() => {
    stopRef.current?.();
    handlersRef.current.onLeave?.();
  }, []);

  useEffect(() => {
    rendererRef.current?.setLightingEnabled(lightingEnabled);
  }, [lightingEnabled]);

  useEffect(() => {
    rendererRef.current?.setStatuses(statusDefs);
  }, [statusDefs]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let socket: ClientSocket | null = null;
    let session: RemoteSession | null = null;
    let renderer: GameRenderer | null = null;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let restarting = false;
    let refusedVersion: number | null = null;

    const input = new HeldDirections((i) => session?.setInput(i));
    inputRef.current = input;
    const unbindKeyboard = bindKeyboard(input);
    const unbindCast = bindCastKeys((index) => {
      const spell = spellsRef.current[index];
      if (!spell) return;
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
      setInteractions([]);
      setEquipment(emptyEquipment());
      setConversation(null);
      setSpells([]);
      setMasteryXp({});
      setVitals(NO_VITALS);
      setOpenedContainer(null);
      setCrafting(null);
      setPainted(false);
      setDead(false);
      setRebirthing(false);
    };

    const connect = () => {
      if (disposed) return;
      socket = link.open();

      const remote = new RemoteSession(socket, tiles, statusDefsRef.current);
      restarting = false;
      refusedVersion = null;
      remote.setOnRestarting(() => {
        restarting = true;
      });
      remote.setOnOutdated((version) => {
        refusedVersion = version;
        setServerVersion(version);
      });
      session = remote;
      sessionRef.current = remote;
      remote.setOnPlayers(setPlayers);
      remote.setOnHidden(setHidden);
      remote.setOnDead((isDead) => {
        setDead(isDead);
        if (isDead) return;
        if (!rendererRef.current) {
          setRebirthing(false);
          return;
        }
        rendererRef.current.setOnNextFrame(() => {
          setRebirthing(false);
          setPainted(true);
        });
      });
      remote.setOnClockSet((minutes) => rendererRef.current?.setMinutesOfDay(minutes));

      remote.setOnReady(() => {
        if (disposed || renderer) return;
        attempt = 0;
        setStatus("live");
        renderer = new GameRenderer(canvas, remote, tilesets, tiles, labelRef.current);
        renderer.setStatuses(statusDefsRef.current);
        renderer.setLightingEnabled(lightingRef.current);
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
        renderer.setDirections(input);
        rendererRef.current = renderer;
        renderer.start();
        input.resend();
      });

      socket.addEventListener("close", (event) => {
        if (disposed) return;

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

        if (event.code === CLOSE_SIGNED_OUT) {
          teardownRenderer();
          setStats(null);
          setPlayers(null);
          handlersRef.current.onRefused?.();
          return;
        }

        if (event.code === CLOSE_REPLACED) {
          teardownRenderer();
          setStatus("replaced");
          setStats(null);
          setPlayers(null);
          return;
        }

        if (event.code === CLOSE_MAINTENANCE) {
          teardownRenderer();
          setStatus("maintenance");
          setStats(null);
          setPlayers(null);
          return;
        }

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

        const delay = restarting
          ? RESTART_RECONNECT_MS + Math.random() * RESTART_RECONNECT_JITTER_MS
          : Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
        attempt += 1;
        retryTimer = setTimeout(connect, delay);
      });
    };

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
  }, [tiles, tilesets, link, assetsReady]);

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
      <div className="h-full" inert={dead || rebirthing} data-world-status={status}>
        <AppShell
          destinations={destinations}
          menuExtras={
            <>
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
          menuInPage
        >
          <InkDocument />
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

      {dead || rebirthing ? <DeathScreen onRebirth={rebirth} pending={rebirthing} /> : null}
    </>
  );
}
