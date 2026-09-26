import { attackIntervalMs, damageBandOf, damageWorth } from "../game/combat";
import {
  ACCURACY_AT_MAX_MASTERY,
  DAMAGE_AT_MAX_MASTERY,
  damageAtMastery,
  hitChanceFrom,
  MIN_HANDLING,
  weaponHandling,
} from "../lib/battler";
import { TICK_MS } from "../game/constants";
import type { Reach, WeaponItem } from "../lib/item";
import { projectileTiles, resolveProjectile } from "../lib/projectile";
import {
  DEFAULT_WEAPON_STATUS_CHANCE,
  MAX_PERCENT_STAT,
  MAX_REACH_CELLS,
  MAX_REACH_HEIGHT,
  MAX_WEAPON_DAMAGE,
  MIN_PERCENT_STAT,
  reachOf,
} from "../lib/item";
import { flightDurationMs } from "../game/projectile";
import { HEIGHT_PER_LEVEL, type TileDef } from "../lib/types";
import {
  MASTERIES,
  MASTERY_LABELS,
  MAX_MASTERY,
  MIN_MASTERY,
  WEAPON_MASTERIES,
  type WeaponMastery,
} from "../lib/mastery";
import type { StatusDef } from "../lib/status";
import { FieldLabel, Segmented, Select } from "../ui";
import { StatField } from "./StatField";
import { StatusGrants } from "./StatusGrants";

const MASTERY_OPTIONS = WEAPON_MASTERIES.map((value) => ({
  value,
  label: MASTERY_LABELS[value],
}));

export function describeInterval(ms: number): string {
  const seconds = ms / 1000;
  const pace = seconds < 1 ? `${Math.round(ms)}ms` : `${seconds.toFixed(1)}s`;
  return `A blow every ${pace} (${Math.round(ms / TICK_MS)} ticks).`;
}

export function describeMasteryReach(weapon: WeaponItem): string {
  if (weapon.damage <= 0) return "No damage, at any mastery.";
  const gate = weapon.requirements?.[weapon.mastery] ?? 0;
  const at = (level: number) => Math.round(damageAtMastery(weapon, level));
  const name = MASTERY_LABELS[weapon.mastery];
  return `${name} ${gate} does ${at(gate)}. ${name} ${MAX_MASTERY} does ${at(MAX_MASTERY)}.`;
}

export function describeDamageBand(weapon: WeaponItem): string {
  const gate = weapon.requirements?.[weapon.mastery] ?? 0;
  const worth = Math.round(damageAtMastery(weapon, gate));
  const at = `${MASTERY_LABELS[weapon.mastery]} ${gate}`;
  if (weapon.variance <= MIN_PERCENT_STAT) {
    return `Always ${worth} damage at ${at}.`;
  }
  const { min, max } = damageBandOf(worth, weapon.variance);
  const usual = damageWorth(worth, weapon.variance, [0.5, 0.5]);
  return `At ${at}, a blow lands ${min}–${max}, usually near ${usual}.`;
}

export function describeLanding(accuracy: number): string {
  const lands = Math.round(hitChanceFrom(accuracy) * 100);
  return `Finds its target ${lands}% of the time, before mastery moves it.`;
}

export function describeReachCells(cells: number): string {
  const whole = Math.floor(cells);
  if (whole < 1) return "Own cell only — cannot reach a neighbour.";
  const diagonal = cells * cells >= whole * whole * 2 ? ", corners included" : "";
  return `Reaches ${whole} cell${whole === 1 ? "" : "s"}${diagonal}.`;
}

export function describeReachMin(min: number, cells: number): string {
  if (min <= 0) return "No minimum — works in somebody's face.";
  if (min > cells) return "Beyond the reach — this weapon can hit nothing.";
  const whole = Math.floor(min);
  if (whole < 1) return "Cannot be used on your own cell.";
  const corners = min * min > whole * whole * 2 ? ", corners included" : "";
  return `Dead inside ${whole} cell${whole === 1 ? "" : "s"}${corners}.`;
}

