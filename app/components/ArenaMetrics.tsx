import type { SwingOdds } from "../game/combatMetrics";
import { Tooltip } from "../ui";

/**
 * What the match-up comes to, before anybody swings.
 *
 * **The instrument, where the fight below it is the anecdote.** One duel tells
 * you what happened once; this tells you what will happen, and it is exact
 * rather than sampled — see `../game/combatMetrics`. That is the difference
 * between a tool you can tune against and one you argue with: move a weapon's
 * accuracy by a point and every figure here moves by exactly what that point is
 * worth.
 *
 * Read as two columns because a fight is not symmetric: what the rat's bite is
 * worth against your armour and what your sword is worth against its hide are
 * different questions with different answers, and putting them side by side is
 * the whole point of the page.
 */

type Row = {
  label: string;
  /** What the number means, which for most of these is not guessable. */
  hint: string;
  value: (odds: SwingOdds) => string;
  /** Sets this row apart as a headline rather than a component of one. */
  emphasis?: boolean;
};

const percent = (share: number) => `${(share * 100).toFixed(1)}%`;
const round = (value: number, places = 1) => value.toFixed(places);
const orNever = (value: number | null, format: (v: number) => string) =>
  value === null ? "never" : format(value);

const ROWS: Row[] = [
  {
    label: "Attacks / sec",
    hint:
      "Speed is geometric between 6 and 600 ticks, so the stat says nothing about the rate on its own. This is the rate.",
    value: (odds) =>
      `${round(odds.attacksPerSecond, 2)} (${Math.round(odds.intervalMs)}ms)`,
  },
  {
    label: "Miss",
    hint:
      "The attacker's own failure: the weapon's accuracy times how well its wielder meets what it asks. Earns nobody anything.",
    value: (odds) => percent(odds.missed),
  },
  {
    label: "Dodge (of aimed)",
    hint:
      "What the defender's Agility is actually worth: the share of properly-aimed blows they get out of the way of. Evasion contested against the attacker's accuracy on a logistic curve, so the same Agility is worth less against a precise weapon. Never certain either way — nothing in a fight leaves the 5–95% band.",
    value: (odds) => percent(odds.dodgeWhenAimed),
  },
  {
    label: "Dodge (of all)",
    hint:
      "The same dodges counted over every swing, misses included. Lower than the figure above, and the one that belongs in a damage-per-second sum rather than in a judgement about Agility.",
    value: (odds) => percent(odds.dodged),
  },
  {
    label: "Connect",
    hint: "Swings that reached a body. Miss, dodge and connect account for every swing exactly once.",
    value: (odds) => percent(odds.connected),
  },
  {
    label: "Absorbed",
    hint:
      "There is no block roll. Defence is a flat subtraction, so this is the share of swings that landed and came to nothing because armour was worth the whole blow.",
    value: (odds) => percent(odds.absorbed),
  },
  {
    label: "Wound",
    hint: "Swings that actually took hit points off — connect, less what armour swallowed whole.",
    value: (odds) => percent(odds.wounded),
  },
  {
    label: "Damage range",
    hint:
      "A connecting blow after defence, at both ends of the band. Variance widens the band downward only: the top is always the weapon's full damage.",
    value: (odds) => `${odds.minDamage}–${odds.maxDamage}`,
  },
  {
    label: "Mean blow",
    hint:
      "Average of a connecting blow after defence. The roll is triangular, so the middle of the band is far commoner than either end.",
    value: (odds) => round(odds.meanConnectingDamage, 2),
  },
  {
    label: "Mitigated",
    hint: "Share of a connecting blow's raw worth that defence takes off, on average.",
    value: (odds) => percent(odds.mitigation),
  },
  {
    label: "Damage / sec",
    hint:
      "The headline number: every swing, every outcome, at this attacker's rate. What a weapon is actually worth against this defender.",
    value: (odds) => round(odds.damagePerSecond, 2),
    emphasis: true,
  },
  {
    label: "Swings to kill",
    hint: "Blows needed to take the defender from full health to nothing, on average.",
    value: (odds) => orNever(odds.swingsToKill, (v) => round(v, 1)),
  },
  {
    label: "Time to kill",
    hint:
      "The same in seconds. Compare the two columns: the shorter one wins most of the time, and by roughly that margin.",
    value: (odds) => orNever(odds.secondsToKill, (v) => `${round(v, 1)}s`),
    emphasis: true,
  },
];

export function ArenaMetrics({
  aName,
  bName,
  aToB,
  bToA,
}: {
  aName: string;
  bName: string;
  /** A swinging at B. */
  aToB: SwingOdds | null;
  /** B swinging at A. */
  bToA: SwingOdds | null;
}) {
  if (!aToB || !bToA) {
    return (
      <p className="border-2 border-border bg-panel p-3 text-xs text-muted">
        Pick a battler on both sides to see what the match-up comes to.
      </p>
    );
  }

  return (
    <table className="w-full border-collapse border-2 border-border bg-panel text-xs">
      <thead>
        <tr className="border-b-2 border-border bg-ink text-paper">
          <th scope="col" className="px-2 py-1 text-left font-bold uppercase">
            Per swing
          </th>
          <th scope="col" className="px-2 py-1 text-right font-bold">
            {aName} → {bName}
          </th>
          <th scope="col" className="px-2 py-1 text-right font-bold">
            {bName} → {aName}
          </th>
        </tr>
      </thead>
      <tbody>
        {ROWS.map((row) => (
          <tr key={row.label} className="border-b border-border/30 last:border-b-0">
            <th scope="row" className="px-2 py-1 text-left font-normal">
              <Tooltip content={<span className="block max-w-72">{row.hint}</span>}>
                <span
                  className={`cursor-help underline decoration-dotted underline-offset-2 ${row.emphasis ? "font-bold" : ""}`}
                >
                  {row.label}
                </span>
              </Tooltip>
            </th>
            <td
              className={`px-2 py-1 text-right tabular-nums ${row.emphasis ? "font-bold" : ""}`}
            >
              {row.value(aToB)}
            </td>
            <td
              className={`px-2 py-1 text-right tabular-nums ${row.emphasis ? "font-bold" : ""}`}
            >
              {row.value(bToA)}
            </td>
          </tr>
        ))}
        <StatusRow aToB={aToB} bToA={bToA} />
      </tbody>
    </table>
  );
}

/**
 * What a swing leaves behind, quoted at the rate it actually takes.
 *
 * Its own row because it is the one figure with a variable number of entries —
 * most weapons inflict nothing, and a row of dashes for every one of them would
 * be a table mostly about a thing that does not happen.
 */
function StatusRow({ aToB, bToA }: { aToB: SwingOdds; bToA: SwingOdds }) {
  if (aToB.statuses.length === 0 && bToA.statuses.length === 0) return null;

  const summary = (odds: SwingOdds) =>
    odds.statuses.length === 0
      ? "—"
      : odds.statuses
          .map((status) => `${status.id} ${percent(status.perSwing)}`)
          .join(", ");

  return (
    <tr className="border-t border-border/30">
      <th scope="row" className="px-2 py-1 text-left font-normal">
        <Tooltip
          content={
            <span className="block max-w-72">
              Per swing, not per connecting blow: an authored 10% on a weapon
              that lands one swing in five takes one swing in fifty.
            </span>
          }
        >
          <span className="cursor-help underline decoration-dotted underline-offset-2">
            Inflicts
          </span>
        </Tooltip>
      </th>
      <td className="px-2 py-1 text-right">{summary(aToB)}</td>
      <td className="px-2 py-1 text-right">{summary(bToA)}</td>
    </tr>
  );
}
