import type { RotationOdds, SwingOdds } from "../game/combatMetrics";

type Row = { label: string; emphasis?: boolean } & (
  | { swing: (odds: SwingOdds) => string }
  | { rotation: (odds: RotationOdds) => string }
);

const percent = (share: number) => `${(share * 100).toFixed(1)}%`;
const round = (value: number, places = 1) => value.toFixed(places);
const orNever = (value: number | null, format: (v: number) => string) =>
  value === null ? "never" : format(value);
const intervals = (odds: RotationOdds) =>
  odds.swings.map((swing) => `${Math.round(swing.intervalMs)}ms`).join(" + ");

const ROWS: Row[] = [
  {
    label: "Attacks / sec",
    rotation: (odds) => `${round(odds.attacksPerSecond, 2)} (${intervals(odds)})`,
  },
  { label: "Miss", swing: (odds) => percent(odds.missed) },
  { label: "Dodge (of aimed)", swing: (odds) => percent(odds.dodgeWhenAimed) },
  { label: "Dodge (of all)", swing: (odds) => percent(odds.dodged) },
  { label: "Connect", swing: (odds) => percent(odds.connected) },
  { label: "Defence faced", swing: (odds) => String(odds.defence) },
  { label: "Absorbed", swing: (odds) => percent(odds.absorbed) },
  { label: "Wound", swing: (odds) => percent(odds.wounded) },
  {
    label: "Damage range",
    swing: (odds) => `${odds.minDamage}–${odds.maxDamage}`,
  },
  { label: "Mean blow", swing: (odds) => round(odds.meanConnectingDamage, 2) },
  { label: "Mitigated", swing: (odds) => percent(odds.mitigation) },
  {
    label: "Damage / sec",
    rotation: (odds) => round(odds.damagePerSecond, 2),
    emphasis: true,
  },
  {
    label: "Swings to kill",
    rotation: (odds) => orNever(odds.swingsToKill, (v) => round(v, 1)),
  },
  {
    label: "Time to kill",
    rotation: (odds) => orNever(odds.secondsToKill, (v) => `${round(v, 1)}s`),
    emphasis: true,
  },
];

export function ArenaMetrics({
  aName,
  bName,
  aSwingNames,
  bSwingNames,
  aToB,
  bToA,
}: {
  aName: string;
  bName: string;
  aSwingNames: readonly string[];
  bSwingNames: readonly string[];
  aToB: RotationOdds | null;
  bToA: RotationOdds | null;
}) {
  if (!aToB || !bToA) {
    return (
      <p className="border-2 border-border bg-panel p-3 text-xs text-muted">
        Pick a battler on both sides.
      </p>
    );
  }

  const split = aToB.swings.length > 1 || bToA.swings.length > 1;

  return (
    <table className="w-full border-collapse border-2 border-border bg-panel text-xs">
      <thead>
        <tr className={split ? "bg-ink text-paper" : "border-b-2 border-border bg-ink text-paper"}>
          <th
            scope="col"
            rowSpan={split ? 2 : undefined}
            className="px-2 py-1 text-left font-bold uppercase"
          >
            Per swing
          </th>
          <SideHeading hands={aToB.swings.length} split={split}>
            {aName} → {bName}
          </SideHeading>
          <SideHeading hands={bToA.swings.length} split={split}>
            {bName} → {aName}
          </SideHeading>
        </tr>
        {split ? (
          <tr className="border-b-2 border-border bg-ink text-paper">
            <HandHeadings odds={aToB} names={aSwingNames} />
            <HandHeadings odds={bToA} names={bSwingNames} />
          </tr>
        ) : null}
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
            <Cells row={row} odds={aToB} />
            <Cells row={row} odds={bToA} />
          </tr>
        ))}
        <StatusRow aToB={aToB} bToA={bToA} />
      </tbody>
    </table>
  );
}

function SideHeading({
  hands,
  split,
  children,
}: {
  hands: number;
  split: boolean;
  children: React.ReactNode;
}) {
  return (
    <th
      scope="col"
      colSpan={hands > 1 ? hands : undefined}
      rowSpan={split && hands === 1 ? 2 : undefined}
      className={`px-2 py-1 ${hands > 1 ? "text-center" : "text-right"} font-bold`}
    >
      {children}
    </th>
  );
}

function HandHeadings({ odds, names }: { odds: RotationOdds; names: readonly string[] }) {
  if (odds.swings.length === 1) return null;
  return odds.swings.map((_, index) => (
    <th key={index} scope="col" className="px-2 py-1 text-right font-normal">
      {names[index]}
    </th>
  ));
}

function Cells({ row, odds }: { row: Row; odds: RotationOdds }) {
  const weight = row.emphasis ? "font-bold" : "";
  if ("rotation" in row) {
    const hands = odds.swings.length;
    return (
      <td
        colSpan={hands > 1 ? hands : undefined}
        className={`px-2 py-1 ${hands > 1 ? "text-center" : "text-right"} tabular-nums ${weight}`}
      >
        {row.rotation(odds)}
      </td>
    );
  }
  return odds.swings.map((swing, index) => (
    <td key={index} className={`px-2 py-1 text-right tabular-nums ${weight}`}>
      {row.swing(swing)}
    </td>
  ));
}

function StatusRow({ aToB, bToA }: { aToB: RotationOdds; bToA: RotationOdds }) {
  const swings = [...aToB.swings, ...bToA.swings];
  if (swings.every((swing) => swing.statuses.length === 0)) return null;

  const summary = (odds: SwingOdds) =>
    odds.statuses.length === 0
      ? "—"
      : odds.statuses.map((status) => `${status.id} ${percent(status.perSwing)}`).join(", ");

  return (
    <tr className="border-t border-border/30">
      <th scope="row" className="px-2 py-1 text-left font-normal">
        Inflicts / swing
      </th>
      {swings.map((swing, index) => (
        <td key={index} className="px-2 py-1 text-right">
          {summary(swing)}
        </td>
      ))}
    </tr>
  );
}
