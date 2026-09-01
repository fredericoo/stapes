import { attackIntervalMs, damageFraction, dodgeChance } from "../game/combat";
import {
  ACCURACY_AT_MAX_MASTERY,
  DAMAGE_AT_MAX_MASTERY,
  REQUIREMENT_FALLOFF,
} from "../lib/battler";
import { TICK_MS } from "../game/constants";
import type { ProjectileDef, Reach, WeaponItem } from "../lib/item";
import {
  DEFAULT_PROJECTILE_SPEED,
  DEFAULT_WEAPON_STATUS_CHANCE,
  MAX_PERCENT_STAT,
  MAX_PROJECTILE_SPEED,
  MAX_REACH_CELLS,
  MAX_REACH_HEIGHT,
  MAX_WEAPON_DAMAGE,
  MIN_PERCENT_STAT,
  MIN_PROJECTILE_SPEED,
  reachOf,
} from "../lib/item";
import { flightDurationMs } from "../game/projectile";
import { HEIGHT_PER_LEVEL, type TileDef } from "../lib/types";
import {
  MASTERIES,
  MASTERY_LABELS,
  MAX_MASTERY,
  MIN_MASTERY,
  OUTGROWN_FALLOFF,
  WEAPON_MASTERIES,
  type WeaponMastery,
} from "../lib/mastery";
import type { StatusDef } from "../lib/status";
import { Segmented, Select } from "../ui";
import { StatField } from "./StatField";
import { StatusChanceField, StatusGrants } from "./StatusGrants";

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
  if (whole < 1) return "Only its own cell — it cannot reach a neighbour.";
  const diagonal = cells * cells >= whole * whole * 2 ? ", corners included" : "";
  return `Reaches ${whole} cell${whole === 1 ? "" : "s"} across the floor${diagonal}.`;
}

/**
 * What this height allowance covers, said in levels.
 *
 * Height units are the honest unit — half a level is a real distance and a crate
 * puts somebody exactly there — and they are also the unit nobody thinks in. The
 * readout does the halving.
 */
export function describeReachHeight(height: number): string {
  if (height <= 0) return "Its own floor only — nothing up a step, nothing down.";
  const levels = height / HEIGHT_PER_LEVEL;
  const said = levels === 0.5 ? "half a level" : `${levels} level${levels === 1 ? "" : "s"}`;
  return `Reaches ${said} up and ${said} down.`;
}

/**
 * How long this weapon's arrow spends in the air, at the far end of its reach.
 *
 * Read out of the same function the simulation times a flight with, at the
 * longest shot the weapon can actually take — which is the one an author is
 * choosing a speed for. A readout that could disagree with the formula is worse
 * than none.
 */
export function describeFlight(reach: Reach, projectile: ProjectileDef): string {
  const ms = flightDurationMs(
    { x: 0, y: 0, elevAbs: 0 },
    { x: reach.cells, y: 0, elevAbs: 0 },
    projectile,
  );
  return `Its longest shot is ${(ms / 1000).toFixed(2)}s in the air.`;
}

/** What a weapon with no projectile authored is offered when it grows one. */
const STARTER_PROJECTILE: ProjectileDef = {
  tileId: "",
  cellsPerSecond: DEFAULT_PROJECTILE_SPEED,
};

