import type {
  ConsumableItem,
  ConsumableStatus,
  ContainerItem,
  ItemDef,
  ItemType,
  WeaponItem,
} from "../lib/item";
import {
  CONSUME_FALLBACK_VERB,
  DEFAULT_CONSUMABLE,
  DEFAULT_CONTAINER,
  DEFAULT_WEAPON,
  MAX_CONSUMABLE_HP_SHIFT,
  MAX_CONSUMABLE_SOUND_LENGTH,
  MAX_CONTAINER_SIZE,
} from "../lib/item";
import { hasAnyInteraction, type TileInteractions } from "../lib/interactions";
import type { StatusDef } from "../lib/status";
import type { TileDef } from "../lib/types";
import { Button, Input, Segmented, Select, Switch } from "../ui";
import { StatField } from "./StatField";
import { WeaponFields } from "./WeaponFields";

type Props = {
  draft: TileDef;
  onChange: (next: TileDef) => void;
  /**
   * The status catalogue, so a consumable can be pointed at one by name rather
   * than by an id somebody has to remember. Empty where nothing is authored, in
   * which case the section says so instead of offering an empty dropdown.
   */
  statusDefs?: Record<string, StatusDef>;
};

const TYPE_OPTIONS: Array<{ value: ItemType; label: string }> = [
  { value: "weapon", label: "Weapon" },
  { value: "consumable", label: "Consumable" },
  { value: "container", label: "Container" },
];

/**
 * What it takes to be carried.
 *
 * A tab of its own on the same grounds the Battle tab has one: being an item is
 * something the tile *is*, chosen by the Kind select, and this configures it
 * rather than deciding it. Like that tab it has no on/off switch — it is only
 * ever shown for a tile whose kind is already `item`.
 */
