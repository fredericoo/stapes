import { attackIntervalMs, damageFraction, dodgeChance } from "../game/combat";
import { TICK_MS } from "../game/constants";
import type { WeaponItem } from "../lib/item";
import {
  MAX_PERCENT_STAT,
  MAX_WEAPON_DAMAGE,
  MIN_PERCENT_STAT,
} from "../lib/item";
import {
  MASTERIES,
  MASTERY_BRIDGE,
  MAX_MASTERY,
  MAX_MASTERY_RATIO,
  type Mastery,
  MIN_MASTERY,
  trainingCeiling,
  WEAPON_MASTERIES,
  type WeaponMastery,
} from "../lib/mastery";
import { Segmented } from "../ui";
import { StatField } from "./StatField";

/**
 * How a weapon fights, authored once and edited in two places.
 *
 * Both tabs need it and they need the *same* one: the Item tab authors what a
 * sword does, and the Battle tab authors a creature's bite — which is a weapon
 * in every sense that matters, down to the schema it is validated by. Two copies
 * of these four fields would be two places to forget a rename.
 */

const MASTERY_LABELS: Record<Mastery, string> = {
  fist: "Fist",
  blade: "Blade",
  blunt: "Blunt",
  ranged: "Ranged",
  arcane: "Arcane",
  toughness: "Toughness",
  agility: "Agility",
};

const MASTERY_OPTIONS = WEAPON_MASTERIES.map((value) => ({
  value,
  label: MASTERY_LABELS[value],
}));

/** Milliseconds, said the way a person reads them. */
export function describeInterval(ms: number): string {
  const seconds = ms / 1000;
  const pace = seconds < 1 ? `${Math.round(ms)}ms` : `${seconds.toFixed(1)}s`;
  return `A blow every ${pace} (${Math.round(ms / TICK_MS)} ticks).`;
}

/**
 * What this accuracy does to the damage a blow is worth.
 *
 * Read out of the same function the simulation rolls with, at the two ends and
 * the peak of the triangle, rather than re-derived here — a readout that could
 * disagree with the formula is worse than none.
 */
export function describeDamageBand(weapon: {
  damage: number;
  variance: number;
}): string {
  if (weapon.variance <= MIN_PERCENT_STAT) {
    return `Always ${weapon.damage} damage.`;
  }
  const at = (roll: [number, number]) =>
    Math.round(weapon.damage * damageFraction(weapon.variance, roll));
  return `Damage ${at([0, 0])}–${at([1, 1])}, usually near ${at([0.5, 0.5])}.`;
}

/**
 * What this accuracy is worth against somebody quick and somebody slow.
 *
 * Read out of the contest the simulation actually runs, at two evasions that
 * bracket what the world is authored with — the curve is a logistic and nobody
 * can read one off a number in a box.
 */
export function describeDodging(accuracy: number): string {
  const nimble = Math.round(dodgeChance(60, accuracy) * 100);
  const slow = Math.round(dodgeChance(30, accuracy) * 100);
  return `Dodged ${nimble}% by the quick, ${slow}% by the slow.`;
}

export function WeaponFields({
  weapon,
  onChange,
  masteryHint,
}: {
  weapon: WeaponItem;
  onChange: (fields: Partial<WeaponItem>) => void;
  /** What answering to this mastery means here — it differs by tab. */
  masteryHint: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-4">
        <StatField
          label="Damage"
          hint="The most one blow can take off, against a foe with no defence."
          value={weapon.damage}
          min={0}
          max={MAX_WEAPON_DAMAGE}
          onChange={(damage) => onChange({ damage })}
        />
        <StatField
          label="Def"
          hint="Taken off every blow that lands on the wielder. Armour's job, until there is armour."
          value={weapon.def}
          min={0}
          onChange={(def) => onChange({ def })}
        />
        <StatField
          label="Accuracy"
          hint="How reliably it finds its target. High for most melee — how risky it is, is Variance."
          value={weapon.accuracy}
          min={MIN_PERCENT_STAT}
          max={MAX_PERCENT_STAT}
          onChange={(accuracy) => onChange({ accuracy })}
          readout={describeDodging(weapon.accuracy)}
        />
        <StatField
          label="Variance"
          hint="How much a connecting blow swings. Zero is always exactly its damage."
          value={weapon.variance}
          min={MIN_PERCENT_STAT}
          max={MAX_PERCENT_STAT}
          onChange={(variance) => onChange({ variance })}
          readout={describeDamageBand(weapon)}
        />
        <StatField
          label="Spd"
          hint="How often it can be swung, on a curve rather than a line."
          value={weapon.spd}
          min={MIN_PERCENT_STAT}
          max={MAX_PERCENT_STAT}
          onChange={(spd) => onChange({ spd })}
          readout={describeInterval(attackIntervalMs(weapon.spd))}
        />
      </div>

      <div className="flex flex-col gap-1 text-xs">
        <span className="font-bold uppercase text-muted">Mastery</span>
        <div>
          <Segmented<WeaponMastery>
            value={weapon.mastery}
            onChange={(mastery) => onChange({ mastery })}
            options={MASTERY_OPTIONS}
            size="sm"
            ariaLabel="Mastery"
          />
        </div>
        <span className="text-[11px] leading-snug text-muted">
          {masteryHint}
        </span>
      </div>

      <div className="flex flex-col gap-1 border-t-2 border-border pt-3">
        <span className="text-xs font-bold uppercase text-muted">
          Requirements
        </span>
        <p className="max-w-lg text-[11px] leading-snug text-muted">
          What this asks of whoever swings it. Zero asks nothing.{" "}
          <strong>The worst ratio decides</strong> — a requirement on a mastery
          this weapon does not even train is a real gate, so an axe asking Blunt
          35 and Toughness 20 is held back by whichever of the wielder&rsquo;s is
          further behind.
        </p>
      </div>

      <div className="flex flex-wrap gap-4">
        {MASTERIES.map((mastery) => {
          const required = weapon.requirements?.[mastery] ?? 0;
          return (
            <StatField
              key={mastery}
              label={MASTERY_LABELS[mastery]}
              hint={
                mastery === weapon.mastery
                  ? "The mastery this weapon trains."
                  : ""
              }
              value={required}
              min={MIN_MASTERY}
              max={MAX_MASTERY}
              onChange={(level) =>
                onChange({
                  requirements: { ...weapon.requirements, [mastery]: level },
                })
              }
              readout={
                mastery === weapon.mastery && required > 0
                  ? `Full learning to ${MASTERY_LABELS[mastery]} ${trainingCeiling(required)} — a ${MASTERY_BRIDGE}-point bridge — then fading.`
                  : undefined
              }
            />
          );
        })}
      </div>

      <p className="max-w-lg text-[11px] leading-snug text-muted">
        A wielder who exactly meets every requirement swings at full effect. Below
        that, <strong>landing carries the penalty</strong> and speed and damage
        only sag — an outclassed weapon still connects sometimes, so it is poor
        rather than useless and can still teach. Above it, up to{" "}
        {MAX_MASTERY_RATIO}×, speed and damage keep improving and landing does
        not, since it is already certain.
      </p>

      <p className="max-w-lg text-[11px] leading-snug text-muted">
        <strong>How far it carries a wielder is a separate question.</strong>{" "}
        Every weapon teaches {MASTERY_BRIDGE} points past what it asks, whatever
        tier it sits at, and fades after that rather than stopping. So a
        requirement is not just a gate — it is where this weapon's stretch of the
        ladder begins.
      </p>
    </div>
  );
}
