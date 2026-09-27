import { duelSetupOf, swingNamesOf } from "../game/arena";
import type { AttackOutcome } from "../game/combat";
import { rotationOdds, type RotationOdds, type SwingOdds } from "../game/combatMetrics";
import { TICK_MS } from "../game/constants";
import { type DuelSetup, type Side, SIDES } from "../game/duel";
import { Rng } from "../game/rng";
import { COMBAT_STATUS_ID, type StatusDef } from "../lib/status";
import type { TileDef } from "../lib/types";
import { runDuel } from "./duel";
import {
  fighterOn,
  type Kit,
  loadoutOf,
  opponent,
  type SideSpec,
  type Subject,
  SUBJECTS,
} from "./sides";

export type BattleOptions = {
  seeds: number;
  seed: number;
  statuses: boolean;
  kit: Kit;
  maxSeconds: number;
};

export type Catalogue = {
  tilesById: Record<string, TileDef>;
  statusDefs: Record<string, StatusDef>;
};

export type Rate = { count: number; share: number; low: number; high: number };

export type Spread = { fights: number; mean: number; p50: number; p95: number };

export type HandRates = { hit: number; missed: number; dodged: number; absorbed: number };

export type HandReport = {
  key: string;
  side: Subject;
  hand: string;
  swings: number;
  sampled: HandRates;
  closedForm: HandRates;
};

export type SideReport = {
  spec: string;
  name: string;
  loadouts: Record<string, number>;
  timeToKill: Spread | null;
  damagePerSecond: { sampled: number; blows: number; statuses: number };
  closedForm: {
    attacksPerSecond: number;
    damagePerSecond: number;
    secondsToKill: number | null;
  };
  statusUptime: Record<string, number>;
};

export type BattleReport = {
  seeds: number;
  fights: number;
  statuses: boolean;
  kit: Kit;
  maxSeconds: number;
  outcomes: { wins: Rate; losses: Rate; draws: Rate; undecided: Rate };
  a: SideReport;
  b: SideReport;
  hands: HandReport[];
};

export type Pairing = {
  setups: Record<Subject, DuelSetup>;
  hands: Record<Subject, string[]>;
  loadouts: Record<Subject, string>;
  odds: Record<Subject, RotationOdds>;
};

export function pairingOn(
  sides: Record<Subject, SideSpec>,
  seed: number,
  kit: Kit,
  tilesById: Record<string, TileDef>,
  odds: Map<string, Record<Subject, RotationOdds>> = new Map(),
): Pairing {
  const a = fighterOn(sides.A, "A", seed, kit, tilesById);
  const b = fighterOn(sides.B, "B", seed, kit, tilesById);
  const setups = { A: duelSetupOf(a, tilesById), B: duelSetupOf(b, tilesById) };
  const loadouts = { A: loadoutOf(a), B: loadoutOf(b) };
  const key = `${loadouts.A}\u0000${loadouts.B}`;
  let pairOdds = odds.get(key);
  if (!pairOdds) {
    pairOdds = {
      A: rotationOdds(setups.A.swings, setups.B.swings[0]!),
      B: rotationOdds(setups.B.swings, setups.A.swings[0]!),
    };
    odds.set(key, pairOdds);
  }
  return {
    setups,
    hands: { A: swingNamesOf(a, tilesById), B: swingNamesOf(b, tilesById) },
    loadouts,
    odds: pairOdds,
  };
}

export type FightEnd = "A" | "B" | "draw" | "undecided";

export type FightEvent =
  | { kind: "swing"; by: Subject; hand: number; outcome: AttackOutcome; hpLeft: number }
  | { kind: "ailment"; on: Subject; statusId: string; hp: number; hpLeft: number }
  | { kind: "death"; on: Subject };

export type FightTick = {
  atMs: number;
  events: readonly FightEvent[];
  statuses: Record<Subject, readonly string[]>;
};

const NONE_HELD: readonly string[] = [];

/**
 * Fights one seed with A on side `a` or on side `b` of the `Duel`. The side
 * letters matter because `Duel` rolls `a`'s blow first on a shared tick, which
 * is why every seed is fought both ways round.
 */
