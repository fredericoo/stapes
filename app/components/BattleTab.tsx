import type { BattlerDef } from "../lib/battler";
import { DEFAULT_BATTLER, fightingStats } from "../lib/battler";
import { attackIntervalMs, dodgeChance } from "../game/combat";
import type { Element } from "../lib/element";
import { hasAnyInteraction, type TileInteractions } from "../lib/interactions";
import type { WeaponItem } from "../lib/item";
import { MAX_PERCENT_STAT } from "../lib/item";
import {
  MAX_MASTERY,
  type Mastery,
  masteryLevel,
  MIN_MASTERY,
} from "../lib/mastery";
import type { Kit } from "../lib/kit";
import type { StatusDef } from "../lib/status";
import type { TileDef } from "../lib/types";
import { FieldLabel, SectionTitle } from "../ui";
import { ElementFields } from "./ElementFields";
import { KitEditor } from "./KitEditor";
import { StatField } from "./StatField";
import { describeInterval, WeaponFields } from "./WeaponFields";

type Props = {
  draft: TileDef;
  onChange: (next: TileDef) => void;
  /** The whole library — the kit table picks carryable tiles out of it. */
  tiles: TileDef[];
  /**
   * The status catalogue, for what this body's bite leaves behind. A natural
   * weapon is a weapon in every sense, venom included — see `./WeaponFields`.
   */
  statusDefs?: Record<string, StatusDef>;
};

const MASTERY_FIELDS: Array<{ mastery: Mastery; label: string; hint?: string }> = [
  { mastery: "toughness", label: "Toughness", hint: "Hit points." },
  { mastery: "agility", label: "Agility", hint: "Flee." },
  { mastery: "fist", label: "Fist" },
  { mastery: "blade", label: "Blade" },
  { mastery: "blunt", label: "Blunt" },
  { mastery: "ranged", label: "Ranged" },
  { mastery: "arcane", label: "Arcane" },
  // The elements, which are what this body can *cast* and emphatically not what
  // it is made of — see the Elements control below, which is the other question.
  // Here because the `player` tile's starting point in each of them is what puts
  // the bottom rung of every element within a new player's reach, and a number
  // nobody can see is a number nobody can tune.
  { mastery: "fire", label: "Fire", hint: "Casting only." },
  { mastery: "water", label: "Water", hint: "Casting only." },
  { mastery: "nature", label: "Nature", hint: "Casting only." },
];

/**
 * What this evasion is worth against a typical weapon and against the best
 * there is. Read out of the contest itself, since a logistic is not something
 * anybody can eyeball from a number in a box.
 */
function describeDodge(flee: number): string {
  const typical = Math.round(dodgeChance(flee, 85) * 100);
  const best = Math.round(dodgeChance(flee, MAX_PERCENT_STAT) * 100);
  return `Dodges ${typical}% at 85 accuracy, ${best}% at 100.`;
}

/**
 * What this body is good at, and what it fights with.
 *
 * A tab of its own rather than another section on Interactive, because being a
 * battler is not something the player *does* to a tile — it is something the
 * tile is. The brain earned its own tab on the same grounds.
 *
 * There is no switch in here. Whether a tile is a battler is the Kind select's
 * answer, and this tab is only shown when that answer is yes. `battler` can
 * still read as absent for one render while a draft is being rebuilt, which is
 * the only reason for the fallback.
 *
 * ## Why there are no stats to edit here any more
 *
 * There used to be six boxes — max HP, attack, defence, accuracy, flee, speed.
 * They are all still real and none of them is authored: hit points and flee come
 * off the masteries, and the other four are the natural weapon's. The readout at
 * the bottom is the same derivation the simulation runs, which is the only
 * honest way to show numbers nobody types — a readout that could disagree with
 * the formula would be worse than none.
 */
