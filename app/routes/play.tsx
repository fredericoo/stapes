import { useCallback, useEffect, useRef, useState } from "react";
import { useLoaderData } from "react-router";
import type { Route } from "./+types/play";
import { AppShell } from "../components/AppShell";
import { GameViewport } from "../components/GameViewport";
import { LightingToggle } from "../components/LightingToggle";
import { GameSession } from "../game/GameSession";
import { type Equipment, emptyEquipment } from "../game/equipment";
import { bindKeyboard, HeldDirections } from "../game/heldDirections";
import { usePlayModes } from "../components/usePlayModes";
import {
  applyInteraction,
  type InteractionOption,
} from "../game/interactionOptions";
import {
  DEFAULT_PLAY_MINUTES,
  formatClock,
  MINUTES_PER_DAY,
  type MinutesOfDay,
} from "../lib/clock";
import type { ObjectRef } from "../game/affordances";
import type { ItemInstance } from "../lib/itemInstance";
import type { Direction } from "../lib/types";
import { dataStore } from "../context";
import { GameRenderer } from "../render/GameRenderer";
import { FrameStatsReadout } from "../components/FrameStatsReadout";
import type { FrameStats } from "../render/frameProfile";

export async function loader({ context }: Route.LoaderArgs) {
  const store = dataStore(context);
  const [map, tiles, tilesets] = await Promise.all([
    store.readMap(),
    store.readTiles(),
    store.readTilesets(),
  ]);
  return { map, tiles, tilesets };
}

