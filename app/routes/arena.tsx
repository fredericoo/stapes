import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLoaderData } from "react-router";
import { AppShell } from "../components/AppShell";
import { ArenaFighterPanel } from "../components/ArenaFighterPanel";
import { ArenaMetrics } from "../components/ArenaMetrics";
import { type Floater, ArenaStage, type StageSide } from "../components/ArenaStage";
import {
  type ArenaFighter,
  battlerTiles,
  fighterForTile,
  swingsOf,
} from "../game/arena";
import { swingOdds } from "../game/combatMetrics";
import { DAMAGE_NUMBER_LIFETIME_MS, TICK_MS } from "../game/constants";
import { type DuelEvent, Duel, opponentOf, type Side, SIDES } from "../game/duel";
import { Rng } from "../game/rng";
import { fetchBootstrap } from "../lib/api";
import type { FightingStats } from "../lib/battler";
import { isRanged } from "../lib/item";
import { type StatusDef, statusesById } from "../lib/status";
import type { TileDef } from "../lib/types";
import { Button, Input, Segmented } from "../ui";

/**
 * The combat simulator: two bodies, no world, and the arithmetic on the table.
 *
 * **A balancing instrument rather than a game screen.** Every other way to find
 * out what a weapon is worth involves walking somewhere and fighting something,
 * which folds the answer together with the terrain, the brain that was driving
 * the thing and whether it happened to be standing on a crate. None of those are
 * balance, and all of them are noise in the measurement. So the premise here is
 * fixed and stated: the two are a cell apart, on one floor, facing each other,
 * both in reach, with nothing in the way and nobody walking away.
 *
 * Two halves, and the order on the page is the order they are worth reading in:
 *
 * - **The table is exact.** `../game/combatMetrics` works the odds out in closed
 *   form over the same curves blows are struck on, so a point of accuracy moves
 *   a figure by exactly what a point of accuracy is worth. It is the thing to
 *   tune against.
 * - **The fight is one sample.** `../game/duel` is the loop the session runs,
 *   tick for tick and draw for draw. What it adds is the shape of a fight —
 *   whether the axe's first blow decides it, whether the rat ever gets a second
 *   swing — which is a question about a sequence and cannot be read off a mean.
 *
 * The seed is on the page for the same reason it is in the world: a fight
 * somebody watched and wants to ask about has to be the same fight when they
 * run it again.
 *
 * ## Nothing on this page describes a formula in words
 *
 * The premise used to be stated in a paragraph at the top and every metric had a
 * tooltip explaining the curve behind it. Both are gone. A sentence describing
 * arithmetic is a second copy of that arithmetic which no test fails when the
 * first one is tuned — and this page exists precisely to be trusted *while* the
 * curves are moving. Every string it renders is a label, a slot name, or a
 * number that came out of a function; the reasoning lives in the modules that
 * have to stay true to it.
 */

export async function clientLoader() {
  return await fetchBootstrap();
}

/** Real time per simulated second. The extremes are for different questions. */
const SPEEDS = [0.25, 0.5, 1, 2, 4] as const;

/**
 * Most ticks one animation frame may run.
 *
 * A tab left in the background hands back a gap of minutes, and stepping the
 * whole of it in one frame would run a fight to its end between two paints —
 * the one thing a *watched* fight must not do. The same bound
 * `GameSession.update` keeps, and for the same reason.
 */
const MAX_TICKS_PER_FRAME = 10;

/** How much of the log is kept. Older than this is scrollback nobody reads. */
const MAX_LOG_ENTRIES = 200;

type LogEntry = {
  id: number;
  atMs: number;
  text: string;
  tone: Floater["tone"] | "death";
};

type Lean = { atMs: number | null; kind: "swing" | "dodge" };

/**
 * Everything the page draws, published once per frame.
 *
 * A snapshot rather than reading the `Duel` during render, because the duel is a
 * mutable object stepped inside an animation frame: React would be reading a
 * value that changes underneath it, and a fight drawn half a tick apart from
 * itself is exactly the kind of bug that only shows up as a number that looked
 * wrong once.
 */
type Snapshot = {
  elapsedMs: number;
  hp: Record<Side, number>;
  maxHp: Record<Side, number>;
  ailments: Record<Side, string[]>;
  lean: Record<Side, Lean>;
  floaters: Floater[];
  log: LogEntry[];
  winner: Side | null;
  finished: boolean;
};

const NO_LEAN: Lean = { atMs: null, kind: "swing" };

function emptySnapshot(): Snapshot {
  return {
    elapsedMs: 0,
    hp: { a: 0, b: 0 },
    maxHp: { a: 0, b: 0 },
    ailments: { a: [], b: [] },
    lean: { a: NO_LEAN, b: NO_LEAN },
    floaters: [],
    log: [],
    winner: null,
    finished: false,
  };
}

