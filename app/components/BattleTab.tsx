import { useMemo } from "react";
import type { BattlerDef } from "../lib/battler";
import { DEFAULT_BATTLER, fightingStats, MAX_BASE_HP, MIN_BASE_HP } from "../lib/battler";
import { attackIntervalMs, dodgeChance } from "../game/combat";
import type { Element } from "../lib/element";
import { hasAnyInteraction, type TileInteractions } from "../lib/interactions";
import type { WeaponItem } from "../lib/item";
import { UNNAMED_WEAPON, resolveItem } from "../lib/item";
import { MAX_MASTERY, type Mastery, masteryLevel, MIN_MASTERY } from "../lib/mastery";
import type { Kit } from "../lib/kit";
import type { StatusDef } from "../lib/status";
import type { TileDef } from "../lib/types";
import { FieldLabel, Input, SectionTitle, Select, Switch } from "../ui";
import { BattlerIssues } from "./BattlerIssues";
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
  /**
   * Why the block, as Save would write it, would not load — worked out once in
   * the dialog, since Save is gated on the same answer. See `./BattlerIssues`.
   */
  battlerIssues: readonly string[];
};

const MASTERY_FIELDS: Array<{ mastery: Mastery; label: string; hint?: string }> = [
  { mastery: "toughness", label: "Toughness", hint: "Hit points." },
  { mastery: "agility", label: "Agility", hint: "Flee." },
  { mastery: "fist", label: "Fist" },
  { mastery: "sharp", label: "Sharp" },
  { mastery: "blunt", label: "Blunt" },
  { mastery: "ranged", label: "Ranged" },
  { mastery: "arcane", label: "Arcane" },
  // The elements, which are what this body can *cast* and emphatically not what
  // it is made of — see the Elements control below, which is the other question.
  // Here because the `player` tile's starting point in each of them is the
  // element half of what the bottom rung of every element asks — the other half
  // is Arcane, and it is deliberately out of a new player's reach — and a number
  // nobody can see is a number nobody can tune.
  { mastery: "fire", label: "Fire", hint: "Casting only." },
  { mastery: "water", label: "Water", hint: "Casting only." },
  { mastery: "nature", label: "Nature", hint: "Casting only." },
];

/**
 * What this evasion is worth against something slow and against something
 * quick. Read out of the contest itself, since a logistic is not something
 * anybody can eyeball from a number in a box.
 *
 * **The other side of the contest is a body, not a weapon.** It used to be quoted
 * against two weapon accuracies, which stopped being the question the day the
 * dodge became Agility against Agility — see `../game/combat`'s `dodgeChance`.
 * The two brackets are evasions rather than accuracies now, and they are the
 * ones the world is actually authored between: a cave troll at the bottom and a
 * bat at the top.
 */
function describeDodge(flee: number): string {
  const versusSlow = Math.round(dodgeChance(flee, SLUGGISH_REFLEX) * 100);
  const versusQuick = Math.round(dodgeChance(flee, QUICK_REFLEX) * 100);
  return `Dodges ${versusSlow}% of a slow body's blows, ${versusQuick}% of a quick one's.`;
}

/**
 * The two ends the readout above brackets, in `flee` rather than in Agility.
 *
 * Authored numbers rather than derived ones on purpose: they are a *scale* for
 * reading the figure beside them, and a scale that moved every time somebody
 * re-authored the troll would make two readouts taken a week apart
 * incomparable. The cave troll sits at 26 and the bat at 65, so these are the
 * world as it stands, rounded to numbers a person can hold.
 */
const SLUGGISH_REFLEX = 25;
const QUICK_REFLEX = 65;

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
 * They are all still real and only one of them is authored: flee comes off the
 * masteries, four are the natural weapon's, and hit points are the masteries'
 * plus the one number an author still types. Base HP is that number, and it is
 * here because how big a body is does not fall out of what it has practised —
 * see `../lib/battler`'s {@link BattlerDef.baseHp}. The readout at the bottom is
 * the same derivation the simulation runs, which is the only honest way to show
 * numbers nobody types — a readout that could disagree with the formula would be
 * worse than none.
 */
/**
 * The option standing for "leaves nothing".
 *
 * The empty string rather than a word, because a tile id is never empty — every
 * schema that takes one demands a character — so this can never collide with
 * something an author could name. The placeholder is set to the same label, so
 * a select holding it reads as the answer it is rather than as a question
 * nobody got to yet: leaving nothing behind is what every body in the world
 * does.
 */
const NOTHING_LEFT = "";

