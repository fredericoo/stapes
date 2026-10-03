import type { StatusDef } from "../lib/status";
import {
  type BattleOptions,
  type Catalogue,
  type FightEnd,
  fightOn,
  pairingOn,
  round,
} from "./battle";
import { opponent, type SideSpec, type Subject, SUBJECTS } from "./sides";

export type TraceSide = {
  spec: string;
  name: string;
  loadout: string;
  hands: string[];
  maxHp: number;
};

export type TraceEvent =
  | {
      atSeconds: number;
      kind: "swing";
      by: Subject;
      hand: string;
      outcome: "hit" | "missed" | "dodged" | "absorbed";
      damage: number;
      worth: number;
      inflicts: string[];
      target: Subject;
      hpLeft: number;
    }
  | {
      atSeconds: number;
      kind: "ailment";
      on: Subject;
      statusId: string;
      hp: number;
      hpLeft: number;
    }
  | { atSeconds: number; kind: "statuses"; on: Subject; gained: string[]; lost: string[] }
  | { atSeconds: number; kind: "falls"; on: Subject };

export type TraceReport = {
  statuses: boolean;
  kit: BattleOptions["kit"];
  maxSeconds: number;
  a: TraceSide;
  b: TraceSide;
  end: FightEnd;
  seconds: number;
  events: TraceEvent[];
};

/** The fight the batch counts first for this seed: A on side `a` of the `Duel`. */
export function traceBattle(
  sides: Record<Subject, SideSpec>,
  catalogue: Catalogue,
  options: Omit<BattleOptions, "seeds">,
): TraceReport {
  const pairing = pairingOn(sides, options.seed, options.kit, catalogue.tilesById);
  const statusDefs: Record<string, StatusDef> | undefined = options.statuses
    ? catalogue.statusDefs
    : undefined;
  const events: TraceEvent[] = [];
  const held: Record<Subject, readonly string[]> = { A: [], B: [] };

  const { end, seconds } = fightOn(
    pairing,
    "a",
    options.seed,
    statusDefs,
    options.maxSeconds,
    (tick) => {
      const atSeconds = round(tick.atMs / 1000, 3);
      for (const event of tick.events) {
        if (event.kind === "swing") {
          const { outcome } = event;
          events.push({
            atSeconds,
            kind: "swing",
            by: event.by,
            hand: pairing.hands[event.by][event.hand] ?? "?",
            outcome: outcome.missed
              ? "missed"
              : outcome.dodged
                ? "dodged"
                : outcome.damage === 0
                  ? "absorbed"
                  : "hit",
            damage: outcome.damage,
            worth: outcome.potentialDamage,
            inflicts: outcome.inflicted.map((grant) => grant.id),
            target: opponent(event.by),
            hpLeft: event.hpLeft,
          });
        } else if (event.kind === "ailment") {
          events.push({ atSeconds, ...event });
        } else {
          events.push({ atSeconds, kind: "falls", on: event.on });
        }
      }
      for (const subject of SUBJECTS) {
        const now = tick.statuses[subject];
        const gained = now.filter((statusId) => !held[subject].includes(statusId));
        const lost = held[subject].filter((statusId) => !now.includes(statusId));
        if (gained.length > 0 || lost.length > 0) {
          events.push({ atSeconds, kind: "statuses", on: subject, gained, lost });
        }
        held[subject] = now;
      }
    },
  );

  const side = (subject: Subject): TraceSide => ({
    spec: sides[subject].text,
    name: catalogue.tilesById[sides[subject].tileId]?.name ?? sides[subject].tileId,
    loadout: pairing.loadouts[subject],
    hands: pairing.hands[subject],
    maxHp: pairing.setups[subject].swings[0]!.maxHp,
  });

  return {
    statuses: options.statuses,
    kit: options.kit,
    maxSeconds: options.maxSeconds,
    a: side("A"),
    b: side("B"),
    end,
    seconds: round(seconds, 3),
    events,
  };
}