export function fightOn(
  pairing: Pairing,
  aOn: Side,
  seed: number,
  statusDefs: Record<string, StatusDef> | undefined,
  maxSeconds: number,
  watch: (tick: FightTick) => void = () => {},
): { end: FightEnd; seconds: number } {
  const subjectOn = (side: Side): Subject => (side === aOn ? "A" : "B");
  const first = pairing.setups[subjectOn("a")];
  const second = pairing.setups[subjectOn("b")];
  let finished = false;
  const result = runDuel(first, second, new Rng(seed), {
    statusDefs,
    maxTicks: Math.max(1, Math.round((maxSeconds * 1000) / TICK_MS)),
    watch: (events, duel) => {
      const statuses = { A: NONE_HELD, B: NONE_HELD };
      for (const side of SIDES) {
        const held = duel.fighter(side).statuses;
        if (held.length === 0) continue;
        statuses[subjectOn(side)] = held
          .map((status) => status.defId)
          .filter((statusId) => statusId !== COMBAT_STATUS_ID);
      }
      watch({
        atMs: duel.elapsedMs,
        statuses,
        events: events.map((event): FightEvent => {
          if (event.kind === "swing") {
            const fighter = duel.fighter(event.by);
            const hand = (fighter.nextSwing - 1) % fighter.swings.length;
            return { ...event, by: subjectOn(event.by), hand };
          }
          if (event.kind === "ailment") {
            return { ...event, on: subjectOn(event.on), statusId: event.defId };
          }
          return { kind: "death", on: subjectOn(event.side) };
        }),
      });
      finished = duel.finished;
    },
  });
  const seconds = (result.ticks * TICK_MS) / 1000;
  if (result.winner) return { end: subjectOn(result.winner), seconds };
  return { end: finished ? "draw" : "undecided", seconds };
}

const Z_95 = 1.96;

/**
 * The Wilson score interval, which stays inside 0–1 and keeps a width when a
 * side wins every fight or none.
 */
export function rate(count: number, total: number): Rate {
  if (total === 0) return { count, share: 0, low: 0, high: 0 };
  const share = count / total;
  const z2 = Z_95 * Z_95;
  const centre = (share + z2 / (2 * total)) / (1 + z2 / total);
  const half =
    (Z_95 * Math.sqrt((share * (1 - share)) / total + z2 / (4 * total * total))) / (1 + z2 / total);
  return {
    count,
    share: round(share),
    low: round(Math.max(0, centre - half)),
    high: round(Math.min(1, centre + half)),
  };
}

export function spread(samples: readonly number[]): Spread | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((x, y) => x - y);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
  const total = sorted.reduce((sum, x) => sum + x, 0);
  return {
    fights: sorted.length,
    mean: round(total / sorted.length),
    p50: round(at(0.5)),
    p95: round(at(0.95)),
  };
}

export function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

type HandTally = {
  side: Subject;
  hand: string;
  swings: number;
  sampled: HandRates;
  closedForm: HandRates;
};

type SideTally = {
  kills: number[];
  blows: number;
  statuses: number;
  uptimeMs: Map<string, number>;
  loadouts: Map<string, number>;
  closedForm: { attacksPerSecond: number; damagePerSecond: number; secondsToKill: number[] };
};

function sideTally(): SideTally {
  return {
    kills: [],
    blows: 0,
    statuses: 0,
    uptimeMs: new Map(),
    loadouts: new Map(),
    closedForm: { attacksPerSecond: 0, damagePerSecond: 0, secondsToKill: [] },
  };
}

function noRates(): HandRates {
  return { hit: 0, missed: 0, dodged: 0, absorbed: 0 };
}

function addOdds(into: HandRates, odds: SwingOdds) {
  into.missed += odds.missed;
  into.dodged += odds.dodged;
  into.absorbed += odds.absorbed;
  into.hit += odds.wounded;
}

function addOutcome(into: HandRates, outcome: AttackOutcome) {
  if (outcome.missed) into.missed++;
  else if (outcome.dodged) into.dodged++;
  else if (outcome.damage === 0) into.absorbed++;
  else into.hit++;
}

function shares(rates: HandRates, swings: number): HandRates {
  const of = (count: number) => (swings === 0 ? 0 : round(count / swings));
  return {
    hit: of(rates.hit),
    missed: of(rates.missed),
    dodged: of(rates.dodged),
    absorbed: of(rates.absorbed),
  };
}

