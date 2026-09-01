import type { ArenaFighter } from "../game/arena";
import {
  bodyOf,
  equipmentOf,
  fighterForTile,
  swingsOf,
  tilesForSlot,
} from "../game/arena";
import {
  type Hand,
  HANDS,
  weaponInHand,
  weaponSwungBy,
} from "../game/equipment";
import {
  ACCURACY_AT_MAX_MASTERY,
  type BattlerDef,
  DAMAGE_AT_MAX_MASTERY,
  type FightingStats,
  weaponReadiness,
} from "../lib/battler";
import type { WeaponItem } from "../lib/item";
import { EQUIP_SLOTS, type EquipSlot, SLOT_LABELS } from "../lib/kit";
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
import { Input, Select } from "../ui";
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
 * body, the masteries and every worn slot into the numbers `../game/combat`
 * reads — so showing them beside the inputs is what makes the derivation legible
 * instead of something to be inferred from the outcome.
 *
 * ## Nothing here explains a formula in words
 *
 * There were tooltips on every mastery and every slot saying what each one did
 * to a fight. They are gone, and their absence is the design: a sentence
 * describing a curve is a second copy of that curve which no test can fail when
 * the first one moves, and this panel exists to be trusted while those curves
 * are being tuned. Every string below is either a label, a slot name, or a
 * number that came out of a function.
 */

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
  // Every blow, not the first one: a body fighting with two weapons throws two
  // different blows and a tuner showing one of them is answering half the
  // question. One entry for everything else, which is nearly everything.
  const swings = swingsOf(fighter, tilesById);

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

      <WeaponsInHand fighter={fighter} tilesById={tilesById} />

      {swings.map((stats: FightingStats, index: number) => (
        <DerivedStats
          key={index}
          stats={stats}
          // Named only when there is more than one, because "Fights with" is
          // the whole truth for a body with a single weapon and a hand label
          // beside it would be answering a question nobody asked.
          hand={swings.length > 1 ? HANDS[index] : null}
        />
      ))}
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
            <span className="uppercase text-muted">{mastery}</span>
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
            {/* The slot's own name, so a slot added to the game names itself
                here rather than waiting for somebody to write a label for it. */}
            <span className="w-20 shrink-0 text-[11px] uppercase text-muted">
              {slot}
            </span>
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
              ariaLabel={`${title} ${slot}`}
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

/**
 * What each hand is called, where a row has to say which one it is talking
 * about.
 *
 * The kit editor's own words — see `../lib/kit`'s {@link SLOT_LABELS} — so the
 * square a weapon is chosen in and the row reporting what it swings for are
 * named the same thing.
 */
const HAND_LABELS: Record<Hand, string> = {
  weapon: SLOT_LABELS.weapon,
  offhand: SLOT_LABELS.offhand,
};

function WeaponsInHand({
  fighter,
  tilesById,
}: {
  fighter: ArenaFighter;
  tilesById: Record<string, TileDef>;
}) {
  const body = bodyOf(fighter, tilesById);
  if (!body) return null;
  // What is actually swung, not what the body was born with — a held weapon
  // replaces the natural one, and a readout quoting the wrong one of the two is
  // the single most misleading thing this panel could show.
  //
  // The hand a body starts on, rather than no hand at all: this row names a
  // weapon, and "none in particular" would name the claws of a body plainly
  // holding a sword. A fighter with one in each hand is showing the first of the
  // two, which the Arena's own equipment rows say outright beside it.
  const equipment = equipmentOf(fighter, tilesById);
  const hands = HANDS.filter((hand) =>
    weaponSwungBy(equipment, tilesById, hand),
  );
  // Bare hands are a weapon, so a body swinging nothing still has one row.
  const rotation: (Hand | null)[] = hands.length > 0 ? hands : [null];

  return (
    <>
      {rotation.map((hand) => (
        <WeaponBlock
          key={hand ?? "natural"}
          fighter={fighter}
          body={body}
          weapon={weaponInHand(body, equipment, tilesById, hand)}
          hand={rotation.length > 1 ? hand : null}
        />
      ))}
    </>
  );
}