export function BattleTab({ draft, onChange, tiles, statusDefs = {}, battlerIssues }: Props) {
  const battler = draft.interactions?.battler ?? DEFAULT_BATTLER;
  // A draft loaded from a file authored before `baseHp` existed carries none,
  // and this tab is shown on the Kind select's answer rather than on a
  // successful parse — so the box needs something to render while the author
  // fixes what `resolveBattler` is meanwhile reading as "not a battler".
  const baseHp = battler.baseHp ?? DEFAULT_BATTLER.baseHp;

  const setBattler = (next: BattlerDef) => {
    const merged: TileInteractions = { ...draft.interactions, battler: next };
    onChange({
      ...draft,
      interactions: hasAnyInteraction(merged) ? merged : undefined,
    });
  };

  const setBaseHp = (baseHp: number) => setBattler({ ...battler, baseHp });

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

  const setElements = (elements: Element[]) => setBattler({ ...battler, elements });

  // Absent rather than an empty array, on the terms every other optional field
  // on this block is written: a body that takes everything carries no key.
  const setImmuneTo = (immuneTo: string[]) =>
    setBattler({ ...battler, immuneTo: immuneTo.length ? immuneTo : undefined });

  const patchWeapon = (fields: Partial<WeaponItem>) => {
    setBattler({
      ...battler,
      naturalWeapon: { ...battler.naturalWeapon, ...fields },
    });
  };

  // The carryable half of the library, once for the panel: what a body leaves
  // behind is a thing somebody picks up, on `./KitEditor`'s own terms.
  const remainsOptions = useMemo(
    () => [
      { value: NOTHING_LEFT, label: "Nothing" },
      ...tiles
        .filter((tile) => resolveItem(tile) != null)
        .map((tile) => ({ value: tile.id, label: tile.name })),
    ],
    [tiles],
  );

  const setRemains = (tileId: string | null) =>
    setBattler({
      ...battler,
      remains: tileId && tileId !== NOTHING_LEFT ? tileId : undefined,
    });

  const stats = fightingStats(battler, battler.naturalWeapon);

  return (
    <div className="flex flex-col gap-4">
      <BattlerIssues issues={battlerIssues} />
      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <SectionTitle info="Every placement starts at full health, can be targeted and attacked, and is deleted from the map at zero. Independent of Actor and of the brain.">
          Battler
        </SectionTitle>

        <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
          <StatField
            label="Base HP"
            info="Hit points at Toughness zero. Added to what Toughness buys rather than scaling it, so a point of Toughness is worth the same to a rat and to a boss. This is how big the body is, not how trained."
            hint="How much killing this body takes untrained."
            value={baseHp}
            min={MIN_BASE_HP}
            max={MAX_BASE_HP}
            onChange={setBaseHp}
          />
        </div>

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
          <FieldLabel info="Conditions this body simply cannot take, whatever tries to start one — the food, the blade dipped in it, the hearth or the spell. Not a resistance: a wolf is not less made ill by carrion, it eats carrion and is fine.">
            Immune to
          </FieldLabel>
          <StatusToggles
            statusDefs={statusDefs}
            picked={battler.immuneTo ?? []}
            onChange={setImmuneTo}
          />
        </div>

        <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
          <FieldLabel info="Used with empty hands — a bite, a claw, fists. Anything held replaces it rather than adding to it.">
            Natural weapon
          </FieldLabel>
          <label className="flex flex-col gap-1 text-xs">
            <FieldLabel info="What this blow is called where something has to name it — a skull engraved with what killed you. Only a natural weapon needs one: a weapon you can pick up is a tile, and the tile already has a name.">
              Name
            </FieldLabel>
            <Input
              placeholder={UNNAMED_WEAPON}
              value={battler.naturalWeapon.name ?? ""}
              onChange={(e) => patchWeapon({ name: e.target.value })}
            />
          </label>
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

        <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
          <FieldLabel info="Dropped where this body falls, beside whatever it was carrying. Engraved with who it was and described by what killed it — a tile whose name says %s reads as “Arthur's skull”, one without simply ignores it. Leave it at Nothing for anything you do not want a keepsake of: a world where every rat drops one fills up fast.">
            Remains
          </FieldLabel>
          <Select
            value={battler.remains || NOTHING_LEFT}
            onValueChange={setRemains}
            options={remainsOptions}
            placeholder="Nothing"
            ariaLabel="What this body leaves where it falls"
          />
        </div>

        <div className="flex flex-col gap-1 border-t-2 border-border pt-3">
          <FieldLabel info="Not authored: the same arithmetic the simulation runs, bare-handed.">
            Derived stats
          </FieldLabel>
          <dl className="mt-1 flex flex-wrap gap-x-6 gap-y-1 text-[11px]">
            <Derived label="Max HP" value={`${stats.maxHp}`} />
            <Derived label="Damage" value={`${stats.damage}`} />
            <Derived label="Def" value={`${stats.def}`} />
            <Derived label="Flee" value={`${stats.flee}`} note={describeDodge(stats.flee)} />
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

/**
 * Which statuses are ticked, as one toggle apiece.
 *
 * A row of switches rather than the searchable panel a tile picker uses, because
 * the status catalogue is a handful of authored conditions rather than a library
 * of hundreds — every one of them fits on screen, and a list you can see is
 * quicker to answer "what is this immune to" from than one you have to search.
 */
function StatusToggles({
  statusDefs,
  picked,
  onChange,
}: {
  statusDefs: Record<string, StatusDef>;
  picked: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const catalogue = Object.values(statusDefs);
  if (catalogue.length === 0) {
    return <p className="text-[11px] text-muted">None authored — see the Statuses page.</p>;
  }

  const has = new Set(picked);
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {catalogue.map((def) => (
        <label key={def.id} className="flex items-center gap-1.5 text-xs">
          <Switch
            checked={has.has(def.id)}
            ariaLabel={`Immune to ${def.name}`}
            onCheckedChange={(on) =>
              onChange(on ? [...picked, def.id] : picked.filter((id) => id !== def.id))
            }
          />
          {def.name}
        </label>
      ))}
    </div>
  );
}

function Derived({ label, value, note }: { label: string; value: string; note?: string }) {
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
