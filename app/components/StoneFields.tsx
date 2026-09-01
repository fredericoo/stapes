import type {
  ArcaneStoneItem,
  Reach,
  StoneEffect,
  StoneEffectKind,
  StoneSubject,
} from "../lib/item";
import {
  MAX_REACH_CELLS,
  MAX_REACH_HEIGHT,
  MAX_STONE_COOLDOWN_MS,
  MAX_STONE_HEAL,
  MELEE_REACH,
  MIN_STONE_COOLDOWN_MS,
  reachOf,
} from "../lib/item";
import { MASTERIES, MAX_MASTERY, MIN_MASTERY } from "../lib/mastery";
import type { StatusDef } from "../lib/status";
import type { TileDef } from "../lib/types";
import { Segmented, Select, Switch } from "../ui";
import { StatField } from "./StatField";
import {
  describeReachCells,
  describeReachHeight,
  MASTERY_LABELS,
} from "./WeaponFields";

/**
 * What an arcane stone is, in the editor.
 *
 * A component of its own rather than a branch inside `./ItemTab`, on the terms
 * `./WeaponFields` is one: a stone carries three blocks — an effect, a cost and
 * a gate — and each of them has something to explain, where every other arm of
 * the item union is one or two numbers with a caption.
 *
 * ## The effect is a picker, not a set of boxes
 *
 * Three kinds, closed, and switching between them replaces the block wholesale.
 * A draft that carried a tile id beside an amount of health would be a stone the
 * schema refuses and the editor renders wrong, which is exactly the trap the
 * item type select above it already avoids.
 */

const EFFECT_OPTIONS: Array<{ value: StoneEffectKind; label: string }> = [
  { value: "heal", label: "Heal" },
  { value: "status", label: "Status" },
  { value: "conjure", label: "Conjure" },
];

const SUBJECT_OPTIONS: Array<{ value: StoneSubject; label: string }> = [
  { value: "caster", label: "The caster" },
  { value: "target", label: "The target" },
];

/**
 * What each effect opens on when somebody picks it.
 *
 * Complete and inert: a fresh status arm names nothing, which the picker below
 * says out loud rather than guessing at a status from the catalogue — a stone
 * that silently applied whatever happened to be first in the file would be an
 * author's mistake wearing somebody else's authoring.
 */
const BLANK_EFFECTS: Record<StoneEffectKind, StoneEffect> = {
  heal: { kind: "heal", hp: 10 },
  status: { kind: "status", on: "caster", id: "" },
  conjure: { kind: "conjure", tileId: "" },
};

/** A cooldown reads far better in seconds than in five digits of milliseconds. */
const MS_PER_SECOND = 1000;

/** And past a minute it reads better still in minutes, which is where the shipped stones live. */
const SECONDS_PER_MINUTE = 60;