/** One weapon's authored numbers, named by the hand holding it. */
function WeaponBlock({
  fighter,
  body,
  weapon,
  hand,
}: {
  fighter: ArenaFighter;
  body: BattlerDef;
  weapon: WeaponItem;
  hand: Hand | null;
}) {
  const natural = weapon === body.naturalWeapon;

  return (
    <div className="flex flex-col gap-1 border-2 border-border/40 bg-paper p-2">
      <span className="text-[11px] font-bold uppercase text-muted">
        {natural
          ? "Natural weapon"
          : hand
            ? `Weapon in hand — ${HAND_LABELS[hand]}`
            : "Weapon in hand"}
      </span>
      <dl className="grid grid-cols-3 gap-x-2 gap-y-0.5 text-[11px] tabular-nums">
        <Figure label="damage" value={weapon.damage} />
        <Figure label="def" value={weapon.def} />
        <Figure label="spd" value={weapon.spd} />
        <Figure label="accuracy" value={weapon.accuracy} />
        <Figure label="variance" value={weapon.variance} />
        <Figure label="mastery" value={weapon.mastery} />
      </dl>
      <MasteryDemand fighter={fighter} weapon={weapon} />
    </div>
  );
}

/**
 * What this weapon asks, how much of it the body brings, and what that comes to.
 *
 * **The most diagnostic block on the page, and every figure in it is computed.**
 * Requirements and skill are two axes that both arrive as the same three numbers
 * and neither is visible in the stats beside them, so they are printed — as
 * numbers, not as a sentence about what they do. `../lib/weaponDemand` says the
 * same thing to a player looking at the same weapon in the world.
 */
function MasteryDemand({
  fighter,
  weapon,
}: {
  fighter: ArenaFighter;
  weapon: WeaponItem;
}) {
  const asked = MASTERIES.filter(
    (mastery) => (weapon.requirements?.[mastery] ?? 0) > 0,
  );
  const share = requirementShare(fighter.masteries, weapon.requirements);
  const readiness = weaponReadiness(share);
  const skill = fighter.masteries[weapon.mastery] ?? 0;

  return (
    <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px] tabular-nums">
      {asked.map((mastery) => (
        <Figure
          key={mastery}
          label={`asks ${mastery}`}
          value={`${weapon.requirements?.[mastery]} / ${fighter.masteries[mastery] ?? 0}`}
        />
      ))}
      <Figure label="requirements met" value={`${Math.round(share * 100)}%`} />
      <Figure label="weapon at" value={`${Math.round(readiness * 100)}%`} />
      <Figure
        label={`${weapon.mastery} adds dmg`}
        value={`+${((skill / MAX_MASTERY) * DAMAGE_AT_MAX_MASTERY).toFixed(1)}`}
      />
      <Figure
        label={`${weapon.mastery} adds acc`}
        value={`+${((skill / MAX_MASTERY) * ACCURACY_AT_MAX_MASTERY).toFixed(1)}`}
      />
    </dl>
  );
}

function DerivedStats({
  stats,
  hand = null,
}: {
  stats: FightingStats | null;
  /** Which hand this blow comes from, or null for a body throwing only one. */
  hand?: Hand | null;
}) {
  if (!stats) return null;
  return (
    <div className="flex flex-col gap-1 border-2 border-border bg-paper p-2">
      <span className="text-[11px] font-bold uppercase text-muted">
        {hand ? `Fights with — ${HAND_LABELS[hand]}` : "Fights with"}
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
        <Figure label="haste" value={`${stats.haste.toFixed(2)}×`} />
        <Figure label="strikes as" value={stats.mastery} />
      </dl>
      {Object.entries(stats.resist).length === 0 ? null : (
        <dl className="grid grid-cols-3 gap-x-2 gap-y-0.5 border-t-2 border-border/30 pt-1 text-[11px] tabular-nums">
          {Object.entries(stats.resist).map(([mastery, amount]) => (
            <Figure key={mastery} label={`resists ${mastery}`} value={amount} />
          ))}
        </dl>
      )}
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
