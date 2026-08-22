import type { ArenaFighter } from "../game/arena";
import {
  bodyOf,
  equipmentOf,
  fighterForTile,
  statsOf,
  tilesForSlot,
} from "../game/arena";
import { weaponInHand } from "../game/equipment";
import {
  ACCURACY_AT_MAX_MASTERY,
  DAMAGE_AT_MAX_MASTERY,
  type FightingStats,
  weaponReadiness,
} from "../lib/battler";
import type { WeaponItem } from "../lib/item";
import { EQUIP_SLOTS, type EquipSlot } from "../lib/kit";
import {
  MASTERIES,
  MAX_MASTERY,
  type Mastery,
  MIN_MASTERY,
  rating,
  RATING_GLYPH,
  requirementShare,
} from "../lib/mastery";
import type { TileDef, TilesetDef } from "../lib/types";
import { Input, Select, Tooltip } from "../ui";
import { TilePreview } from "./TilePreview";

/**
 * One side of the match-up, as something to be set up rather than watched.
 *
 * ## Two things are editable and one deliberately is not
 *
 * **Masteries and equipment yes; the natural weapon no.** The first two are
 * things the world can produce — a mastery is earned and a weapon is picked up —
 * so a fight tuned around either is a fight that can actually happen. A natural
 * weapon is what the creature *is*: it is the axis that stops every animal from
 * being a bigger or smaller version of the same one (see `../lib/battler`), and
 * editing it here would be authoring a new creature in a tool with nowhere to
 * save it. It is shown in full and read-only, with the tile editor named as
 * where it is changed — a field you cannot edit and cannot see would just read
 * as missing.
 *
 * ## The derived block is the point of the panel
 *
 * Nothing above it is what a fight is fought with. `effectiveBattler` folds the
 * body, the masteries and both hands into eight numbers, and *those* are what
 * `../game/combat` reads — so showing them beside the inputs is what makes the
 * derivation legible instead of something to be inferred from the outcome.
 */

const SLOT_LABEL: Record<EquipSlot, string> = {
  weapon: "Weapon hand",
  offhand: "Off hand",
  bag: "Back",
};

const SLOT_HINT: Record<EquipSlot, string> = {
  weapon:
    "A held weapon replaces the natural one rather than adding to it. Empty means bare hands — which are a weapon like any other.",
  offhand:
    "Adds its defence and nothing else. It does not swing: a shield and a torch are what this slot is for.",
  bag: "Worn, and worth nothing in a fight. Here because it is a slot a body has, not because it changes a number.",
};

const MASTERY_HINT: Record<Mastery, string> = {
  fist: "What bare hands and every natural weapon answer to.",
  blade: "Swords and axes.",
  blunt: "Hammers, staves that are swung, anything that does not cut.",
  ranged: "Bows.",
  arcane: "Staves. Swinging one is how you get better at magic.",
  toughness: "Hit points, at one apiece over a base of 8.",
  agility: "Evasion, at one apiece over a base of 20. Contested, never a flat chance.",
};

export function ArenaFighterPanel({
  title,
  fighter,
  onChange,
  tiles,
  tilesById,
  tilesets,
  battlers,
}: {
  title: string;
  fighter: ArenaFighter;
  onChange: (next: ArenaFighter) => void;
  tiles: TileDef[];
  tilesById: Record<string, TileDef>;
  tilesets: TilesetDef[];
  battlers: TileDef[];
}) {
  const body = bodyOf(fighter, tilesById);
  const stats = statsOf(fighter, tilesById);

  return (
    <section className="flex min-w-0 flex-col gap-3 border-2 border-border bg-panel p-3">
      <header className="flex items-center gap-2">
        <h2 className="text-xs font-bold uppercase">{title}</h2>
        <Select
          value={fighter.tileId}
          // A new body brings its own masteries and keeps whatever is in its
          // hands. Those are the two halves of the question this page asks: a
          // creature is *what it is good at* — picking Snake and being handed a
          // cat's agility would be a body the world cannot produce, and a silent
          // one at that — while a weapon is a thing anybody can pick up, so
          // "what is this axe worth to a wolf rather than a rat" has to survive
          // changing the wolf for the rat.
          onValueChange={(tileId) => {
            if (!tileId) return;
            const fresh = fighterForTile(tileId, tilesById);
            onChange({ ...fresh, equipment: fighter.equipment });
          }}
          options={battlers.map((tile) => ({ value: tile.id, label: tile.name }))}
          className="ml-auto"
          ariaLabel={`${title} battler`}
        />
      </header>

      {body ? null : (
        <p className="text-xs text-danger">
          This tile has no battler block, so it has no numbers to fight with.
        </p>
      )}

      <Masteries title={title} fighter={fighter} onChange={onChange} />

      <Equipment
        title={title}
        fighter={fighter}
        onChange={onChange}
        tiles={tiles}
        tilesById={tilesById}
        tilesets={tilesets}
      />

      <NaturalWeapon fighter={fighter} tilesById={tilesById} />

      <DerivedStats stats={stats} />
    </section>
  );
}

