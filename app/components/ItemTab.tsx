import type {
  ContainerItem,
  ItemDef,
  ItemMastery,
  ItemType,
  WeaponItem,
} from "../lib/item";
import {
  DEFAULT_CONTAINER,
  DEFAULT_WEAPON,
  MAX_CONTAINER_SIZE,
  MAX_ITEM_WEIGHT,
} from "../lib/item";
import { accuracyCostOf, speedCostOf } from "../game/equipment";
import { hasAnyInteraction, type TileInteractions } from "../lib/interactions";
import type { TileDef } from "../lib/types";
import { Input, Segmented, Switch } from "../ui";

type Props = {
  draft: TileDef;
  onChange: (next: TileDef) => void;
};

const TYPE_OPTIONS: Array<{ value: ItemType; label: string }> = [
  { value: "weapon", label: "Weapon" },
  { value: "container", label: "Container" },
];

const MASTERY_OPTIONS: Array<{ value: ItemMastery; label: string }> = [
  { value: "blade", label: "Blade" },
  { value: "ranged", label: "Ranged" },
  { value: "blunt", label: "Blunt" },
  { value: "magic", label: "Magic" },
];

/**
 * One numeric field with the sentence saying what it does, matching the Battle
 * tab's `StatField` — the two tabs are read side by side when balancing a
 * weapon against the creature it is meant to kill, and a different shape here
 * would make that comparison work.
 */
function ItemField({
  label,
  hint,
  value,
  min,
  max,
  onChange,
  readout,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max?: number;
  onChange: (next: number) => void;
  readout?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="font-bold uppercase text-muted">{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        step={1}
        className="w-24"
        value={value}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (!Number.isFinite(next)) return;
          onChange(Math.max(min, Math.min(max ?? Infinity, Math.round(next))));
        }}
      />
      <span className="max-w-64 text-[11px] leading-snug text-muted">
        {hint}
        {readout ? <strong className="block text-ink">{readout}</strong> : null}
      </span>
    </label>
  );
}

/**
 * What it takes to be carried.
 *
 * A tab of its own on the same grounds the Battle tab has one: being an item is
 * something the tile *is*, chosen by the Kind select, and this configures it
 * rather than deciding it. Like that tab it has no on/off switch — it is only
 * ever shown for a tile whose kind is already `item`.
 */
export function ItemTab({ draft, onChange }: Props) {
  const item = draft.interactions?.item ?? DEFAULT_WEAPON;

  const setItem = (next: ItemDef) => {
    const merged: TileInteractions = { ...draft.interactions, item: next };
    onChange({
      ...draft,
      interactions: hasAnyInteraction(merged) ? merged : undefined,
    });
  };

  /**
   * Swap which arm of the union this is, from that arm's defaults.
   *
   * Whole-block replacement rather than a patch, so the draft never holds a
   * weapon's `atk` beside a container's `size`. `itemForSave` would drop the
   * stray field on the way to disk anyway, but a draft that is briefly both is a
   * draft the editor can render wrong.
   */
  const setType = (type: ItemType) => {
    if (type === item.type) return;
    setItem(type === "weapon" ? { ...DEFAULT_WEAPON } : { ...DEFAULT_CONTAINER });
  };

  const patchWeapon = (fields: Partial<WeaponItem>) => {
    if (item.type !== "weapon") return;
    setItem({ ...item, ...fields });
  };

  const patchContainer = (fields: Partial<ContainerItem>) => {
    if (item.type !== "container") return;
    setItem({ ...item, ...fields });
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <span className="text-sm font-bold">Item</span>
        <p className="text-[11px] leading-snug text-muted">
          This tile can be picked up. On the floor it is a placement like any
          other — it falls, it can be shoved — and picking it up lifts it off the
          board into somebody&rsquo;s bag. Author it flat and{" "}
          <strong>intangible</strong> on the Tile tab so it lies on the ground
          without blocking it.
        </p>

        <div className="flex flex-col gap-1 border-t-2 border-border pt-3 text-xs">
          <span className="font-bold uppercase text-muted">Type</span>
          <div>
            <Segmented<ItemType>
              value={item.type}
              onChange={setType}
              options={TYPE_OPTIONS}
              size="sm"
              ariaLabel="Item type"
            />
          </div>
        </div>

        {item.type === "weapon" ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-4">
              <ItemField
                label="Atk"
                hint="Added to the wielder's own attack."
                value={item.atk}
                min={0}
                onChange={(atk) => patchWeapon({ atk })}
              />
              <ItemField
                label="Def"
                hint="Added to the wielder's own defence."
                value={item.def}
                min={0}
                onChange={(def) => patchWeapon({ def })}
              />
              <ItemField
                label="Weight"
                hint="What carrying it costs. Spends speed at full rate and accuracy at half."
                value={item.weight}
                min={0}
                max={MAX_ITEM_WEIGHT}
                onChange={(weight) => patchWeapon({ weight })}
                readout={describeWeight(item.weight)}
              />
            </div>

            <div className="flex flex-col gap-1 text-xs">
              <span className="font-bold uppercase text-muted">Mastery</span>
              <div>
                <Segmented<ItemMastery>
                  value={item.mastery}
                  onChange={(mastery) => patchWeapon({ mastery })}
                  options={MASTERY_OPTIONS}
                  size="sm"
                  ariaLabel="Mastery"
                />
              </div>
              <span className="text-[11px] leading-snug text-muted">
                Which skill the weapon answers to. Nothing reads this yet —
                it is authored now so the choice does not have to be revisited
                when something does.
              </span>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <ItemField
              label="Size"
              hint="How many things fit inside it."
              value={item.size}
              min={1}
              max={MAX_CONTAINER_SIZE}
              onChange={(size) => patchContainer({ size })}
            />

            <label className="flex items-start gap-2 text-xs">
              <Switch
                checked={item.equippable}
                onCheckedChange={(equippable) => patchContainer({ equippable })}
                ariaLabel="Equippable"
              />
              <span className="flex flex-col gap-1">
                <span className="font-bold uppercase text-muted">
                  Equippable
                </span>
                <span className="max-w-72 text-[11px] leading-snug text-muted">
                  On, it is a backpack: it goes in the bag slot and its contents
                  are the inventory. Off, it is a chest or a body — opened where
                  it lies and never carried, since a container may not hold
                  another container.
                </span>
              </span>
            </label>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * What this weight costs a wielder, read out of the same functions the
 * simulation subtracts with rather than restated here — a readout that could
 * disagree with the formula is worse than none.
 */
function describeWeight(weight: number): string {
  if (weight <= 0) return "Costs nothing to carry.";
  return `Costs ${speedCostOf(weight)} speed and ${accuracyCostOf(weight)} accuracy.`;
}