export function WeaponFields({
  weapon,
  onChange,
  masteryHint,
  tiles,
  statusDefs = {},
}: {
  weapon: WeaponItem;
  onChange: (fields: Partial<WeaponItem>) => void;
  /** What answering to this mastery means here — it differs by tab. */
  masteryHint: string;
  /**
   * The whole library, so the projectile picker can offer the tiles that can
   * actually be one. Handed in rather than looked up, on the terms the kit
   * table's is: this component resolves nothing about the world.
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
  const patchProjectile = (fields: Partial<ProjectileDef>) =>
    onChange({
      projectile: { ...(projectile ?? STARTER_PROJECTILE), ...fields },
    });

  // Eight-way tiles, plus whatever this weapon already names even if the
  // catalogue has since changed its mind about it — an id silently dropped from
  // the picker is an author being told their arrow does not exist while it sits
  // in the file doing nothing.
  const projectileTiles = tiles.filter(
    (tile) => tile.type === "directional8" || tile.id === projectile?.tileId,
  );

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
          hint="Taken off every blow that lands on the wielder, in either hand. What you hold up: a shield, a bracer. What you wear is armour, and has a slot of its own."
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
        <StatField
          label="Reach"
          hint="How far it carries across the floor, as a radius in cells."
          value={reach.cells}
          min={0}
          max={MAX_REACH_CELLS}
          step={0.5}
          onChange={(cells) => patchReach({ cells })}
          readout={describeReachCells(reach.cells)}
        />
        <StatField
          label="Height"
          hint="How far up or down it carries, in height units — two to a level."
          value={reach.height}
          min={0}
          max={MAX_REACH_HEIGHT}
          step={0.5}
          onChange={(height) => patchReach({ height })}
          readout={describeReachHeight(reach.height)}
        />
      </div>

      <p className="max-w-lg text-[11px] leading-snug text-muted">
        <strong>Reach is a disc and a lid, not a ball.</strong> The two numbers
        are independent, which is the only way to say &ldquo;across the yard,
        but not three storeys straight up&rdquo;. A blow still needs a clear
        line to land — a wall between you and your target does not stop you
        pointing at it, only shooting it.
      </p>

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

      <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
        <span className="text-xs font-bold uppercase text-muted">
          Projectile
        </span>
        <p className="max-w-lg text-[11px] leading-snug text-muted">
          Authoring one is what makes this a <strong>ranged</strong> weapon:
          nothing else says so. A weapon that puts something in the air does not
          lunge at what it is aimed at, however close that is. The flight is
          purely a picture — the blow lands the moment it is loosed, so an arrow
          cannot miss on the way and a shot that killed still finishes its
          flight.
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-bold uppercase text-muted">Fires</span>
            <Select
              className="w-56"
              value={projectile?.tileId ?? ""}
              onValueChange={(tileId) =>
                tileId
                  ? patchProjectile({ tileId })
                  : onChange({ projectile: undefined })
              }
              options={[
                { value: "", label: "Nothing — melee" },
                ...projectileTiles.map((tile) => ({
                  value: tile.id,
                  label: tile.name,
                })),
              ]}
            />
            <span className="max-w-64 text-[11px] leading-snug text-muted">
              An 8-way tile, so the arrow points where it is going. Author one on
              the Tile tab if the list is empty.
            </span>
          </label>
          {projectile ? (
            <StatField
              label="Speed"
              hint="Cells per second. A body walks at five, so an arrow wants to be well past that."
              value={projectile.cellsPerSecond}
              min={MIN_PROJECTILE_SPEED}
              max={MAX_PROJECTILE_SPEED}
              onChange={(cellsPerSecond) => patchProjectile({ cellsPerSecond })}
              readout={describeFlight(reach, projectile)}
            />
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
        blurb={
          <>
            What a <strong>connecting blow</strong> leaves on whoever it lands
            on — venom on a fang, a burn on a brand. Rolled once per entry per
            blow that got through; a miss and a dodge leave nothing, and armour
            eating the damage does not save anybody from the venom. The chance
            is the weapon&rsquo;s own and no mastery moves it.
          </>
        }
        extra={StatusChanceField}
      />

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
                  ? `Teaches at full rate up to ${MASTERY_LABELS[mastery]} ${required}, then falls away fast: a fifth past it pays ${Math.round((1 / 1.2) ** OUTGROWN_FALLOFF * 100)}%, twice it pays ${Math.round(0.5 ** OUTGROWN_FALLOFF * 100)}%.`
                  : undefined
              }
            />
          );
        })}
      </div>

      <p className="max-w-lg text-[11px] leading-snug text-muted">
        <strong>These numbers are what the weapon is worth with every
        requirement exactly met.</strong> Requirements are pooled and capped:
        bringing 45 of the 55 points an axe asks for is 82% of the way there, and
        a surplus in one mastery never covers a shortfall in another. Below that,
        damage, accuracy and speed all fall on the cube of what you brought — 90%
        of the way there is {Math.round(0.9 ** REQUIREMENT_FALLOFF * 100)}% of
        the weapon, half way there is{" "}
        {Math.round(0.5 ** REQUIREMENT_FALLOFF * 100)}%. Above it nothing more is
        owed: a requirement is a gate, not a scale.
      </p>

      <p className="max-w-lg text-[11px] leading-snug text-muted">
        <strong>Being good with it is paid separately.</strong> The{" "}
        {MASTERY_LABELS[weapon.mastery]} mastery adds up to{" "}
        {DAMAGE_AT_MAX_MASTERY} damage and{" "}
        {ACCURACY_AT_MAX_MASTERY} accuracy flat, plus a quarter of what the
        weapon already brings — so a mastered starter weapon is a real weapon
        rather than a rounding error, and it keeps paying long after its
        requirements stopped.
      </p>

      <p className="max-w-lg text-[11px] leading-snug text-muted">
        <strong>How far it carries a wielder is a separate question.</strong> A
        weapon teaches at full rate right up to what it asks and then falls away
        on the sixth power, so there is very little to be had by standing still
        with it. Climbing means picking up the next weapon rather than swinging
        this one longer.
      </p>
    </div>
  );
}