function Masteries({
  title,
  fighter,
  onChange,
}: {
  /** Which side these belong to, so two identical grids read apart. */
  title: string;
  fighter: ArenaFighter;
  onChange: (next: ArenaFighter) => void;
}) {
  const set = (mastery: Mastery, level: number) =>
    onChange({
      ...fighter,
      masteries: {
        ...fighter.masteries,
        [mastery]: Math.max(MIN_MASTERY, Math.min(MAX_MASTERY, level)),
      },
    });

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="flex w-full items-baseline justify-between text-[11px] font-bold uppercase text-muted">
        <span>Masteries</span>
        <span className="tabular-nums normal-case text-ink">
          {RATING_GLYPH}
          {rating(fighter.masteries)}
        </span>
      </legend>
      <div className="grid grid-cols-4 gap-2">
        {MASTERIES.map((mastery) => (
          <label key={mastery} className="flex flex-col gap-0.5 text-[11px]">
            <Tooltip content={<span className="block max-w-64">{MASTERY_HINT[mastery]}</span>}>
              <span className="cursor-help uppercase text-muted">{mastery}</span>
            </Tooltip>
            <Input
              type="number"
              min={MIN_MASTERY}
              max={MAX_MASTERY}
              className="w-full"
              // Scoped to the side, because the two panels are the same seven
              // fields twice over — "blade" alone names two different boxes,
              // and a reader moving between them has no way to tell which.
              aria-label={`${title} ${mastery}`}
              value={fighter.masteries[mastery] ?? MIN_MASTERY}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isFinite(next)) set(mastery, Math.round(next));
              }}
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Equipment({
  title,
  fighter,
  onChange,
  tiles,
  tilesById,
  tilesets,
}: {
  /** Which side these belong to, on the terms {@link Masteries} takes one. */
  title: string;
  fighter: ArenaFighter;
  onChange: (next: ArenaFighter) => void;
  tiles: TileDef[];
  tilesById: Record<string, TileDef>;
  tilesets: TilesetDef[];
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-[11px] font-bold uppercase text-muted">Equipment</legend>
      {EQUIP_SLOTS.map((slot) => {
        const held = fighter.equipment[slot];
        return (
          <div key={slot} className="flex items-center gap-2">
            <TilePreview
              tile={held ? (tilesById[held] ?? null) : null}
              tilesets={tilesets}
              size={28}
              still
            />
            <Tooltip content={<span className="block max-w-64">{SLOT_HINT[slot]}</span>}>
              <span className="w-24 shrink-0 cursor-help text-[11px] uppercase text-muted">
                {SLOT_LABEL[slot]}
              </span>
            </Tooltip>
            <Select
              value={held ?? EMPTY_SLOT}
              onValueChange={(tileId) =>
                onChange({
                  ...fighter,
                  equipment: {
                    ...fighter.equipment,
                    [slot]: tileId === EMPTY_SLOT || tileId === null ? null : tileId,
                  },
                })
              }
              options={[
                { value: EMPTY_SLOT, label: "— empty —" },
                ...tilesForSlot(slot, tiles).map((tile) => ({
                  value: tile.id,
                  label: tile.name,
                })),
              ]}
              className="min-w-0 flex-1"
              ariaLabel={`${title} ${SLOT_LABEL[slot]}`}
            />
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * The select's stand-in for an empty square.
 *
 * A sentinel rather than `null` or `""`, because "nothing chosen yet" and
 * "chosen nothing" are the same state here — a body with an empty hand is a body
 * fighting with what it was born with, which is an answer rather than a gap, and
 * a select showing its placeholder would offer it as neither. Bracketed so it
 * cannot collide with a tile id, which is any trimmed non-empty string.
 */
const EMPTY_SLOT = "::empty::";

function NaturalWeapon({
  fighter,
  tilesById,
}: {
  fighter: ArenaFighter;
  tilesById: Record<string, TileDef>;
}) {
  const body = bodyOf(fighter, tilesById);
  if (!body) return null;
  // What is actually swung, not what the body was born with — a held weapon
  // replaces the natural one, and a ratio quoted against the wrong one of the
  // two is the single most misleading number this panel could show.
  const weapon = weaponInHand(body, equipmentOf(fighter, tilesById), tilesById);
  const natural = weapon === body.naturalWeapon;

  return (
    <div className="flex flex-col gap-1 border-2 border-border/40 bg-paper p-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-bold uppercase text-muted">
          {natural ? "Natural weapon" : "Weapon in hand"}
        </span>
        <span className="text-[10px] text-muted">read-only — edit on /tiles</span>
      </div>
      <dl className="grid grid-cols-3 gap-x-2 gap-y-0.5 text-[11px] tabular-nums">
        <Figure label="damage" value={weapon.damage} />
        <Figure label="def" value={weapon.def} />
        <Figure label="spd" value={weapon.spd} />
        <Figure label="accuracy" value={weapon.accuracy} />
        <Figure label="variance" value={weapon.variance} />
        <Figure label="mastery" value={weapon.mastery ?? "—"} />
      </dl>
      <MasteryDemand fighter={fighter} weapon={weapon} natural={natural} />
    </div>
  );
}

/**
 * What this weapon asks of its wielder, what meeting it is worth, and what being
 * good with it adds on top.
 *
 * **The most diagnostic block on the page, and it exists because its absence was
 * actively misleading.** Requirements and skill are two separate axes that both
 * arrive as the same three numbers, and neither is visible in the stats beside
 * them. A weapon that asks *nothing* is at full readiness however untrained the
 * body holding it — so training the mastery it names moves damage and accuracy
 * but never speed, and reading that off an unchanging speed figure looks like a
 * broken stat rather than the rule it is.
 */
function MasteryDemand({
  fighter,
  weapon,
  natural,
}: {
  fighter: ArenaFighter;
  weapon: WeaponItem;
  natural: boolean;
}) {
  const asked = MASTERIES.filter(
    (mastery) => (weapon.requirements?.[mastery] ?? 0) > 0,
  );
  const share = requirementShare(fighter.masteries, weapon.requirements);
  const readiness = weaponReadiness(share);
  const skill = fighter.masteries[weapon.mastery] ?? 0;

  return (
    <div className="flex flex-col gap-0.5">
      {asked.length === 0 ? (
        <p className="text-[10px] leading-snug text-muted">
          Asks no mastery, so it is at <strong className="text-ink">full</strong>{" "}
          readiness for anybody.
          {natural ? " True of every natural weapon in the game." : ""}
        </p>
      ) : (
        <p className="text-[10px] leading-snug text-muted">
          Asks{" "}
          {asked.map((mastery, index) => (
            <span key={mastery}>
              {index > 0 ? ", " : ""}
              <strong className="text-ink">
                {mastery} {weapon.requirements?.[mastery]}
              </strong>{" "}
              (you {fighter.masteries[mastery] ?? 0})
            </span>
          ))}
          . Pooled{" "}
          <strong className="text-ink">{Math.round(share * 100)}%</strong> met ⇒{" "}
          <strong className="text-ink">{Math.round(readiness * 100)}%</strong> of
          the weapon
          {share >= 1 ? " — met in full, and nothing more is owed." : ""}
        </p>
      )}
      <p className="text-[10px] leading-snug text-muted">
        {weapon.mastery} <strong className="text-ink">{skill}</strong> adds{" "}
        <strong className="text-ink">
          +{((skill / MAX_MASTERY) * DAMAGE_AT_MAX_MASTERY).toFixed(1)}
        </strong>{" "}
        damage and{" "}
        <strong className="text-ink">
          +{((skill / MAX_MASTERY) * ACCURACY_AT_MAX_MASTERY).toFixed(1)}
        </strong>{" "}
        accuracy flat, plus a quarter of what the weapon brings. Speed is
        Agility's to give, not this one's.
      </p>
    </div>
  );
}

function DerivedStats({ stats }: { stats: FightingStats | null }) {
  if (!stats) return null;
  return (
    <div className="flex flex-col gap-1 border-2 border-border bg-paper p-2">
      <span className="text-[11px] font-bold uppercase text-muted">
        Fights with
      </span>
      <dl className="grid grid-cols-3 gap-x-2 gap-y-0.5 text-[11px] tabular-nums">
        <Figure label="max hp" value={stats.maxHp} />
        <Figure label="damage" value={stats.damage} />
        <Figure label="def" value={stats.def} />
        <Figure label="accuracy" value={stats.accuracy} />
        <Figure label="variance" value={stats.variance} />
        <Figure label="spd" value={stats.spd} />
        <Figure label="flee" value={stats.flee} />
        <Figure label="hit" value={`${Math.round(stats.hitChance * 100)}%`} />
        <Figure label="reach" value={`${stats.reach.cells}c`} />
      </dl>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-baseline justify-between gap-1">
      <dt className="uppercase text-muted">{label}</dt>
      <dd className="font-bold">{value}</dd>
    </div>
  );
}