export function ItemTab({ draft, onChange, statusDefs = {} }: Props) {
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
    if (type === "weapon") setItem({ ...DEFAULT_WEAPON });
    else if (type === "consumable") setItem({ ...DEFAULT_CONSUMABLE });
    else setItem({ ...DEFAULT_CONTAINER });
  };

  const patchWeapon = (fields: Partial<WeaponItem>) => {
    if (item.type !== "weapon") return;
    setItem({ ...item, ...fields });
  };

  const patchConsumable = (fields: Partial<ConsumableItem>) => {
    if (item.type !== "consumable") return;
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
            <p className="max-w-lg text-[11px] leading-snug text-muted">
              These numbers <strong>are</strong> the fight, not a bonus on one.
              Holding this replaces whatever the wielder&rsquo;s own hands or
              jaws would have done — see a creature&rsquo;s natural weapon on the
              Battle tab, which is the same block.
            </p>
            <WeaponFields
              weapon={item}
              onChange={patchWeapon}
              masteryHint="Which mastery scales this weapon — and which one the wielder earns by swinging it."
            />

            <label className="flex items-start gap-2 text-xs">
              <Switch
                checked={item.offhand === true}
                onCheckedChange={(offhand) => patchWeapon({ offhand })}
                ariaLabel="Off hand"
              />
              <span className="flex flex-col gap-1">
                <span className="font-bold uppercase text-muted">Off hand</span>
                <span className="max-w-72 text-[11px] leading-snug text-muted">
                  On, it belongs in the other hand: a shield, a torch, a
                  lantern. Picking it up off the floor holds it there, and the
                  slot takes nothing that is not marked this way — otherwise
                  every sword is a second sword and the game is quietly dual
                  wielding.
                </span>
              </span>
            </label>
          </div>
        ) : item.type === "consumable" ? (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-bold uppercase text-muted">Label</span>
              <Input
                type="text"
                className="w-32"
                value={item.label ?? ""}
                placeholder={CONSUME_FALLBACK_VERB}
                onChange={(e) => patchConsumable({ label: e.target.value })}
              />
              <span className="max-w-64 text-[11px] leading-snug text-muted">
                What using it is called — &ldquo;Eat&rdquo; for a cherry,
                &ldquo;Drink&rdquo; for a potion. Shown beside the tile&rsquo;s
                name wherever the action is offered. Blank falls back to
                &ldquo;{CONSUME_FALLBACK_VERB}&rdquo;.
              </span>
            </label>

            <label className="flex flex-col gap-1 text-xs">
              <span className="font-bold uppercase text-muted">Sound</span>
              <Input
                type="text"
                className="w-32"
                maxLength={MAX_CONSUMABLE_SOUND_LENGTH}
                value={item.sound ?? ""}
                placeholder="crunch"
                onChange={(e) => patchConsumable({ sound: e.target.value })}
              />
              <span className="max-w-64 text-[11px] leading-snug text-muted">
                The noise using it makes, called out over whoever used it — the
                comic-book kind, since the game has no audio. Blank is silent.
              </span>
            </label>

            <StatField
              label="HP"
              hint="Added to the eater's hit points. Negative poisons."
              value={item.hp}
              min={-MAX_CONSUMABLE_HP_SHIFT}
              max={MAX_CONSUMABLE_HP_SHIFT}
              onChange={(hp) => patchConsumable({ hp })}
              readout={describeShift(item.hp, "Heals", "Harms")}
            />

            <ConsumableStatuses
              statuses={item.statuses ?? []}
              statusDefs={statusDefs}
              onChange={(statuses) =>
                patchConsumable({ statuses: statuses.length ? statuses : undefined })
              }
            />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <StatField
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
 * What one of the signed stats does to a wielder, in words.
 *
 * There is no arithmetic left to read out of the simulation — the number *is*
 * what happens, which is the point of the change that removed `weight` — so this
 * only has to say which direction it goes and stay quiet at zero.
 *
 * Both words are passed in whole rather than built from a stem, because English
 * does not conjugate them alike: accuracy goes more and less, speed goes faster
 * and slower, and "less fast" is what you get from pretending otherwise.
 */
function describeShift(value: number, up: string, down: string): string {
  if (value === 0) return "No effect.";
  return `${value > 0 ? up : down} by ${Math.abs(value)}.`;
}

/**
 * Which statuses using this hands over, and how long each is worth.
 *
 * **The list is here rather than on the status**, because a status is a
 * condition and a consumable is what causes one: bread and a berry both leave
 * you Fed, and only the food knows which of them is a meal.
 *
 * That is also the whole argument for the duration override. Without it the
 * difference between a snack and a loaf could only be a *second status* — and
 * then two identical conditions would sit in the panel side by side, refusing to
 * stack with each other, for a difference that is only ever a number.
 */
function ConsumableStatuses({
  statuses,
  statusDefs,
  onChange,
}: {
  statuses: ConsumableStatus[];
  statusDefs: Record<string, StatusDef>;
  onChange: (next: ConsumableStatus[]) => void;
}) {
  const catalogue = Object.values(statusDefs);
  const options = catalogue.map((def) => ({ value: def.id, label: def.name }));

  const patchAt = (index: number, fields: Partial<ConsumableStatus>) =>
    onChange(
      statuses.map((entry, i) => (i === index ? { ...entry, ...fields } : entry)),
    );

  return (
    <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
      <span className="text-xs font-bold uppercase text-muted">Statuses</span>
      <p className="max-w-lg text-[11px] leading-snug text-muted">
        What using this <strong>starts</strong>, as opposed to what it does on
        the spot. Leave the duration blank to use the status&rsquo;s own range —
        set it to make this a bigger meal than the next thing.
      </p>

      {catalogue.length === 0 ? (
        <p className="text-[11px] text-muted">
          Nothing authored yet — statuses live on the Statuses page.
        </p>
      ) : null}

      {statuses.map((entry, index) => {
        const def = statusDefs[entry.id];
        const overriding = entry.fromMs !== undefined && entry.toMs !== undefined;
        return (
          <div
            key={`${entry.id}-${index}`}
            className="flex flex-wrap items-end gap-2 border-2 border-border p-2"
          >
            <label className="flex flex-col gap-0.5 text-xs">
              <span className="font-bold uppercase text-muted">Status</span>
              <Select
                value={entry.id || null}
                onValueChange={(id) => id && patchAt(index, { id })}
                options={options}
              />
            </label>

            <label className="flex flex-col gap-0.5 text-xs">
              <span className="font-bold uppercase text-muted">Own length</span>
              {/* Both ends move together, because half an override would have to
                  be ordered against a number from somewhere else — see
                  `ConsumableStatus`. */}
              <Switch
                checked={overriding}
                ariaLabel="Give this item its own duration"
                onCheckedChange={(on) =>
                  patchAt(
                    index,
                    on
                      ? { fromMs: def?.fromMs ?? 0, toMs: def?.toMs ?? 0 }
                      : { fromMs: undefined, toMs: undefined },
                  )
                }
              />
            </label>

            {overriding ? (
              <>
                <label className="flex flex-col gap-0.5 text-xs">
                  <span className="font-bold uppercase text-muted">From (ms)</span>
                  <Input
                    type="number"
                    className="w-28"
                    min={0}
                    value={entry.fromMs ?? 0}
                    onChange={(e) => {
                      const fromMs = Math.max(0, Number(e.target.value) || 0);
                      // Kept ordered here so nothing authored through this
                      // screen can land on the inverted range the schema
                      // refuses.
                      patchAt(index, {
                        fromMs,
                        toMs: Math.max(fromMs, entry.toMs ?? fromMs),
                      });
                    }}
                  />
                </label>
                <label className="flex flex-col gap-0.5 text-xs">
                  <span className="font-bold uppercase text-muted">To (ms)</span>
                  <Input
                    type="number"
                    className="w-28"
                    min={0}
                    value={entry.toMs ?? 0}
                    onChange={(e) => {
                      const toMs = Math.max(0, Number(e.target.value) || 0);
                      patchAt(index, {
                        toMs,
                        fromMs: Math.min(toMs, entry.fromMs ?? toMs),
                      });
                    }}
                  />
                </label>
              </>
            ) : (
              <span className="text-[11px] text-muted">
                {def
                  ? `${(def.fromMs / 1000).toFixed(0)}–${(def.toMs / 1000).toFixed(0)}s, as the status says.`
                  : "Unknown status — it will be skipped."}
              </span>
            )}

            <Button
              className="ml-auto"
              onClick={() => onChange(statuses.filter((_, i) => i !== index))}
            >
              Remove
            </Button>
          </div>
        );
      })}

      <Button
        className="self-start"
        disabled={catalogue.length === 0}
        onClick={() =>
          onChange([...statuses, { id: catalogue[0]!.id }])
        }
      >
        Add status
      </Button>
    </div>
  );
}
