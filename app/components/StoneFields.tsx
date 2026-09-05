import type {
  ArcaneStoneItem,
  ProjectileDef,
  Reach,
  StoneEffect,
  StoneEffectKind,
  StoneSubject,
} from "../lib/item";
import {
  DEFAULT_PROJECTILE_SPEED,
  MAX_PERCENT_STAT,
  MAX_PROJECTILE_SPEED,
  MAX_REACH_CELLS,
  MAX_REACH_HEIGHT,
  MAX_SPELL_DAMAGE,
  MAX_STONE_COOLDOWN_MS,
  MELEE_REACH,
  MIN_PERCENT_STAT,
  MIN_PROJECTILE_SPEED,
  MIN_STONE_COOLDOWN_MS,
  reachOf,
} from "../lib/item";
import {
  MASTERIES,
  MASTERY_LABELS,
  type Mastery,
  MAX_MASTERY,
  MIN_MASTERY,
  spellElements,
} from "../lib/mastery";
import {
  beats,
  EFFECTIVENESS_EDGE,
  type Element,
  ELEMENTS,
} from "../lib/element";
import type { StatusDef } from "../lib/status";
import type { TileDef } from "../lib/types";
import { FieldLabel, Segmented, Select, SwitchField } from "../ui";
import { StatusChanceField, StatusGrants } from "./StatusGrants";
import { StatField } from "./StatField";
import {
  describeFlight,
  describeReachCells,
  describeReachHeight,
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
  { value: "bolt", label: "Bolt" },
  { value: "conjure", label: "Conjure" },
];

const SUBJECT_OPTIONS: Array<{ value: StoneSubject; label: string }> = [
  { value: "caster", label: "Caster" },
  { value: "target", label: "Target" },
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
  // Negative and at the caster, on the terms `DEFAULT_STONE` opens that way: the
  // first press of a stone somebody is still writing should be safe to make
  // standing alone in a room.
  bolt: { kind: "bolt", damage: -10, on: "caster" },
  conjure: { kind: "conjure", tileId: "" },
};

/** What a bolt with no projectile authored is offered when it grows one. */
const STARTER_PROJECTILE: ProjectileDef = {
  tileId: "",
  cellsPerSecond: DEFAULT_PROJECTILE_SPEED,
};

/**
 * What a status added to a bolt opens at.
 *
 * A hundred, unlike a weapon's, and the difference is the cadence. A brand on a
 * sword is rolled thirty times a fight and wants a percentage; a stone is
 * pressed once every minute or two, and an author reaching for a status on one
 * almost always means "and it burns them" rather than "and it sometimes burns
 * them". They can type a smaller number; opening at one makes the common case
 * no typing at all.
 */
const DEFAULT_STONE_STATUS_CHANCE = 100;

/** A cooldown reads far better in seconds than in five digits of milliseconds. */
const MS_PER_SECOND = 1000;

/** And past a minute it reads better still in minutes, which is where the shipped stones live. */
const SECONDS_PER_MINUTE = 60;