export default function PlayPage() {
  const { map, tiles, tilesets } = useLoaderData<typeof loader>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Single-player draws no names and hears no speech, but looking is in-world
  // text like the rest of it, so the layer has to exist here too.
  const labelRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<GameRenderer | null>(null);
  const inputRef = useRef<HeldDirections | null>(null);
  const sessionRef = useRef<GameSession | null>(null);
  const pressDirection = useCallback(
    (d: Direction) => inputRef.current?.press(d),
    [],
  );
  const releaseDirection = useCallback(
    (d: Direction) => inputRef.current?.release(d),
    [],
  );
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
  const [minutesOfDay, setMinutesOfDay] = useState<MinutesOfDay>(
    DEFAULT_PLAY_MINUTES,
  );
  const [clockPaused, setClockPaused] = useState(false);
  // Held outside the renderer and the session because the buttons have to show
  // it: a key and a button are two ways into one mode, and only one of them is
  // in a position to know what the other did.
  const { looking, attacking, setLookLatched, setAttacking } = usePlayModes();
  const [lightingEnabled, setLightingEnabled] = useState(true);
  const [stats, setStats] = useState<FrameStats | null>(null);
  const [interactions, setInteractions] = useState<InteractionOption[]>([]);
  const [equipment, setEquipment] = useState<Equipment>(emptyEquipment);
  const [openedContainer, setOpenedContainer] = useState<ItemInstance | null>(
    null,
  );
  // Straight at the renderer, like the hover outline: which box is open is a
  // frame's business, and it is the render loop that knows when its contents
  // changed or when the player walked out of reach of it.
  const openContainer = useCallback(
    (ref: ObjectRef | null) => rendererRef.current?.setOpenedContainer(ref),
    [],
  );
  const minutesRef = useRef(minutesOfDay);
  minutesRef.current = minutesOfDay;
  const pausedRef = useRef(clockPaused);
  pausedRef.current = clockPaused;
  // Read at construction rather than only watched: a renderer built after the
  // toggle was flipped — a hot reload, a map change — must not come up lit.
  const lightingRef = useRef(lightingEnabled);
  lightingRef.current = lightingEnabled;
  // Same, for the session: a map change builds a new one, and a player who had
  // their sword out must not have it quietly put away by an editor save.
  const attackingRef = useRef(attacking);
  attackingRef.current = attacking;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let session: GameSession;
    try {
      session = new GameSession(map, tiles);
    } catch (err) {
      console.error(err);
      return;
    }
    sessionRef.current = session;
    session.setAttackMode(attackingRef.current);

    const renderer = new GameRenderer(
      canvas,
      session,
      tilesets,
      tiles,
      labelRef.current,
    );
    renderer.setMinutesOfDay(minutesRef.current);
    renderer.setClockPaused(pausedRef.current);
    renderer.setLightingEnabled(lightingRef.current);
    renderer.setOnClock(setMinutesOfDay);
    renderer.setOnStats(setStats);
    renderer.setOnInteractions(setInteractions);
    renderer.setOnEquipment(setEquipment);
    renderer.setOnOpenedContainer(setOpenedContainer);
    rendererRef.current = renderer;
    renderer.start();

    const input = new HeldDirections((i) => session.setInput(i));
    inputRef.current = input;
    const unbindKeyboard = bindKeyboard(input);

    return () => {
      unbindKeyboard();
      inputRef.current = null;
      sessionRef.current = null;
      rendererRef.current = null;
      renderer.dispose();
      setStats(null);
      setInteractions([]);
      setEquipment(emptyEquipment());
      setOpenedContainer(null);
    };
  }, [map, tiles, tilesets]);

  useEffect(() => {
    rendererRef.current?.setClockPaused(clockPaused);
  }, [clockPaused]);

  useEffect(() => {
    rendererRef.current?.setLightingEnabled(lightingEnabled);
  }, [lightingEnabled]);

  useEffect(() => {
    rendererRef.current?.setLookMode(looking);
  }, [looking]);

  // At the session rather than the renderer, unlike looking: whether a blow
  // lands is the simulation's business, and the outline colour follows from the
  // snapshot it hands back rather than from a second copy held over here.
  useEffect(() => {
    sessionRef.current?.setAttackMode(attacking);
  }, [attacking]);

  const scrubTime = (m: MinutesOfDay) => {
    setMinutesOfDay(m);
    rendererRef.current?.setMinutesOfDay(m);
  };

  return (
    <AppShell
      // Everything you reach for while *building* — the frame counter, the
      // lighting switch, the hand on the clock. On a phone they fold away and
      // the bar keeps one row for the game.
      menuExtras={
        <>
          <FrameStatsReadout stats={stats} />
          <LightingToggle
            enabled={lightingEnabled}
            onChange={setLightingEnabled}
          />
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
            <label className="flex items-center gap-1.5 text-xs text-paper">
              <input
                type="checkbox"
                checked={clockPaused}
                onChange={(e) => setClockPaused(e.target.checked)}
                className="hard-checkbox"
              />
              Pause
            </label>
          </div>
        </>
      }
      // The hour stays out, on every screen. It is the one readout that is
      // about the world rather than about working on it — it says whether the
      // dark you are looking at is night or a roof — and a reading you have to
      // open a menu to take is not a reading.
      trailing={
        <span
          className="border-2 border-paper/40 px-1.5 py-0.5 text-xs tabular-nums text-paper"
          // Named rather than announced: the hour changes every second, so a
          // live region here would talk over everything else. The label is what
          // the "Time" caption used to be, now that the caption folds away.
          aria-label={`Time of day, ${formatClock(minutesOfDay)}`}
        >
          {formatClock(minutesOfDay)}
        </span>
      }
    >
      <GameViewport
        canvasRef={canvasRef}
        labelRef={labelRef}
        onDirectionPress={pressDirection}
        onDirectionRelease={releaseDirection}
        looking={looking}
        onLookingChange={setLookLatched}
        attacking={attacking}
        onAttackingChange={setAttacking}
        interactions={interactions}
        onInteract={act}
        onHoverInteraction={hoverInteraction}
        equipment={equipment}
        openedContainer={openedContainer}
        onOpenContainer={openContainer}
        tiles={tiles}
        tilesets={tilesets}
      />
    </AppShell>
  );
}
