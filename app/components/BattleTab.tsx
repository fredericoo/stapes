import type { BattlerDef } from "../lib/battler";
import { DEFAULT_BATTLER, fightingStats } from "../lib/battler";
import { attackIntervalMs, dodgeChance } from "../game/combat";
import { hasAnyInteraction, type TileInteractions } from "../lib/interactions";
import type { WeaponItem } from "../lib/item";
import { MAX_PERCENT_STAT } from "../lib/item";
import {
  MASTERIES,
  MAX_MASTERY,
  type Mastery,
  masteryLevel,
  MIN_MASTERY,
} from "../lib/mastery";
import type { Kit } from "../lib/kit";
import type { TileDef } from "../lib/types";
import { KitEditor } from "./KitEditor";
import { StatField } from "./StatField";
import { describeInterval, WeaponFields } from "./WeaponFields";

type Props = {
  draft: TileDef;
  onChange: (next: TileDef) => void;
  /** The whole library — the kit table picks carryable tiles out of it. */
  tiles: TileDef[];
};

const MASTERY_FIELDS: Array<{ mastery: Mastery; label: string; hint: string }> = [
  {
    mastery: "toughness",
    label: "Toughness",
    hint: "Hit points. Earned by taking blows worth taking.",
  },
  {
    mastery: "agility",
    label: "Agility",
    hint: "Getting out of the way. Earned by dodging, and a little by landing blows.",
  },
  {
    mastery: "fist",
    label: "Fist",
    hint: "Bare hands, and anything else answering to Fist.",
  },
  { mastery: "blade", label: "Blade", hint: "Swords, knives, anything edged." },
  { mastery: "blunt", label: "Blunt", hint: "Clubs, axes, anything heavy." },
  { mastery: "ranged", label: "Ranged", hint: "Bows and thrown things." },
  { mastery: "arcane", label: "Arcane", hint: "Staves, and magic generally." },
];

/**
 * What this evasion is worth against a typical weapon and against the best
 * there is. Read out of the contest itself, since a logistic is not something
 * anybody can eyeball from a number in a box.
 */
function describeDodge(flee: number): string {
  const typical = Math.round(dodgeChance(flee, 85) * 100);
  const best = Math.round(dodgeChance(flee, MAX_PERCENT_STAT) * 100);
  return `Dodges % against 85 accuracy, % against 100.`;
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
 * off the masteries, and the other four are the natural weapon's. The preview at
 * the bottom is the same derivation the simulation runs, which is the only
 * honest way to show numbers nobody types — a readout that could disagree with
 * the formula would be worse than none.
 */
export function BattleTab({ draft, onChange, tiles }: Props) {
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
        <span className="text-sm font-bold">Battler</span>
        <p className="text-[11px] leading-snug text-muted">
          This tile has hit points. Every placement starts at full health, can be
          targeted and attacked, and is <strong>deleted from the map</strong> the
          moment it reaches zero. Independent of <strong>Actor</strong> and of
          the brain: what a body can take is a separate question from what drives
          it.
        </p>

        <div className="flex flex-col gap-1 border-t-2 border-border pt-3">
          <span className="text-xs font-bold uppercase text-muted">
            Masteries
          </span>
          <p className="max-w-lg text-[11px] leading-snug text-muted">
            What this body is good at. A creature's are fixed — it never gets
            better. Toughness and Agility decide what it can take; the rest decide
            how well it uses whatever it is holding.
          </p>
        </div>

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

        <div className="flex flex-col gap-1 border-t-2 border-border pt-3">
          <span className="text-xs font-bold uppercase text-muted">
            Natural weapon
          </span>
          <p className="max-w-lg text-[11px] leading-snug text-muted">
            What this body fights with when its hands are empty — a bite, a claw,
            a pair of fists. Anything it picks up <strong>replaces</strong> this
            rather than adding to it.
          </p>
        </div>

        <WeaponFields
          weapon={battler.naturalWeapon}
          onChange={patchWeapon}
          masteryHint="Which mastery scales this weapon — and which one this body earns by using it."
          tiles={tiles}
        />

        <div className="flex flex-col gap-1 border-t-2 border-border pt-3">
          <span className="text-xs font-bold uppercase text-muted">Kit</span>
          <p className="max-w-lg text-[11px] leading-snug text-muted">
            What a body of this kind is born carrying — the same three slots a
            player drags things between, so a torch here lights the room and a
            sword here gets swung. Rolled once, when the body is put on the
            board; a creature that <strong>respawns rolls again</strong>, and
            anything it is holding when it dies is{" "}
            <strong>left on the floor where it fell</strong>.
          </p>
          <p className="max-w-lg text-[11px] leading-snug text-muted">
            Several rows may name one slot: they are rolled top down and the
            first that comes up takes it, which is how a rare thing is written
            above a common one.
          </p>
        </div>

        <KitEditor kit={battler.kit ?? []} tiles={tiles} onChange={setKit} />

        <div className="flex flex-col gap-1 border-t-2 border-border pt-3">
          <span className="text-xs font-bold uppercase text-muted">
            Fights as
          </span>
          <p className="max-w-lg text-[11px] leading-snug text-muted">
            Derived, not authored — the same arithmetic the simulation runs, with
            this body's bare hands.
          </p>
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