const EFFECT_INFO: Record<StoneEffectKind, string> = {
  bolt: "Not aimed: no accuracy, no dodge — the cooldown is spent and the stone answers. Scaled by the caster's Arcane and the stone's elements, averaged; the figure is what it does for somebody who has learnt nothing. A harm goes through armour and the wheel. A mend is stopped by neither, stops at full health, and trains by what it actually restored.",
  conjure:
    "Places a tile at the target's cell, or in front of the caster with nothing targeted. The player never picks a square.",
};

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

  // Narrowed where the conjure list is not, and the asymmetry is the rule rather
  // than an inconsistency: anything can be placed on the board, and only an
  // 8-way tile can point where it is going. The one already picked is kept
  // whatever it is, so a tile that has since changed type is not silently
  // dropped out from under an author — the same tolerance `WeaponFields` shows.
  const boltProjectile =
    stone.effect.kind === "bolt" ? stone.effect.projectile : undefined;
  const projectileTiles = tiles.filter(
    (tile) => tile.type === "directional8" || tile.id === boltProjectile?.tileId,
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 text-xs">
        <FieldLabel info={EFFECT_INFO[effect.kind]}>Effect</FieldLabel>
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

      {effect.kind === "bolt" ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-start gap-4">
            <StatField
              label="Damage"
              info="Health it moves. Negative mends, positive harms, zero moves none."
              value={effect.damage ?? 0}
              min={-MAX_SPELL_DAMAGE}
              max={MAX_SPELL_DAMAGE}
              onChange={(damage) =>
                // Zero is a real answer and is stored as *absent*: a bolt that
                // only leaves a status behind moves no health, and a zero
                // written to disk would claim somebody decided the number.
                onChange({
                  effect: { ...effect, damage: damage || undefined },
                })
              }
              readout={describeBolt(effect.damage)}
            />
            <StatField
              label="Variance"
              info="How much one cast varies, as a share of the damage. 0 always does exactly what it says."
              value={effect.variance ?? 0}
              min={MIN_PERCENT_STAT}
              max={MAX_PERCENT_STAT}
              onChange={(variance) =>
                onChange({
                  effect: { ...effect, variance: variance || undefined },
                })
              }
            />

            <div className="flex flex-col gap-1 text-xs">
              <FieldLabel info="Caster: needs nothing targeted and never misfires. Target: needs somebody targeted, in range. Worn on the charm it always acts on its wearer.">
                Subject
              </FieldLabel>
              <div>
                <Segmented<StoneSubject>
                  value={effect.on}
                  onChange={(on) => onChange({ effect: { ...effect, on } })}
                  options={SUBJECT_OPTIONS}
                  size="sm"
                  ariaLabel="Who the bolt lands on"
                />
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <FieldLabel info="A picture only, drawn as a bow's arrow is: the health has moved before the first frame, so it cannot miss in the air. Nothing flies at the caster.">
              Projectile
            </FieldLabel>
            <div className="flex flex-wrap items-end gap-4">
              <label className="flex flex-col gap-1 text-xs">
                <FieldLabel info="8-way tiles only, so it points where it is going.">
                  Tile
                </FieldLabel>
                <Select
                  className="w-56"
                  value={effect.projectile?.tileId ?? ""}
                  onValueChange={(tileId) =>
                    onChange({
                      effect: {
                        ...effect,
                        projectile: tileId
                          ? { ...(effect.projectile ?? STARTER_PROJECTILE), tileId }
                          : undefined,
                      },
                    })
                  }
                  options={[
                    { value: "", label: "None" },
                    ...projectileTiles.map((tile) => ({
                      value: tile.id,
                      label: tile.name,
                    })),
                  ]}
                />
              </label>
              {effect.projectile ? (
                <StatField
                  label="Speed"
                  info="Cells per second. A body walks at five."
                  value={effect.projectile.cellsPerSecond}
                  min={MIN_PROJECTILE_SPEED}
                  max={MAX_PROJECTILE_SPEED}
                  onChange={(cellsPerSecond) =>
                    onChange({
                      effect: {
                        ...effect,
                        projectile: { ...effect.projectile!, cellsPerSecond },
                      },
                    })
                  }
                  readout={describeFlight(reach, effect.projectile)}
                />
              ) : null}
            </div>
          </div>

          <StatusGrants
            statuses={effect.statuses ?? []}
            statusDefs={statusDefs}
            onChange={(statuses) =>
              onChange({
                effect: {
                  ...effect,
                  statuses: statuses.length ? statuses : undefined,
                },
              })
            }
            blank={(id) => ({ id, chance: DEFAULT_STONE_STATUS_CHANCE })}
            info="Rolled once per entry per cast, on whoever it landed on. Armour eating the damage does not stop it; only a body that is not there, or one the cast killed, escapes. No mastery moves the chance. A bolt needs damage or a status — with neither it will not save."
            extra={StatusChanceField}
          />
        </div>
      ) : (
        <label className="flex flex-col gap-1 text-xs">
          <FieldLabel info="Give it a decay lifetime, or the battlefield fills with everything anybody has ever cast.">
            Tile
          </FieldLabel>
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
        </label>
      )}

      <div className="flex flex-wrap gap-4 border-t-2 border-border pt-3">
        <StatField
          label="Cooldown (s)"
          info="Per stone, not per kind — two in two hands cool independently. Spent whether or not the cast did anything. A cooling stone is locked in its square until ready."
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
          info={`Radius in cells. Read only when the stone acts on somebody else; at the caster and on the charm it is always at arm's length. Default ${MELEE_REACH.cells}.`}
          value={reach.cells}
          min={0}
          max={MAX_REACH_CELLS}
          step={0.5}
          onChange={(cells) => patchReach({ cells })}
          readout={describeReachCells(reach.cells)}
        />
        <StatField
          label="Height"
          info="Height units up or down — four to a level."
          value={reach.height}
          min={0}
          max={MAX_REACH_HEIGHT}
          step={0.5}
          onChange={(height) => patchReach({ height })}
          readout={describeReachHeight(reach.height)}
        />
      </div>

      <div className="border-t-2 border-border pt-3">
        <SwitchField
          checked={stone.automatic === true}
          onCheckedChange={(automatic) => onChange({ automatic })}
          label="Automatic"
          info="Fires by itself when ready and not wasted: a mend waits until its wearer is hurt, a status until they are not already under it. No button. Charm only."
        />
      </div>

      <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
        <FieldLabel info="An unmet requirement refuses the cast outright. Arcane is what casting trains, and every cast pays a small flat amount whatever the stone asks. An element asked for makes this a spell of that element; everybody starts with a point of each.">
          Requirements
        </FieldLabel>
        <ElementReading
          elements={spellElements(stone.requirements)}
          harms={
            stone.effect.kind !== "bolt" || (stone.effect.damage ?? 0) > 0
          }
        />
        <div className="flex flex-wrap gap-4">
          {MASTERIES.map((mastery) => (
            <StatField
              key={mastery}
              label={MASTERY_LABELS[mastery]}
              hint={masteryHint(mastery)}
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
 * Which way a bolt runs, in the words the panel would use for it.
 *
 * **The sign is the whole of the difference and a minus is one pixel wide**,
 * which is exactly why it is said in a word underneath. An author sweeping a
 * slider from a curse into a blessing should be told they have crossed over,
 * not left to notice a dash.
 *
 * Zero is neither, and says so: a bolt that moves no health is a real spell now
 * that a status can ride one, and the line points at the half that is doing the
 * work instead.
 */
function describeBolt(damage: number | undefined): string {
  if (!damage) return "Moves no health — only what it leaves.";
  return damage < 0
    ? `Mends ${-damage} health.`
    : `Harms for ${damage}, before armour.`;
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

/**
 * What a requirement row is *for*, in the two cases where it is not obvious.
 *
 * Arcane and the elements are the masteries casting pays into, and a number
 * typed against one of them is doing two jobs at once — see the tooltip on the
 * grid. Everything else here is an ordinary gate and needs no caption.
 */
function masteryHint(mastery: Mastery): string | undefined {
  if (mastery === "arcane") return "Trained by casting.";
  if ((ELEMENTS as Mastery[]).includes(mastery)) {
    return `Makes this a ${MASTERY_LABELS[mastery].toLowerCase()} spell.`;
  }
  return undefined;
}

/**
 * What the elements typed above come to, in a line.
 *
 * **The wheel is arithmetic nobody should have to do in their head.** An author
 * setting Fire on a stone has decided two things at once — what it demands and
 * what it is good and bad against — and the second of those is invisible in a
 * grid of numbers. So it is said out loud.
 *
 * Absent entirely for a spell made of nothing, which is most of them: a stone of
 * light is magic that is not made of anything, and a line saying so would be a
 * caption on every stone in the world.
 */
function ElementReading({
  elements,
  /**
   * Whether this spell can hurt anybody, which is the only thing the wheel
   * touches.
   *
   * **A mend is elemental and is never weighed**, because there is no second
   * body in the exchange for an element to be good against — so what its
   * elements buy is what it trains and how deep it runs, and saying otherwise
   * here would be the panel promising something the session does not do.
   */
  harms,
}: {
  elements: Element[];
  harms: boolean;
}) {
  if (elements.length === 0) return null;

  const strong = ELEMENTS.filter((against) =>
    elements.some((element) => beats(element, against)),
  );
  const weak = ELEMENTS.filter(
    (against) =>
      !strong.includes(against) &&
      elements.some((element) => beats(against, element)),
  );
  const named = (list: Element[]) =>
    list.map((element) => MASTERY_LABELS[element]).join(", ");
  const edge = Math.round((EFFECTIVENESS_EDGE - 1) * 100);

  if (!harms) {
    return (
      <p className="text-[11px] leading-snug text-muted">
        A <strong>{named(elements)}</strong> spell. A mend is never weighed on
        the wheel.
      </p>
    );
  }

  return (
    <p className="text-[11px] leading-snug text-muted">
      A <strong>{named(elements)}</strong> spell: {edge}% harder on{" "}
      {named(strong)} bodies
      {weak.length > 0 ? <>, softer on {named(weak)}</> : null}.
    </p>
  );
}