export function StoneFields({
  stone,
  onChange,
  tiles,
  statusDefs = {},
}: {
  stone: ArcaneStoneItem;
  onChange: (fields: Partial<ArcaneStoneItem>) => void;
  /**
   * The whole library, so a conjure can be pointed at the tile it places.
   * Handed in rather than looked up, on the terms the projectile picker's is:
   * this component resolves nothing about the world.
   */
  tiles: TileDef[];
  /**
   * The status catalogue, so what a stone starts can be picked by name rather
   * than by an id somebody has to remember. Empty where nothing is authored, in
   * which case the section says so instead of offering an empty dropdown.
   */
  statusDefs?: Record<string, StatusDef>;
}) {
  const effect = stone.effect;
  // Read through `reachOf` for the reason a weapon's is: the draft is the
  // authored block and the schema's default has not run on it, so a stone that
  // has never had a reach written on it reads as `undefined` here.
  const reach = reachOf(stone);
  const patchReach = (fields: Partial<Reach>) =>
    onChange({ reach: { ...reach, ...fields } });

  // **Every tile in the catalogue, unfiltered.** There is no property that makes
  // one conjurable — a flame, a wall, a puddle of blood are all placements, and
  // what a conjured tile *does* is whatever that tile does. Narrowing the list
  // would be this picker inventing a rule the simulation does not have.
  const conjureOptions = tiles.map((tile) => ({
    value: tile.id,
    label: tile.name,
  }));

  const statusOptions = Object.values(statusDefs).map((def) => ({
    value: def.id,
    label: def.name,
  }));

  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-lg text-[11px] leading-snug text-muted">
        <strong>Held and never swung at anybody.</strong> A stone sits out of the
        swing rotation exactly as a shield does, so carrying one costs a hand
        rather than a fight: one stone and a sword swings the sword every turn,
        and two stones falls back to fists. It goes in either hand or on the
        charm, and what it can do is decided by what you carry and how recently
        you used it — there is no mana anywhere in this game.
      </p>

      <div className="flex flex-col gap-1 text-xs">
        <span className="font-bold uppercase text-muted">Effect</span>
        <div>
          <Segmented<StoneEffectKind>
            value={effect.kind}
            onChange={(kind) => {
              if (kind === effect.kind) return;
              // Whole-block replacement rather than a patch, so the draft never
              // holds a tile id beside an amount of health. `itemForSave` would
              // drop the stray field on the way to disk anyway, but a draft that
              // is briefly both is a draft the editor renders wrong.
              onChange({ effect: { ...BLANK_EFFECTS[kind] } });
            }}
            options={EFFECT_OPTIONS}
            size="sm"
            ariaLabel="Stone effect"
          />
        </div>
      </div>

      {effect.kind === "heal" ? (
        <>
          <StatField
            label="Heal"
            hint="Health put back into whoever cast it."
            value={effect.hp}
            min={1}
            max={MAX_STONE_HEAL}
            onChange={(hp) => onChange({ effect: { kind: "heal", hp } })}
          />
          <p className="max-w-lg text-[11px] leading-snug text-muted">
            Always the caster, never the target. What it earns is the health it
            actually <strong>restored</strong> rather than the number above, so
            pressing it at full health earns nothing beyond the flat fee every
            cast is paid.
          </p>
        </>
      ) : effect.kind === "status" ? (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-bold uppercase text-muted">Status</span>
            {statusOptions.length === 0 ? (
              <span className="text-[11px] text-muted">
                Nothing authored yet — statuses live on the Statuses page.
              </span>
            ) : (
              <Select
                value={effect.id || null}
                onValueChange={(id) =>
                  onChange({ effect: { ...effect, id: id ?? "" } })
                }
                options={statusOptions}
                placeholder="Pick a status…"
                className="w-48"
                ariaLabel="Status this stone starts"
              />
            )}
          </label>

          <div className="flex flex-col gap-1 text-xs">
            <span className="font-bold uppercase text-muted">Lands on</span>
            <div>
              <Segmented<StoneSubject>
                value={effect.on}
                onChange={(on) => onChange({ effect: { ...effect, on } })}
                options={SUBJECT_OPTIONS}
                size="sm"
                ariaLabel="Who the status lands on"
              />
            </div>
            <span className="max-w-lg text-[11px] leading-snug text-muted">
              A stone that lands on the caster works with nothing targeted and
              can never misfire at an enemy. One that lands on the target needs
              somebody targeted and has to be in range. A stone worn on the{" "}
              <strong>charm</strong> ignores this and always acts on its wearer —
              a charm reaches nobody but the person carrying it.
            </span>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-bold uppercase text-muted">Conjures</span>
            <Select
              value={effect.tileId || null}
              onValueChange={(tileId) =>
                onChange({ effect: { kind: "conjure", tileId: tileId ?? "" } })
              }
              options={conjureOptions}
              placeholder="Pick a tile…"
              className="w-48"
              ariaLabel="Tile this stone conjures"
            />
            <span className="max-w-lg text-[11px] leading-snug text-muted">
              Placed at the target&rsquo;s cell, or in front of the caster when
              nothing is targeted — the player never picks a square.{" "}
              <strong>Give it a decay lifetime</strong>, or the battlefield fills
              up with everything anybody has ever cast.
            </span>
          </label>
        </div>
      )}

      <div className="flex flex-wrap gap-4 border-t-2 border-border pt-3">
        <StatField
          label="Cooldown"
          hint="Seconds before this particular stone can be pressed again."
          value={Math.round(stone.cooldownMs / MS_PER_SECOND)}
          min={MIN_STONE_COOLDOWN_MS / MS_PER_SECOND}
          max={MAX_STONE_COOLDOWN_MS / MS_PER_SECOND}
          onChange={(seconds) =>
            onChange({ cooldownMs: seconds * MS_PER_SECOND })
          }
          readout={describeCooldown(stone.cooldownMs)}
        />
        <StatField
          label="Reach"
          hint="How far it carries across the floor, as a radius in cells. Only read when it acts on somebody else."
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
        The cooldown belongs to <strong>this stone</strong> and not to the kind of
        stone — two of these in two hands cool independently — and it is{" "}
        <strong>spent whether or not the spell accomplished anything</strong>, on
        the terms a swing costs its wait before the dice are rolled. A cooling
        stone is locked in its square: it cannot be moved, swapped or put down
        until it is ready, so nobody beats the wait by rotating stones out of a
        bag. Reach and height are read only for a stone that acts on somebody
        else; a heal and a charm are always at arm&rsquo;s length. Default is{" "}
        {MELEE_REACH.cells} cells.
      </p>

      <label className="flex items-start gap-2 border-t-2 border-border pt-3 text-xs">
        <Switch
          checked={stone.automatic === true}
          onCheckedChange={(automatic) => onChange({ automatic })}
          ariaLabel="Automatic"
        />
        <span className="flex flex-col gap-1">
          <span className="font-bold uppercase text-muted">Automatic</span>
          <span className="max-w-72 text-[11px] leading-snug text-muted">
            On, it fires by itself the moment it is ready and would not be
            wasted: a heal waits until its wearer is hurt, a status until they
            are not already under it. It gets no button, because there is nothing
            to press — and it may only be worn on the <strong>charm</strong>,
            since a hand that acted on its own would be a body casting spells
            nobody asked it to.
          </span>
        </span>
      </label>

      <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
        <span className="text-xs font-bold uppercase text-muted">Requires</span>
        <p className="max-w-lg text-[11px] leading-snug text-muted">
          What it takes to cast this at all. Unlike a weapon&rsquo;s
          requirements, an unmet one <strong>refuses the cast</strong> rather
          than making it feeble: a stone either answers you or it does not.
          Arcane is also what casting <em>teaches</em>, so what you ask for here
          is what the stone stops being worth training on &mdash; though every
          cast pays a small flat amount whatever the stone is, so a stone that
          asks nothing is still a way onto the ladder.
        </p>
        <div className="flex flex-wrap gap-4">
          {MASTERIES.map((mastery) => (
            <StatField
              key={mastery}
              label={MASTERY_LABELS[mastery]}
              hint={
                mastery === "arcane" ? "The mastery casting this trains." : ""
              }
              value={stone.requirements?.[mastery] ?? 0}
              min={MIN_MASTERY}
              max={MAX_MASTERY}
              onChange={(level) =>
                onChange({
                  requirements: { ...stone.requirements, [mastery]: level },
                })
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * What a cooldown reads as, in the units somebody would say it in.
 *
 * Minutes past a minute, because the stones worth authoring live there — a
 * two-minute flame reads as "2m" and not as "120s", and a reader skimming the
 * file should not have to divide.
 */
function describeCooldown(cooldownMs: number): string {
  const seconds = Math.round(cooldownMs / MS_PER_SECOND);
  if (seconds < SECONDS_PER_MINUTE) return `Ready again after ${seconds}s.`;
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const rest = seconds % SECONDS_PER_MINUTE;
  return `Ready again after ${minutes}m${rest ? ` ${rest}s` : ""}.`;
}
