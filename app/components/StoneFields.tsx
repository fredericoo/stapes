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
import { Segmented, Select, Switch } from "../ui";
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
  // Negative and at the caster, on the terms `DEFAULT_STONE` opens that way: the
  // first press of a stone somebody is still writing should be safe to make
  // standing alone in a room.
  bolt: { kind: "bolt", damage: -10, on: "caster" },
  status: { kind: "status", on: "caster", id: "" },
  conjure: { kind: "conjure", tileId: "" },
};

/** What a bolt with no projectile authored is offered when it grows one. */
const STARTER_PROJECTILE: ProjectileDef = {
  tileId: "",
  cellsPerSecond: DEFAULT_PROJECTILE_SPEED,
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

      {effect.kind === "bolt" ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-4">
            <StatField
              label="Damage"
              hint="Health it moves. Negative mends, positive harms."
              value={effect.damage}
              min={-MAX_SPELL_DAMAGE}
              max={MAX_SPELL_DAMAGE}
              onChange={(damage) =>
                // Zero is a bolt the schema refuses, so the field steps over it
                // rather than letting somebody save a spell that does nothing.
                onChange({
                  effect: { ...effect, damage: damage === 0 ? -1 : damage },
                })
              }
              readout={describeBolt(effect.damage)}
            />
            <StatField
              label="Variance"
              hint="How much one cast varies, as a share of the damage. Zero always does exactly what it says."
              value={effect.variance ?? 0}
              min={MIN_PERCENT_STAT}
              max={MAX_PERCENT_STAT}
              onChange={(variance) =>
                onChange({
                  effect: { ...effect, variance: variance || undefined },
                })
              }
            />
          </div>

          <div className="flex flex-col gap-1 text-xs">
            <span className="font-bold uppercase text-muted">Lands on</span>
            <div>
              <Segmented<StoneSubject>
                value={effect.on}
                onChange={(on) => onChange({ effect: { ...effect, on } })}
                options={SUBJECT_OPTIONS}
                size="sm"
                ariaLabel="Who the bolt lands on"
              />
            </div>
            <span className="max-w-lg text-[11px] leading-snug text-muted">
              A bolt at the caster works with nothing targeted and can never
              misfire at an enemy; one at the target needs somebody targeted and
              has to be in range. A stone worn on the <strong>charm</strong>{" "}
              ignores this and always acts on its wearer.
            </span>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-bold uppercase text-muted">
              Projectile
            </span>
            <p className="max-w-lg text-[11px] leading-snug text-muted">
              What it throws on the way, drawn exactly as a bow&rsquo;s arrow is
              and just as purely a picture: the health has already moved by the
              time the first frame appears, so a bolt cannot miss in the air and
              one that killed still finishes its flight.{" "}
              <strong>Nothing flies at the caster</strong> &mdash; a bolt at your
              own body has no distance to cross.
            </p>
            <div className="flex flex-wrap items-end gap-4">
              <label className="flex flex-col gap-1 text-xs">
                <span className="font-bold uppercase text-muted">Throws</span>
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
                    { value: "", label: "Nothing — it simply arrives" },
                    ...projectileTiles.map((tile) => ({
                      value: tile.id,
                      label: tile.name,
                    })),
                  ]}
                />
                <span className="max-w-64 text-[11px] leading-snug text-muted">
                  An 8-way tile, so it points where it is going. Author one on
                  the Tile tab if the list is empty.
                </span>
              </label>
              {effect.projectile ? (
                <StatField
                  label="Speed"
                  hint="Cells per second. A body walks at five, so a bolt wants to be well past that."
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

          <p className="max-w-lg text-[11px] leading-snug text-muted">
            <strong>A cast is not aimed.</strong> There is no accuracy and no
            dodge here &mdash; you spent the cooldown and the stone answered
            &mdash; so what is left of the dice is the variance above. What the
            number above is worth in somebody&rsquo;s hands is scaled by their{" "}
            <strong>Arcane</strong> and by the <strong>elements</strong> this
            stone asks for, averaged: the figure is what the stone does for
            somebody who has learnt nothing. A harm then has to get through the
            subject&rsquo;s armour and is weighed on the wheel; a mend is stopped
            by neither and stops at a full health bar, and earns what it{" "}
            <strong>actually restored</strong> rather than what it says.
          </p>
        </div>
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
        else; a spell at its own caster and a charm are always at arm&rsquo;s
        length. Default is{" "}
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
            wasted: a mending bolt waits until its wearer is hurt, a status
            until they
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
        <p className="max-w-lg text-[11px] leading-snug text-muted">
          The elements do a second job here: whichever you ask for is what this
          spell <strong>is made of</strong>. Everybody starts with a point of
          each, so asking for one is what puts the bottom rung of an element
          within reach. What a spell is made of is not the same question as what
          a <em>body</em> is made of &mdash; that is authored on the Battle tab
          and on what the body is wearing.
        </p>
        <ElementReading
          elements={spellElements(stone.requirements)}
          harms={stone.effect.kind !== "bolt" || stone.effect.damage > 0}
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
 */
function describeBolt(damage: number): string {
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
 * typed against one of them is doing two jobs at once — see the prose above the
 * grid. Everything else here is an ordinary gate and needs no caption.
 */
function masteryHint(mastery: Mastery): string {
  if (mastery === "arcane") return "The mastery casting this trains.";
  if ((ELEMENTS as Mastery[]).includes(mastery)) {
    const named = MASTERY_LABELS[mastery].toLowerCase();
    return `Asks it, trains it, and makes this a ${named} spell.`;
  }
  return "";
}

/**
 * What the elements typed above come to, in a sentence.
 *
 * **The wheel is arithmetic nobody should have to do in their head.** An author
 * setting Fire on a stone has decided two things at once — what it demands and
 * what it is good and bad against — and the second of those is invisible in a
 * grid of numbers. So it is said out loud, in the same voice the rest of this
 * panel explains itself in.
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
    list.map((element) => MASTERY_LABELS[element]).join(" and ");
  const edge = Math.round((EFFECTIVENESS_EDGE - 1) * 100);
  const kind = <strong>{named(elements).toLowerCase()}</strong>;

  if (!harms) {
    return (
      <p className="max-w-lg text-[11px] leading-snug text-muted">
        A {kind} spell, which here decides only what it trains &mdash; and how
        deep it runs in your hands. A mend has nobody on the other end of it for
        an element to be good against.
      </p>
    );
  }

  return (
    <p className="max-w-lg text-[11px] leading-snug text-muted">
      A {kind} spell. Its damage lands {edge}% harder on{" "}
      {named(strong).toLowerCase()} bodies
      {weak.length > 0 ? (
        <> and softer on {named(weak).toLowerCase()} ones</>
      ) : null}
      , measured against what the body it hits <em>is</em> and what it has on
      &mdash; never against what it has practised.
    </p>
  );
}
