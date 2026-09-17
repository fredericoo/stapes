import { attackIntervalMs, damageFraction } from "../game/combat";
import {
  ACCURACY_AT_MAX_MASTERY,
  DAMAGE_AT_MAX_MASTERY,
  hitChanceFrom,
  MIN_HANDLING,
  weaponHandling,
} from "../lib/battler";
import { TICK_MS } from "../game/constants";
import type { Reach, WeaponItem } from "../lib/item";
import {
  projectileTiles,
  resolveProjectile,
} from "../lib/projectile";
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

/**
 * How a weapon fights, authored once and edited in two places.
 *
 * Both tabs need it and they need the *same* one: the Item tab authors what a
 * sword does, and the Battle tab authors a creature's bite — which is a weapon
 * in every sense that matters, down to the schema it is validated by. Two copies
 * of these four fields would be two places to forget a rename.
 */

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
 * How often a swing at this accuracy goes where it was aimed.
 *
 * Read out of {@link hitChanceFrom} rather than restated as a percentage,
 * because the two ends of the scale are clamped and a box reading 3 does not
 * mean one swing in thirty-three.
 *
 * **It used to read out how often the blow was dodged**, back when a weapon's
 * accuracy was what a defender's evasion was contested against. That contest is
 * between the two bodies' Agility now — see `../game/combat`'s `dodgeChance` —
 * so a weapon has nothing to say about it, and a readout here that mentioned
 * dodging would be an author tuning a number against an outcome it no longer
 * touches.
 */
export function describeLanding(accuracy: number): string {
  const lands = Math.round(hitChanceFrom(accuracy) * 100);
  return `Finds its target ${lands}% of the time, before mastery moves it.`;
}

/**
 * What this radius covers on the plan, said in cells rather than in a radius.
 *
 * The number in the box is a radius and nobody reads a shape off one: 1.5 is
 * "the eight around you" and 2 is "the ring beyond as well", and the difference
 * between them is not half of anything an author can picture. So the readout
 * counts, which is the unit the map is drawn in.
 */
export function describeReachCells(cells: number): string {
  const whole = Math.floor(cells);
  if (whole < 1) return "Own cell only — cannot reach a neighbour.";
  const diagonal = cells * cells >= whole * whole * 2 ? ", corners included" : "";
  return `Reaches ${whole} cell${whole === 1 ? "" : "s"}${diagonal}.`;
}

/**
 * What a floor on the reach takes away, said in cells.
 *
 * Counted rather than given back as a radius, on the terms
 * {@link describeReachCells} counts: what an author needs to see is which cells
 * stop working, and "2" is not that. Zero is spelled out as "none" rather than
 * left blank, because a number field cannot say "none" and an author who typed
 * a zero should be told that is what it means.
 */
export function describeReachMin(min: number, cells: number): string {
  if (min <= 0) return "No minimum — works in somebody's face.";
  if (min > cells) return "Beyond the reach — this weapon can hit nothing.";
  const whole = Math.floor(min);
  if (whole < 1) return "Cannot be used on your own cell.";
  const corners = min * min > whole * whole * 2 ? ", corners included" : "";
  return `Dead inside ${whole} cell${whole === 1 ? "" : "s"}${corners}.`;
}

/**
 * What this height allowance covers, said in levels.
 *
 * Height units are the honest unit — half a level is a real distance and a crate
 * puts somebody exactly there — and they are also the unit nobody thinks in. The
 * readout does the halving.
 */
export function describeReachHeight(height: number): string {
  if (height <= 0) return "Own floor only.";
  const levels = height / HEIGHT_PER_LEVEL;
  const said = levels === 0.5 ? "half a level" : `${levels} level${levels === 1 ? "" : "s"}`;
  return `Reaches ${said} up and down.`;
}

/**
 * How long this weapon's arrow spends in the air, at the far end of its reach.
 *
 * Read out of the same function the simulation times a flight with, at the
 * longest shot the weapon can actually take — which is the one an author is
 * choosing a speed for. A readout that could disagree with the formula is worse
 * than none.
 */
export function describeFlight(
  reach: Reach,
  projectile: { cellsPerSecond: number },
): string {
  const ms = flightDurationMs(
    { x: 0, y: 0, elevAbs: 0 },
    { x: reach.cells, y: 0, elevAbs: 0 },
    projectile,
  );
  return `Longest shot: ${(ms / 1000).toFixed(2)}s in the air.`;
}

/** The one paragraph of arithmetic behind the requirements grid, as a tooltip. */
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
  /** What answering to this mastery means here — it differs by tab. */
  masteryInfo: string;
  /**
   * The whole library, so the picker can offer the tiles that can actually be
   * fired. Handed in rather than looked up, on the terms the kit table's is:
   * this component resolves nothing about the world.
   */
  tiles: TileDef[];
  /**
   * The status catalogue, so what a blow leaves behind can be picked by name.
   * Empty where nothing is authored, in which case the section says so rather
   * than offering an empty dropdown.
   */
  statusDefs?: Record<string, StatusDef>;
}) {
  const projectile = weapon.projectile;
  // Read through `reachOf` rather than off the draft: an authored weapon that
  // predates the field has no `reach` at all, and every creature's natural
  // weapon in `tiles.json` is one. Patching through it too, so half a reach
  // never reaches the draft.
  const reach = reachOf(weapon);
  const patchReach = (fields: Partial<Reach>) =>
    onChange({ reach: { ...reach, ...fields } });
  // Every projectile tile, plus whatever this weapon already names even if the
  // catalogue has since changed its mind about it — an id silently dropped from
  // the picker is an author being told their arrow does not exist while it sits
  // in the file doing nothing.
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
          info="The most one blow takes off, before defence."
          value={weapon.damage}
          min={0}
          max={MAX_WEAPON_DAMAGE}
          onChange={(damage) => onChange({ damage })}
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
              onValueChange={(id) =>
                onChange({ projectile: id ? id : undefined })
              }
              options={[{ value: "", label: "Nothing (melee)" }, ...projectileOptions]}
            />
          </label>
          {flies ? (
            <span className="self-end text-[11px] text-muted">
              {describeFlight(reach, flies)}
            </span>
          ) : null}
        </div>
      </div>
      <StatusGrants
        statuses={weapon.statuses ?? []}
        statusDefs={statusDefs}
        onChange={(statuses) =>
          onChange({ statuses: statuses.length ? statuses : undefined })
        }
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
          Mastery adds up to {DAMAGE_AT_MAX_MASTERY} damage and{" "}
          {ACCURACY_AT_MAX_MASTERY} accuracy flat, plus a quarter of the
          weapon&rsquo;s own.
        </p>
      </div>
    </div>
  );
}