export function BattleTab({ draft, onChange, tiles, statusDefs = {} }: Props) {
  const battler = draft.interactions?.battler ?? DEFAULT_BATTLER;

  const setBattler = (next: BattlerDef) => {
    const merged: TileInteractions = { ...draft.interactions, battler: next };
    onChange({
      ...draft,
      interactions: hasAnyInteraction(merged) ? merged : undefined,
    });
  };

  const setMastery = (mastery: Mastery, level: number) => {
    setBattler({
      ...battler,
      // Written even at zero rather than deleted, so a level typed back down to
      // nothing does not make the field jump to whatever a blank input renders
      // as mid-edit. `interactionsForSave` drops the zeroes on the way to disk.
      masteries: { ...battler.masteries, [mastery]: level },
    });
  };

  const setKit = (kit: Kit) => setBattler({ ...battler, kit });

  const setElements = (elements: Element[]) =>
    setBattler({ ...battler, elements });

  const patchWeapon = (fields: Partial<WeaponItem>) => {
    setBattler({
      ...battler,
      naturalWeapon: { ...battler.naturalWeapon, ...fields },
    });
  };

  const stats = fightingStats(battler, battler.naturalWeapon);

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <SectionTitle info="Every placement starts at full health, can be targeted and attacked, and is deleted from the map at zero. Independent of Actor and of the brain.">
          Battler
        </SectionTitle>

        <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
          <FieldLabel info="Fixed for a creature — it never improves. Toughness gives hit points and Agility gives flee; the rest scale whatever it is holding.">
            Masteries
          </FieldLabel>
          <div className="flex flex-wrap gap-4">
            {MASTERY_FIELDS.map(({ mastery, label, hint }) => (
              <StatField
                key={mastery}
                label={label}
                hint={hint}
                value={masteryLevel(battler.masteries, mastery)}
                min={MIN_MASTERY}
                max={MAX_MASTERY}
                onChange={(level) => setMastery(mastery, level)}
              />
            ))}
          </div>
        </div>

        <div className="border-t-2 border-border pt-3">
          <ElementFields
            label="Elements"
            info="What the body is, for incoming elemental damage — a cave troll is fire, a rat is nothing. Authored here, never read off the masteries: those are what it can cast. Whatever it wears is added."
            elements={battler.elements}
            onChange={setElements}
          />
        </div>

        <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
          <FieldLabel info="Used with empty hands — a bite, a claw, fists. Anything held replaces it rather than adding to it.">
            Natural weapon
          </FieldLabel>
          <WeaponFields
            weapon={battler.naturalWeapon}
            onChange={patchWeapon}
            masteryInfo="Scales this weapon, and is what the body trains by using it."
            tiles={tiles}
            statusDefs={statusDefs}
          />
        </div>

        <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
          <FieldLabel info="Rolled once when the body is placed, and again on respawn. Whatever it holds when it dies is dropped where it fell. Several rows on one slot roll top-down; the first hit takes it, so a rare thing goes above a common one.">
            Starting kit
          </FieldLabel>
          <KitEditor kit={battler.kit ?? []} tiles={tiles} onChange={setKit} />
        </div>

        <div className="flex flex-col gap-1 border-t-2 border-border pt-3">
          <FieldLabel info="Not authored: the same arithmetic the simulation runs, bare-handed.">
            Derived stats
          </FieldLabel>
          <dl className="mt-1 flex flex-wrap gap-x-6 gap-y-1 text-[11px]">
            <Derived label="Max HP" value={`${stats.maxHp}`} />
            <Derived label="Damage" value={`${stats.damage}`} />
            <Derived label="Def" value={`${stats.def}`} />
            <Derived
              label="Flee"
              value={`${stats.flee}`}
              note={describeDodge(stats.flee)}
            />
            <Derived
              label="Speed"
              value={`${stats.spd}`}
              note={describeInterval(attackIntervalMs(stats.spd))}
            />
          </dl>
        </div>
      </section>
    </div>
  );
}

function Derived({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="flex flex-col">
      <dt className="font-bold uppercase text-muted">{label}</dt>
      <dd className="text-ink">
        <strong>{value}</strong>
        {note ? <span className="block text-muted">{note}</span> : null}
      </dd>
    </div>
  );
}