export default function ArenaPage() {
  const { tiles, tilesets, statuses } = useLoaderData<typeof clientLoader>();
  const tilesById = useMemo(
    () => Object.fromEntries(tiles.map((tile) => [tile.id, tile])),
    [tiles],
  );
  // Compiled once per load rather than per render: `statusesById` parses every
  // formula in the catalogue, and the fight asks for it on every tick a status
  // is running.
  const statusDefs = useMemo(() => statusesById(statuses), [statuses]);
  const battlers = useMemo(() => battlerTiles(tiles), [tiles]);

  const [a, setA] = useState<ArenaFighter>(() =>
    fighterForTile(battlers[0]?.id ?? "", tilesById),
  );
  const [b, setB] = useState<ArenaFighter>(() =>
    fighterForTile(battlers[1]?.id ?? battlers[0]?.id ?? "", tilesById),
  );
  const [seed, setSeed] = useState(1);
  const [speed, setSpeed] = useState<number>(1);
  const [playing, setPlaying] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);

  // Every blow each side throws, in the order its hands take turns — one entry
  // for the overwhelmingly common one-weapon body, two for a body fighting with
  // both. The duel alternates through them exactly as the world does.
  const swingsA = useMemo(() => swingsOf(a, tilesById), [a, tilesById]);
  const swingsB = useMemo(() => swingsOf(b, tilesById), [b, tilesById]);
  // The opening blow, which is what the odds row and the readouts quote.
  const statsA = swingsA[0] ?? null;
  const statsB = swingsB[0] ?? null;
  const names = useMemo(
    () => ({
      a: tilesById[a.tileId]?.name ?? a.tileId,
      b: tilesById[b.tileId]?.name ?? b.tileId,
    }),
    [a.tileId, b.tileId, tilesById],
  );

  const runtime = useRef<Runtime | null>(null);
  const publish = useCallback(() => {
    const current = runtime.current;
    if (current) setSnapshot(current.snapshot(statusDefs));
  }, [statusDefs]);

  /**
   * A fresh fight whenever what is being fought changes.
   *
   * Setup-driven rather than a button, because a figure on the table and a fight
   * on the stage that came from different loadouts is the one state this page
   * must never be in — somebody edits a mastery mid-fight and reads the rest of
   * the bout as though it had been fought that way.
   */
  useEffect(() => {
    setPlaying(false);
    runtime.current =
      statsA && statsB
        ? new Runtime(swingsA, swingsB, seed, statusDefs, names)
        : null;
    setSnapshot(runtime.current?.snapshot(statusDefs) ?? emptySnapshot());
  }, [statsA, statsB, swingsA, swingsB, seed, statusDefs, names]);

  useEffect(() => {
    if (!playing) return;
    const current = runtime.current;
    if (!current) return;

    let frame = 0;
    let lastAt = performance.now();
    const tick = (now: number) => {
      // Scaled here rather than by changing the tick length: the simulation runs
      // at one fixed rate and always will — what a speed control changes is how
      // much of it a second of watching is worth.
      current.advance((now - lastAt) * speed);
      lastAt = now;
      publish();
      if (current.finished) {
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, publish]);

  const step = () => {
    setPlaying(false);
    runtime.current?.step();
    publish();
  };

  const restart = () => {
    setPlaying(false);
    if (statsA && statsB) {
      runtime.current = new Runtime(swingsA, swingsB, seed, statusDefs, names);
    }
    publish();
  };

  const ready = statsA !== null && statsB !== null;

  return (
    <AppShell>
      <div className="flex h-full flex-col gap-3 overflow-auto p-3">
        <div className="flex flex-wrap items-center gap-2 border-2 border-border bg-panel p-2">
          <Button
            size="sm"
            onClick={() => setPlaying((was) => !was)}
            disabled={!ready || snapshot.finished}
          >
            {playing ? "Pause" : "Play"}
          </Button>
          <Button size="sm" onClick={step} disabled={!ready || snapshot.finished}>
            Step
          </Button>
          <Button size="sm" onClick={restart} disabled={!ready}>
            Restart
          </Button>
          <Segmented
            value={speed}
            onChange={setSpeed}
            ariaLabel="Playback speed"
            size="sm"
            options={SPEEDS.map((rate) => ({ value: rate as number, label: `${rate}×` }))}
          />
          <label className="ml-auto flex items-center gap-2 text-xs">
            <span className="font-bold uppercase text-muted">Seed</span>
            <Input
              type="number"
              className="w-24"
              aria-label="Seed"
              value={seed}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isFinite(next)) setSeed(Math.trunc(next));
              }}
            />
          </label>
          <Button size="sm" onClick={() => setSeed((last) => last + 1)}>
            Next fight
          </Button>
        </div>

        <ArenaStage
          a={stageSide(a, snapshot, "a", tilesById, names.a)}
          b={stageSide(b, snapshot, "b", tilesById, names.b)}
          tilesets={tilesets}
          floaters={snapshot.floaters}
          elapsedMs={snapshot.elapsedMs}
          winner={snapshot.winner}
        />

        <div className="grid gap-3 lg:grid-cols-[1fr_1fr]">
          <ArenaMetrics
            aName={names.a}
            bName={names.b}
            aToB={statsA && statsB ? swingOdds(statsA, statsB) : null}
            bToA={statsA && statsB ? swingOdds(statsB, statsA) : null}
          />
          <CombatLog entries={snapshot.log} />
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <ArenaFighterPanel
            title="Side A"
            fighter={a}
            onChange={setA}
            tiles={tiles}
            tilesById={tilesById}
            tilesets={tilesets}
            battlers={battlers}
          />
          <ArenaFighterPanel
            title="Side B"
            fighter={b}
            onChange={setB}
            tiles={tiles}
            tilesById={tilesById}
            tilesets={tilesets}
            battlers={battlers}
          />
        </div>
      </div>
    </AppShell>
  );
}

