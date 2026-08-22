import type { SwingOdds } from "../game/combatMetrics";

/**
 * What the match-up comes to, before anybody swings.
 *
 * **Every cell is a function of the stat blocks and nothing else.** There were
 * tooltips here explaining what each row meant — what a dodge is contested
 * against, why speed is geometric, what "absorbed" stands in for — and they are
 * gone on purpose. Prose describing a formula is a second copy of that formula
 * written in English, and the English one does not fail a test when the
 * arithmetic moves. The numbers are the documentation; `../game/combatMetrics`
 * is where the reasoning lives, next to the code that has to stay true to it.
 *
 * Read as two columns because a fight is not symmetric: what the rat's bite is
 * worth against your armour and what your sword is worth against its hide are
 * different questions with different answers.
 */

type Row = {
  label: string;
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
    value: (odds) =>
      `${round(odds.attacksPerSecond, 2)} (${Math.round(odds.intervalMs)}ms)`,
  },
  { label: "Miss", value: (odds) => percent(odds.missed) },
  { label: "Dodge (of aimed)", value: (odds) => percent(odds.dodgeWhenAimed) },
  { label: "Dodge (of all)", value: (odds) => percent(odds.dodged) },
  { label: "Connect", value: (odds) => percent(odds.connected) },
  { label: "Defence faced", value: (odds) => String(odds.defence) },
  { label: "Absorbed", value: (odds) => percent(odds.absorbed) },
  { label: "Wound", value: (odds) => percent(odds.wounded) },
  {
    label: "Damage range",
    value: (odds) => `${odds.minDamage}–${odds.maxDamage}`,
  },
  { label: "Mean blow", value: (odds) => round(odds.meanConnectingDamage, 2) },
  { label: "Mitigated", value: (odds) => percent(odds.mitigation) },
  {
    label: "Damage / sec",
    value: (odds) => round(odds.damagePerSecond, 2),
    emphasis: true,
  },
  {
    label: "Swings to kill",
    value: (odds) => orNever(odds.swingsToKill, (v) => round(v, 1)),
  },
  {
    label: "Time to kill",
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
        Pick a battler on both sides.
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
            <th
              scope="row"
              className={`px-2 py-1 text-left font-normal ${row.emphasis ? "font-bold" : ""}`}
            >
              {row.label}
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
        Inflicts / swing
      </th>
      <td className="px-2 py-1 text-right">{summary(aToB)}</td>
      <td className="px-2 py-1 text-right">{summary(bToA)}</td>
    </tr>
  );
}