export function runBattle(
  sides: Record<Subject, SideSpec>,
  catalogue: Catalogue,
  options: BattleOptions,
): BattleReport {
  const { tilesById } = catalogue;
  const statusDefs = options.statuses ? catalogue.statusDefs : undefined;
  const tally = { A: sideTally(), B: sideTally() };
  const hands = new Map<string, HandTally>();
  const odds = new Map<string, Record<Subject, RotationOdds>>();
  const ends = { A: 0, B: 0, draw: 0, undecided: 0 };
  let fights = 0;
  let totalSeconds = 0;

  for (let i = 0; i < options.seeds; i++) {
    const seed = options.seed + i;
    const pairing = pairingOn(sides, seed, options.kit, tilesById, odds);
    for (const subject of SUBJECTS) {
      const loadouts = tally[subject].loadouts;
      loadouts.set(pairing.loadouts[subject], (loadouts.get(pairing.loadouts[subject]) ?? 0) + 2);
    }

    for (const aOn of SIDES) {
      const { end, seconds } = fightOn(
        pairing,
        aOn,
        seed,
        statusDefs,
        options.maxSeconds,
        (tick) => {
          for (const event of tick.events) {
            if (event.kind === "swing") {
              const name = pairing.hands[event.by][event.hand] ?? "?";
              const key = `${event.by} · ${name}`;
              let counted = hands.get(key);
              if (!counted) {
                counted = {
                  side: event.by,
                  hand: name,
                  swings: 0,
                  sampled: noRates(),
                  closedForm: noRates(),
                };
                hands.set(key, counted);
              }
              counted.swings++;
              addOutcome(counted.sampled, event.outcome);
              addOdds(counted.closedForm, pairing.odds[event.by].swings[event.hand]!);
              tally[event.by].blows += event.outcome.damage;
            } else if (event.kind === "ailment" && event.hp < 0) {
              tally[opponent(event.on)].statuses -= event.hp;
            }
          }
          for (const subject of SUBJECTS) {
            const uptime = tally[subject].uptimeMs;
            for (const statusId of tick.statuses[subject]) {
              uptime.set(statusId, (uptime.get(statusId) ?? 0) + TICK_MS);
            }
          }
        },
      );
      fights++;
      totalSeconds += seconds;
      ends[end]++;
      if (end === "A" || end === "B") tally[end].kills.push(seconds);
      for (const subject of SUBJECTS) {
        const closed = pairing.odds[subject];
        tally[subject].closedForm.attacksPerSecond += closed.attacksPerSecond;
        tally[subject].closedForm.damagePerSecond += closed.damagePerSecond;
        if (closed.secondsToKill !== null) {
          tally[subject].closedForm.secondsToKill.push(closed.secondsToKill);
        }
      }
    }
  }

  const sideReport = (subject: Subject): SideReport => {
    const counted = tally[subject];
    const def = tilesById[sides[subject].tileId];
    const perSecond = (amount: number) => (totalSeconds === 0 ? 0 : round(amount / totalSeconds));
    const killTimes = counted.closedForm.secondsToKill;
    return {
      spec: sides[subject].text,
      name: def?.name ?? sides[subject].tileId,
      loadouts: Object.fromEntries(
        [...counted.loadouts]
          .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
          .map(([loadout, times]) => [loadout, round(times / fights)]),
      ),
      timeToKill: spread(counted.kills),
      damagePerSecond: {
        sampled: perSecond(counted.blows + counted.statuses),
        blows: perSecond(counted.blows),
        statuses: perSecond(counted.statuses),
      },
      closedForm: {
        attacksPerSecond: round(counted.closedForm.attacksPerSecond / fights),
        damagePerSecond: round(counted.closedForm.damagePerSecond / fights),
        secondsToKill:
          killTimes.length === fights
            ? round(killTimes.reduce((sum, x) => sum + x, 0) / fights)
            : null,
      },
      statusUptime: Object.fromEntries(
        [...counted.uptimeMs]
          .sort((x, y) => x[0].localeCompare(y[0]))
          .map(([statusId, ms]) => [statusId, round(ms / 1000 / totalSeconds)]),
      ),
    };
  };

  return {
    seeds: options.seeds,
    fights,
    statuses: options.statuses,
    kit: options.kit,
    maxSeconds: options.maxSeconds,
    outcomes: {
      wins: rate(ends.A, fights),
      losses: rate(ends.B, fights),
      draws: rate(ends.draw, fights),
      undecided: rate(ends.undecided, fights),
    },
    a: sideReport("A"),
    b: sideReport("B"),
    hands: [...hands.entries()]
      .sort((x, y) => x[1].side.localeCompare(y[1].side) || y[1].swings - x[1].swings)
      .map(([key, counted]) => ({
        key,
        side: counted.side,
        hand: counted.hand,
        swings: counted.swings,
        sampled: shares(counted.sampled, counted.swings),
        closedForm: shares(counted.closedForm, counted.swings),
      })),
  };
}