export function describeReachHeight(height: number): string {
  if (height <= 0) return "Own floor only.";
  const levels = height / HEIGHT_PER_LEVEL;
  const said = levels === 0.5 ? "half a level" : `${levels} level${levels === 1 ? "" : "s"}`;
  return `Reaches ${said} up and down.`;
}

export function describeFlight(reach: Reach, projectile: { cellsPerSecond: number }): string {
  const ms = flightDurationMs(
    { x: 0, y: 0, elevAbs: 0 },
    { x: reach.cells, y: 0, elevAbs: 0 },
    projectile,
  );
  return `Longest shot: ${(ms / 1000).toFixed(2)}s in the air.`;
}

const REQUIREMENTS_INFO = `Zero asks nothing. Requirements are pooled, and falling short costs accuracy and swing rate only — damage is never scaled by them. Handling runs straight from ${Math.round(MIN_HANDLING * 100)}% at nothing brought to 100% at everything brought, so 90% brought handles at ${Math.round(weaponHandling(0.9) * 100)}% and half brought at ${Math.round(weaponHandling(0.5) * 100)}%. Meeting a requirement is worth full handling and exceeding it is worth nothing more. Nothing here scales the experience the weapon earns.`;

export function WeaponFields({
  weapon,
  onChange,
  masteryInfo,
  tiles,
  statusDefs = {},
}: {
  weapon: WeaponItem;
  onChange: (fields: Partial<WeaponItem>) => void;
  masteryInfo: string;
  tiles: TileDef[];
  statusDefs?: Record<string, StatusDef>;
}) {
  const projectile = weapon.projectile;
  const reach = reachOf(weapon);
  const patchReach = (fields: Partial<Reach>) => onChange({ reach: { ...reach, ...fields } });
  const fired = tiles.find((tile) => tile.id === projectile);
  const flies = resolveProjectile(fired);
  const projectileOptions = [
    ...projectileTiles(tiles).map((tile) => ({
      value: tile.id,
      label: tile.name,
    })),
    ...(projectile && !flies
      ? [{ value: projectile, label: `${projectile} (not a projectile)` }]
      : []),
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-4">
        <StatField
          label="Damage"
          info="What one blow takes off before defence, at mastery zero. Every wielder who can hold the weapon has more than that, so read the line under the box for what it is really worth."
          value={weapon.damage}
          min={0}
          max={MAX_WEAPON_DAMAGE}
          onChange={(damage) => onChange({ damage })}
          readout={describeMasteryReach(weapon)}
        />
        <StatField
          label="Def"
          info="Subtracted from every blow that lands on the wielder, in either hand. What you hold up: a shield, a bracer. What you wear is armour."
          value={weapon.def}
          min={0}
          onChange={(def) => onChange({ def })}
        />
        <StatField
          label="Accuracy"
          info="How often a swing goes where it was aimed, and nothing else. Whether the target gets out of the way is their Agility against the wielder's."
          value={weapon.accuracy}
          min={MIN_PERCENT_STAT}
          max={MAX_PERCENT_STAT}
          onChange={(accuracy) => onChange({ accuracy })}
          readout={describeLanding(weapon.accuracy)}
        />
        <StatField
          label="Variance"
          info="How much a connecting blow swings. 0 is always exactly the damage."
          value={weapon.variance}
          min={MIN_PERCENT_STAT}
          max={MAX_PERCENT_STAT}
          onChange={(variance) => onChange({ variance })}
          readout={describeDamageBand(weapon)}
        />
        <StatField
          label="Spd"
          info="How often it swings, on a curve rather than a line."
          value={weapon.spd}
          min={MIN_PERCENT_STAT}
          max={MAX_PERCENT_STAT}
          onChange={(spd) => onChange({ spd })}
          readout={describeInterval(attackIntervalMs(weapon.spd))}
        />
        <StatField
          label="Reach"
          info="Radius in cells. Independent of Height — a disc and a lid, not a ball. A blow still needs a clear line to its target."
          value={reach.cells}
          min={0}
          max={MAX_REACH_CELLS}
          step={0.5}
          onChange={(cells) => patchReach({ cells })}
          readout={describeReachCells(reach.cells)}
        />
        <StatField
          label="Minimum"
          info="How close is too close, in cells. Zero is no minimum. On the plan only — somebody a floor below you is nought cells away, and the Height lid is what refuses them. A bow with one of these needs a second weapon for the gap."
          value={reach.min ?? 0}
          min={0}
          max={MAX_REACH_CELLS}
          step={0.5}
          onChange={(min) => patchReach({ min })}
          readout={describeReachMin(reach.min ?? 0, reach.cells)}
        />
        <StatField
          label="Height"
          info={`Height units up or down — ${HEIGHT_PER_LEVEL} to a level.`}
          value={reach.height}
          min={0}
          max={MAX_REACH_HEIGHT}
          step={0.5}
          onChange={(height) => patchReach({ height })}
          readout={describeReachHeight(reach.height)}
        />
      </div>

      <div className="flex flex-col gap-1 text-xs">
        <FieldLabel info={masteryInfo}>Mastery</FieldLabel>
        <div>
          <Segmented<WeaponMastery>
            value={weapon.mastery}
            onChange={(mastery) => onChange({ mastery })}
            options={MASTERY_OPTIONS}
            size="sm"
            ariaLabel="Mastery"
          />
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
        <FieldLabel info="Authoring one is what makes this ranged: no lunge at the target, however close. The flight is a picture — the blow lands on release, so it cannot miss in the air.">
          Projectile
        </FieldLabel>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1 text-xs">
            <FieldLabel info="What this fires. Only tiles of the Projectile kind can be — their art, their speed and what they play at each end belong to them, so two weapons firing one are two weapons that agree.">
              Fires
            </FieldLabel>
            <Select
              className="w-56"
              value={projectile ?? ""}
              onValueChange={(id) => onChange({ projectile: id ? id : undefined })}
              options={[{ value: "", label: "Nothing (melee)" }, ...projectileOptions]}
            />
          </label>
          {flies ? (
            <span className="self-end text-[11px] text-muted">{describeFlight(reach, flies)}</span>
          ) : null}
        </div>
      </div>
      <StatusGrants
        statuses={weapon.statuses ?? []}
        statusDefs={statusDefs}
        onChange={(statuses) => onChange({ statuses: statuses.length ? statuses : undefined })}
        blank={(id) => ({ id, chance: DEFAULT_WEAPON_STATUS_CHANCE })}
        info="Rolled once per entry on every blow that lands. A miss or a dodge leaves nothing; armour eating the damage does not stop it. No mastery moves the chance."
      />

      <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
        <FieldLabel info={REQUIREMENTS_INFO}>Requirements</FieldLabel>
        <div className="flex flex-wrap gap-4">
          {MASTERIES.map((mastery) => {
            const required = weapon.requirements?.[mastery] ?? 0;
            return (
              <StatField
                key={mastery}
                label={MASTERY_LABELS[mastery]}
                hint={mastery === weapon.mastery ? "Trained by this weapon." : undefined}
                value={required}
                min={MIN_MASTERY}
                max={MAX_MASTERY}
                onChange={(level) =>
                  onChange({
                    requirements: { ...weapon.requirements, [mastery]: level },
                  })
                }
              />
            );
          })}
        </div>
        <p className="max-w-lg text-[11px] leading-snug text-muted">
          Mastery adds up to {DAMAGE_AT_MAX_MASTERY} damage and {ACCURACY_AT_MAX_MASTERY} accuracy
          flat, plus a quarter of the weapon&rsquo;s own.
        </p>
      </div>
    </div>
  );
}
