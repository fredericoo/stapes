import type { BattlerDef } from "../lib/battler";
import {
  DEFAULT_BATTLER,
  MAX_PERCENT_STAT,
  MIN_PERCENT_STAT,
} from "../lib/battler";
import {
  attackIntervalMs,
  damageFraction,
  dodgeChance,
  MAX_ATTACK_TICKS,
  MIN_ATTACK_TICKS,
} from "../game/combat";
import { TICK_MS } from "../game/constants";
import { hasAnyInteraction, type TileInteractions } from "../lib/interactions";
import type { TileDef } from "../lib/types";
import { Input, Switch } from "../ui";

type Props = {
  draft: TileDef;
  onChange: (next: TileDef) => void;
};

/**
 * One numeric stat, with the sentence that says what it does to a fight.
 *
 * The readout is the point of this component. Every one of these numbers feeds a
 * curve — accuracy widens a band, speed is geometric, flee is measured against
 * half of somebody else's accuracy — and none of that is guessable from a box
 * with `50` in it. Showing what the current value *means* is what makes the
 * curves authorable rather than something to be discovered by fighting things.
 */
function StatField({
  label,
  hint,
  value,
  min,
  max,
  onChange,
  readout,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max?: number;
  onChange: (next: number) => void;
  readout?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="font-bold uppercase text-muted">{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        step={1}
        className="w-24"
        value={value}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (!Number.isFinite(next)) return;
          const clamped = Math.max(min, Math.min(max ?? Infinity, Math.round(next)));
          onChange(clamped);
        }}
      />
      <span className="max-w-64 text-[11px] leading-snug text-muted">
        {hint}
        {readout ? <strong className="block text-ink">{readout}</strong> : null}
      </span>
    </label>
  );
}

/** Milliseconds, said the way a person reads them. */
function describeInterval(ms: number): string {
  const seconds = ms / 1000;
  const pace = seconds < 1 ? `${Math.round(ms)}ms` : `${seconds.toFixed(1)}s`;
  return `A blow every ${pace} (${Math.round(ms / TICK_MS)} ticks).`;
}

/**
 * Hit points and the numbers that spend them.
 *
 * A tab of its own rather than another section on Interactive, because being a
 * battler is not something the player *does* to a tile — it is something the
 * tile is. The brain earned its own tab on the same grounds.
 */
export function BattleTab({ draft, onChange }: Props) {
  const battler = draft.interactions?.battler;

  const setBattler = (next: BattlerDef | undefined) => {
    const merged: TileInteractions = { ...draft.interactions };
    if (next == null) delete merged.battler;
    else merged.battler = next;
    onChange({
      ...draft,
      interactions: hasAnyInteraction(merged) ? merged : undefined,
    });
  };

  const patch = (fields: Partial<BattlerDef>) => {
    if (!battler) return;
    setBattler({ ...battler, ...fields });
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <label className="flex items-center gap-2 text-sm font-bold">
          <Switch
            checked={Boolean(battler)}
            onCheckedChange={(on) =>
              setBattler(on ? { ...DEFAULT_BATTLER } : undefined)
            }
            ariaLabel="Battler"
          />
          Battler
        </label>
        <p className="text-[11px] leading-snug text-muted">
          This tile has hit points. Every placement starts at full health, can be
          targeted and attacked, and is <strong>deleted from the map</strong> the
          moment it reaches zero — there is no respawn yet. Independent of{" "}
          <strong>Actor</strong> and of the brain: what a body can take is a
          separate question from what drives it.
        </p>

        {battler ? (
          <div className="flex flex-wrap gap-4 border-t-2 border-border pt-3">
            <StatField
              label="Max HP"
              hint="Hit points a fresh placement starts at."
              value={battler.maxHp}
              min={1}
              onChange={(maxHp) => patch({ maxHp })}
            />
            <StatField
              label="Atk"
              hint="The most one blow can take off, against a foe with no defence."
              value={battler.atk}
              min={0}
              onChange={(atk) => patch({ atk })}
            />
            <StatField
              label="Def"
              hint="Taken off every blow that lands on this entity."
              value={battler.def}
              min={0}
              onChange={(def) => patch({ def })}
            />
            <StatField
              label="Acc"
              hint="How reliably a blow is worth full attack. Not whether it hits — that is the other party's flee."
              value={battler.acc}
              min={MIN_PERCENT_STAT}
              max={MAX_PERCENT_STAT}
              onChange={(acc) => patch({ acc })}
              readout={describeDamageBand(battler)}
            />
            <StatField
              label="Flee"
              hint="Dodging, measured against half the attacker's accuracy."
              value={battler.flee}
              min={MIN_PERCENT_STAT}
              max={MAX_PERCENT_STAT}
              onChange={(flee) => patch({ flee })}
              readout={describeDodge(battler.flee)}
            />
            <StatField
              label="Spd"
              hint={`How often it swings, on a curve — 0 is every ${MAX_ATTACK_TICKS} ticks, 100 every ${MIN_ATTACK_TICKS}.`}
              value={battler.spd}
              min={MIN_PERCENT_STAT}
              max={MAX_PERCENT_STAT}
              onChange={(spd) => patch({ spd })}
              readout={describeInterval(attackIntervalMs(battler.spd))}
            />
          </div>
        ) : null}
      </section>
    </div>
  );
}

/**
 * What this accuracy does to the damage a blow is worth.
 *
 * Read out of the same function the simulation rolls with, at the two ends and
 * the peak of the triangle, rather than re-derived here — a readout that could
 * disagree with the formula is worse than none.
 */
function describeDamageBand(battler: BattlerDef): string {
  if (battler.acc >= MAX_PERCENT_STAT) return `Always ${battler.atk} damage.`;
  const at = (roll: [number, number]) =>
    Math.round(battler.atk * damageFraction(battler.acc, roll));
  return `Damage ${at([0, 0])}–${at([1, 1])}, usually near ${at([0.5, 0.5])}.`;
}

/** What this flee is worth against the enemy baseline, and against perfect aim. */
function describeDodge(flee: number): string {
  const baseline = Math.round(dodgeChance(flee, 50) * 100);
  const versusPerfect = Math.round(dodgeChance(flee, MAX_PERCENT_STAT) * 100);
  return `Dodges ${baseline}% against 50 acc, ${versusPerfect}% against 100.`;
}