function stageSide(
  fighter: ArenaFighter,
  snapshot: Snapshot,
  side: Side,
  tilesById: Record<string, TileDef>,
  name: string,
): StageSide {
  return {
    tile: tilesById[fighter.tileId] ?? null,
    name,
    hp: snapshot.hp[side],
    maxHp: snapshot.maxHp[side],
    ailments: snapshot.ailments[side],
    leanAtMs: snapshot.lean[side].atMs,
    leanKind: snapshot.lean[side].kind,
  };
}

/**
 * The fight in reverse, newest first.
 *
 * Newest at the top rather than at the bottom with a scroll chasing it: the line
 * somebody wants is always the one that just happened, and a log that has to be
 * scrolled to stay current is one that is wrong every time a frame is dropped.
 */
function CombatLog({ entries }: { entries: readonly LogEntry[] }) {
  return (
    <div className="flex max-h-80 min-h-32 flex-col overflow-hidden border-2 border-border bg-panel">
      <h2 className="border-b-2 border-border bg-ink px-2 py-1 text-xs font-bold uppercase text-paper">
        Blow by blow
      </h2>
      <ol className="flex-1 overflow-auto p-1 text-xs">
        {entries.length === 0 ? (
          <li className="p-1 text-muted">Nothing yet. Press play.</li>
        ) : null}
        {entries.map((entry) => (
          <li
            key={entry.id}
            className={`flex gap-2 px-1 py-0.5 tabular-nums ${LOG_TONE[entry.tone]}`}
          >
            <span className="w-12 shrink-0 text-right text-muted">
              {(entry.atMs / 1000).toFixed(1)}s
            </span>
            <span className="min-w-0">{entry.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const LOG_TONE: Record<LogEntry["tone"], string> = {
  damage: "text-ink",
  miss: "text-muted",
  ailment: "text-reward",
  heal: "text-accent",
  death: "font-bold text-danger",
};

/**
 * The fight, plus everything the page needs to draw it that the fight itself has
 * no opinion about.
 *
 * A class beside the component rather than state inside it, because all of this
 * changes on a simulation tick and none of it should cost a React render on its
 * own: a fight at 4× runs forty ticks a second, and a `setState` per event would
 * be forty renders where one per frame is what a screen can show. The component
 * asks for a {@link Snapshot} once a frame and draws that.
 */
class Runtime {
  private readonly duel: Duel;
  private readonly floaters: Floater[] = [];
  private readonly log: LogEntry[] = [];
  private readonly lean: Record<Side, Lean> = { a: NO_LEAN, b: NO_LEAN };
  /** Sim time owed but not yet stepped — a tick is indivisible. */
  private owedMs = 0;
  private nextId = 0;

  constructor(
    swingsA: readonly FightingStats[],
    swingsB: readonly FightingStats[],
    seed: number,
    statusDefs: Record<string, StatusDef>,
    /**
     * What to call each side in the log.
     *
     * Names rather than "A" and "B", because the log is the one place the fight
     * is written down in sentences — and a line reading "A → B −4" asks the
     * reader to hold which of the two was which while they read it.
     */
    private readonly names: Record<Side, string>,
  ) {
    this.duel = new Duel(
      { swings: swingsA },
      { swings: swingsB },
      new Rng(seed),
      { statusDefs },
    );
  }

  get finished(): boolean {
    return this.duel.finished;
  }

  /** Step one tick, whatever the clock says. What the Step button does. */
  step() {
    if (this.duel.finished) return;
    this.consume(this.duel.tick());
  }

  /** Run whatever the last frame was worth, a whole tick at a time. */
  advance(elapsedMs: number) {
    this.owedMs += Math.max(0, elapsedMs);
    let budget = MAX_TICKS_PER_FRAME;
    while (this.owedMs >= TICK_MS && budget > 0 && !this.duel.finished) {
      this.owedMs -= TICK_MS;
      budget--;
      this.consume(this.duel.tick());
    }
    // A frame that could not keep up drops what it could not run rather than
    // banking it: a backlog paid off on the next frame is a fight that speeds up
    // to catch itself, which is the opposite of watching one.
    if (budget === 0) this.owedMs = 0;
  }

  private consume(events: readonly DuelEvent[]) {
    for (const event of events) {
      if (event.kind === "swing") this.noteSwing(event);
      else if (event.kind === "ailment") this.noteAilment(event);
      else this.note(`${this.names[event.side]} falls`, "death");
    }
  }

  private noteSwing(event: Extract<DuelEvent, { kind: "swing" }>) {
    const by = event.by;
    const at = opponentOf(by);
    const arrow = `${this.names[by]} → ${this.names[at]}`;

    // A ranged weapon never leans: what it throws is the arrow. The same gate
    // `swingToward` puts on it, asked of the weapon rather than of the distance.
    if (!isRanged(this.duel.statsOf(by))) {
      this.lean[by] = { atMs: this.duel.elapsedMs, kind: "swing" };
    }

    if (event.outcome.missed) {
      this.float(at, "miss", "miss");
      this.note(`${arrow} missed`, "miss");
      return;
    }
    if (event.outcome.dodged) {
      // No number floats. The hop is the whole account of a dodge — a word
      // beside it would be the same event told twice.
      this.lean[at] = { atMs: this.duel.elapsedMs, kind: "dodge" };
      this.note(`${arrow} dodged (worth ${event.outcome.potentialDamage})`, "miss");
      return;
    }

    const damage = event.outcome.damage;
    this.float(at, damage === 0 ? "miss" : "damage", String(damage));
    const absorbed =
      damage === 0 ? ` (armour ate ${event.outcome.potentialDamage})` : "";
    this.note(`${arrow} −${damage}${absorbed} → ${event.hpLeft} hp`, damage === 0 ? "miss" : "damage");

    for (const grant of event.outcome.inflicted) {
      this.note(`${arrow} inflicted ${grant.id}`, "ailment");
    }
  }

  private noteAilment(event: Extract<DuelEvent, { kind: "ailment" }>) {
    const tone = event.hp < 0 ? "ailment" : "heal";
    const sign = event.hp < 0 ? "−" : "+";
    this.float(event.on, tone, `${sign}${Math.abs(event.hp)}`);
    this.note(
      `${this.names[event.on]} ${sign}${Math.abs(event.hp)} from ${event.defId} → ${event.hpLeft} hp`,
      tone,
    );
  }

  private float(side: Side, tone: Floater["tone"], text: string) {
    this.floaters.push({
      id: this.nextId++,
      side,
      text,
      tone,
      bornAtMs: this.duel.elapsedMs,
    });
  }

  private note(text: string, tone: LogEntry["tone"]) {
    this.log.unshift({
      id: this.nextId++,
      atMs: this.duel.elapsedMs,
      text,
      tone,
    });
    if (this.log.length > MAX_LOG_ENTRIES) this.log.length = MAX_LOG_ENTRIES;
  }

  /** What the page should draw right now. */
  snapshot(statusDefs: Record<string, StatusDef>): Snapshot {
    const elapsedMs = this.duel.elapsedMs;
    // Aged here rather than on a clock of their own, so a paused fight holds its
    // numbers in the air instead of losing them to real time nobody is spending.
    const alive = this.floaters.filter(
      (floater) => elapsedMs - floater.bornAtMs < DAMAGE_NUMBER_LIFETIME_MS,
    );
    this.floaters.length = 0;
    this.floaters.push(...alive);

    const hp = { a: 0, b: 0 };
    const maxHp = { a: 0, b: 0 };
    const ailments: Record<Side, string[]> = { a: [], b: [] };
    for (const side of SIDES) {
      hp[side] = this.duel.fighter(side).hp;
      maxHp[side] = this.duel.statsOf(side).maxHp;
      ailments[side] = this.duel
        .fighter(side)
        .statuses.map((status) => statusDefs[status.defId]?.name ?? status.defId);
    }

    return {
      elapsedMs,
      hp,
      maxHp,
      ailments,
      lean: { a: this.lean.a, b: this.lean.b },
      floaters: alive,
      log: [...this.log],
      winner: this.duel.winner,
      finished: this.duel.finished,
    };
  }
}
