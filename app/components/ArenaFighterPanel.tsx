import type { ArenaFighter } from "../game/arena";
import { bodyOf, equipmentOf, fighterForTile, swingsOf, tilesForSlot } from "../game/arena";
import { type Hand, HANDS, weaponInHand, weaponSwungBy } from "../game/equipment";
import {
  ACCURACY_AT_MAX_MASTERY,
  type BattlerDef,
  DAMAGE_AT_MAX_MASTERY,
  type FightingStats,
  weaponHandling,
} from "../lib/battler";
import type { WeaponItem } from "../lib/item";
import { EQUIP_SLOTS, SLOT_LABELS } from "../lib/kit";
import {
  MASTERIES,
  MAX_MASTERY,
  type Mastery,
  MIN_MASTERY,
  rating,
  RATING_GLYPH,
  requirementShare,
  requirementShortfall,
} from "../lib/mastery";
import type { TileDef, TilesetDef } from "../lib/types";
import { NumberInput, Select } from "../ui";
import { TilePreview } from "./TilePreview";

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
  const swings = swingsOf(fighter, tilesById);

  return (
    <section className="flex min-w-0 flex-col gap-3 border-2 border-border bg-panel p-3">
      <header className="flex items-center gap-2">
        <h2 className="text-xs font-bold uppercase">{title}</h2>
        <Select
          value={fighter.tileId}
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
        <DerivedStats key={index} stats={stats} hand={swings.length > 1 ? HANDS[index] : null} />
      ))}
    </section>
  );
}

function Masteries({
  title,
  fighter,
  onChange,
}: {
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
            <NumberInput
              min={MIN_MASTERY}
              max={MAX_MASTERY}
              step={1}
              className="w-full"
              aria-label={`${title} ${mastery}`}
              value={fighter.masteries[mastery] ?? MIN_MASTERY}
              onChange={(level) => set(mastery, level)}
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
            <span className="w-20 shrink-0 text-[11px] uppercase text-muted">{slot}</span>
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

const EMPTY_SLOT = "::empty::";

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
  const equipment = equipmentOf(fighter, tilesById);
  const hands = HANDS.filter((hand) => weaponSwungBy(equipment, tilesById, hand));
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

function MasteryDemand({ fighter, weapon }: { fighter: ArenaFighter; weapon: WeaponItem }) {
  const asked = MASTERIES.filter((mastery) => (weapon.requirements?.[mastery] ?? 0) > 0);
  const share = requirementShare(fighter.masteries, weapon.requirements);
  const handling = weaponHandling(requirementShortfall(fighter.masteries, weapon.requirements));
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
      <Figure label="acc & spd at" value={`${Math.round(handling * 100)}%`} />
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

function DerivedStats({ stats, hand = null }: { stats: FightingStats | null; hand?: Hand | null }) {
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
        <Figure
          label="reach"
          value={
            stats.reach.min ? `${stats.reach.min}–${stats.reach.cells}c` : `${stats.reach.cells}c`
          }
        />
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
