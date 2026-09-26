import type {
  ArcaneStoneItem,
  Reach,
  StoneEffect,
  StoneEffectKind,
  StoneSubject,
} from "../lib/item";
import {
  MAX_CAST_TIME_MS,
  MAX_PERCENT_STAT,
  MAX_REACH_CELLS,
  MAX_REACH_HEIGHT,
  MAX_SOUND_LENGTH,
  MAX_SPELL_DAMAGE,
  MAX_STONE_COOLDOWN_MS,
  MELEE_REACH,
  MIN_CAST_TIME_MS,
  MIN_PERCENT_STAT,
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
import { beats, EFFECTIVENESS_EDGE, type Element, ELEMENTS } from "../lib/element";
import type { StatusDef } from "../lib/status";
import { projectileTiles, resolveProjectile } from "../lib/projectile";
import type { TileDef } from "../lib/types";
import { FieldLabel, Input, Segmented, Select, SwitchField } from "../ui";
import { StatusGrants } from "./StatusGrants";
import { StatField } from "./StatField";
import {
  describeFlight,
  describeReachCells,
  describeReachHeight,
  describeReachMin,
} from "./WeaponFields";

const EFFECT_OPTIONS: Array<{ value: StoneEffectKind; label: string }> = [
  { value: "bolt", label: "Bolt" },
  { value: "conjure", label: "Conjure" },
];

const SUBJECT_OPTIONS: Array<{ value: StoneSubject; label: string }> = [
  { value: "caster", label: "Caster" },
  { value: "target", label: "Target" },
];

const BLANK_EFFECTS: Record<StoneEffectKind, StoneEffect> = {
  bolt: { kind: "bolt", damage: -10, on: "caster" },
  conjure: { kind: "conjure", tileId: "" },
};

const DEFAULT_STONE_STATUS_CHANCE = 100;

const MS_PER_SECOND = 1000;

const HALF_SECOND_MS = MS_PER_SECOND / 2;

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
  tiles: TileDef[];
  statusDefs?: Record<string, StatusDef>;
}) {
  const effect = stone.effect;
  const reach = reachOf(stone);
  const patchReach = (fields: Partial<Reach>) => onChange({ reach: { ...reach, ...fields } });

  const conjureOptions = tiles.map((tile) => ({
    value: tile.id,
    label: tile.name,
  }));

  const boltProjectile = stone.effect.kind === "bolt" ? stone.effect.projectile : undefined;
  const thrown = resolveProjectile(tiles.find((tile) => tile.id === boltProjectile));
  const projectileOptions = [
    ...projectileTiles(tiles).map((tile) => ({
      value: tile.id,
      label: tile.name,
    })),
    ...(boltProjectile && !thrown
      ? [{ value: boltProjectile, label: `${boltProjectile} (not a projectile)` }]
      : []),
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 text-xs">
        <FieldLabel info={EFFECT_INFO[effect.kind]}>Effect</FieldLabel>
        <div>
          <Segmented<StoneEffectKind>
            value={effect.kind}
            onChange={(kind) => {
              if (kind === effect.kind) return;
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
              <FieldLabel info="Caster: needs nothing targeted and never misfires. Target: needs somebody targeted, in range. The same in every square — the accessory square reaches as far as a hand.">
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
                <FieldLabel info="What this throws. A bolt and a bow's arrow are the same kind of thing and come out of the same list: tiles of the Projectile kind.">
                  Throws
                </FieldLabel>
                <Select
                  className="w-56"
                  value={effect.projectile ?? ""}
                  onValueChange={(id) =>
                    onChange({
                      effect: { ...effect, projectile: id ? id : undefined },
                    })
                  }
                  options={[{ value: "", label: "Nothing" }, ...projectileOptions]}
                />
              </label>
              {thrown ? (
                <span className="self-end text-[11px] text-muted">
                  {describeFlight(reach, thrown)}
                </span>
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
          onChange={(seconds) => onChange({ cooldownMs: seconds * MS_PER_SECOND })}
          readout={describeCooldown(stone.cooldownMs)}
        />
        <StatField
          label="Cast (s)"
          info="How long the caster stands there before anything happens, at exactly the requirements below. Every point past them is time off — 110% of what it asks casts in 90% of this, and double casts instantly. Zero is instant. A blow breaks a cast; nothing is spent until it lands."
          value={Math.round((stone.castTimeMs ?? 0) / HALF_SECOND_MS) / 2}
          min={0}
          max={MAX_CAST_TIME_MS / MS_PER_SECOND}
          step={HALF_SECOND_MS / MS_PER_SECOND}
          onChange={(seconds) =>
            onChange({
              castTimeMs:
                seconds > 0 ? Math.max(MIN_CAST_TIME_MS, seconds * MS_PER_SECOND) : undefined,
            })
          }
          readout={describeCastTime(stone.castTimeMs)}
        />
        <StatField
          label="Reach"
          info={`Radius in cells. Read only when the stone acts on somebody else; at the caster it is always at arm's length. Default ${MELEE_REACH.cells}.`}
          value={reach.cells}
          min={0}
          max={MAX_REACH_CELLS}
          step={0.5}
          onChange={(cells) => patchReach({ cells })}
          readout={describeReachCells(reach.cells)}
        />
        <StatField
          label="Minimum"
          info="How close is too close, in cells. Zero is no minimum. On the plan only, so somebody a floor below you is nought cells away and the Height lid is what refuses them."
          value={reach.min ?? 0}
          min={0}
          max={MAX_REACH_CELLS}
          step={0.5}
          onChange={(min) => patchReach({ min })}
          readout={describeReachMin(reach.min ?? 0, reach.cells)}
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
        <label className="flex flex-col gap-1 text-xs">
          <FieldLabel info="Comic-book noise shown over the caster as the spell lands. Not made for a cast that was broken or found nowhere to land. Blank is silent.">
            Sound
          </FieldLabel>
          <Input
            type="text"
            className="w-32"
            maxLength={MAX_SOUND_LENGTH}
            value={stone.sound ?? ""}
            placeholder="whoosh"
            onChange={(e) => onChange({ sound: e.target.value })}
          />
        </label>
      </div>

      {stone.castTimeMs ? (
        <SwitchField
          checked={stone.uninterruptible === true}
          onCheckedChange={(uninterruptible) =>
            onChange({ uninterruptible: uninterruptible || undefined })
          }
          label="Uninterruptible"
          info="Taking damage leaves this cast running. Off for everything else, which is what makes a long cast a decision about where you are standing."
        />
      ) : null}

      <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
        <FieldLabel info="An unmet requirement refuses the cast outright. Arcane is what casting trains, and every cast pays a small flat amount whatever the stone asks. An element asked for makes this a spell of that element; everybody starts with a point of each.">
          Requirements
        </FieldLabel>
        <ElementReading
          elements={spellElements(stone.requirements)}
          harms={stone.effect.kind !== "bolt" || (stone.effect.damage ?? 0) > 0}
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

function describeBolt(damage: number | undefined): string {
  if (!damage) return "Moves no health — only what it leaves.";
  return damage < 0 ? `Mends ${-damage} health.` : `Harms for ${damage}, before armour.`;
}

function describeCooldown(cooldownMs: number): string {
  const seconds = Math.round(cooldownMs / MS_PER_SECOND);
  if (seconds < SECONDS_PER_MINUTE) return `Ready again after ${seconds}s.`;
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const rest = seconds % SECONDS_PER_MINUTE;
  return `Ready again after ${minutes}m${rest ? ` ${rest}s` : ""}.`;
}

function describeCastTime(castTimeMs: number | undefined): string {
  if (!castTimeMs) return "Cast lands at once.";
  const seconds = Math.round(castTimeMs / HALF_SECOND_MS) / 2;
  return `${seconds}s at exactly the requirements, and nothing at double them.`;
}

function masteryHint(mastery: Mastery): string | undefined {
  if (mastery === "arcane") return "Trained by casting.";
  if ((ELEMENTS as Mastery[]).includes(mastery)) {
    return `Makes this a ${MASTERY_LABELS[mastery].toLowerCase()} spell.`;
  }
  return undefined;
}

function ElementReading({ elements, harms }: { elements: Element[]; harms: boolean }) {
  if (elements.length === 0) return null;

  const strong = ELEMENTS.filter((against) => elements.some((element) => beats(element, against)));
  const weak = ELEMENTS.filter(
    (against) => !strong.includes(against) && elements.some((element) => beats(against, element)),
  );
  const named = (list: Element[]) => list.map((element) => MASTERY_LABELS[element]).join(", ");
  const edge = Math.round((EFFECTIVENESS_EDGE - 1) * 100);

  if (!harms) {
    return (
      <p className="text-[11px] leading-snug text-muted">
        A <strong>{named(elements)}</strong> spell. A mend is never weighed on the wheel.
      </p>
    );
  }

  return (
    <p className="text-[11px] leading-snug text-muted">
      A <strong>{named(elements)}</strong> spell: {edge}% harder on {named(strong)} bodies
      {weak.length > 0 ? <>, softer on {named(weak)}</> : null}.
    </p>
  );
}
