import type {
  ArcaneStoneItem,
  ArmorItem,
  ArmorSlot,
  ArtifactItem,
  ConsumableItem,
  ContainerItem,
  ItemDef,
  ItemType,
  ShieldItem,
  WeaponItem,
} from "../lib/item";
import {
  ARMOR_SLOTS,
  armorSlotOf,
  CONSUME_FALLBACK_VERB,
  DEFAULT_ARMOR,
  DEFAULT_ARTIFACT,
  DEFAULT_CONSUMABLE,
  DEFAULT_CONTAINER,
  DEFAULT_SHIELD,
  DEFAULT_STONE,
  DEFAULT_WEAPON,
  MAX_ARMOR_DEF,
  MAX_CONSUMABLE_HP_SHIFT,
  MAX_CONSUMABLE_SOUND_LENGTH,
  MAX_CONTAINER_SIZE,
  MAX_PILE,
  MIN_PILE,
  pileOf,
} from "../lib/item";
import { hasAnyInteraction, type TileInteractions } from "../lib/interactions";
import { SLOT_LABELS } from "../lib/kit";
import { MASTERY_LABELS, WEAPON_MASTERIES } from "../lib/mastery";
import type { StatusDef } from "../lib/status";
import type { TileDef } from "../lib/types";
import {
  FieldLabel,
  Input,
  SectionTitle,
  Segmented,
  Select,
  SwitchField,
} from "../ui";
import { StatField } from "./StatField";
import { StatusGrants } from "./StatusGrants";
import { StoneFields } from "./StoneFields";
import { ElementFields } from "./ElementFields";
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
  /**
   * The whole library, handed through to the weapon fields so a bow can be
   * pointed at the arrow it fires. Here for the same reason the Battle tab
   * carries it: the picker needs the catalogue, and this tab is the only thing
   * between it and the dialog that has one.
   */
  tiles: TileDef[];
};

/**
 * Where a piece of armour goes, in the order a body wears it.
 *
 * Named by `SLOT_LABELS` rather than here, so the square a helmet is authored
 * into is called what the kit table calls it — see `../lib/kit`.
 */
const ARMOR_SLOT_OPTIONS: Array<{ value: ArmorSlot; label: string }> =
  ARMOR_SLOTS.map((slot) => ({ value: slot, label: SLOT_LABELS[slot] }));

const TYPE_OPTIONS: Array<{ value: ItemType; label: string }> = [
  { value: "weapon", label: "Weapon" },
  { value: "armor", label: "Armour" },
  { value: "shield", label: "Shield" },
  { value: "consumable", label: "Consumable" },
  { value: "container", label: "Container" },
  { value: "artifact", label: "Artifact" },
  { value: "stone", label: "Arcane stone" },
];

/** What each type is, for the tooltip beside the type picker. */
const TYPE_INFO: Record<ItemType, string> = {
  weapon:
    "Held. Replaces the wielder's natural weapon entirely — the same block as a creature's on the Battle tab.",
  armor: "Worn. Its defence adds to everything else worn and held.",
  shield:
    "Held, never swung: that hand sits out the attack rotation. Adds to armour and to the other hand. No resists — those are worn.",
  consumable: "Used up from a bag or a hand.",
  container: "Holds other items. Containers never nest.",
  artifact:
    "Carried only: goes in the off hand, has no stats and cannot be used. A torch — its light is on the sprite's frames.",
  stone: "Held or worn on the charm, and cast on a cooldown.",
};

/**
 * What it takes to be carried.
 *
 * A tab of its own on the same grounds the Battle tab has one: being an item is
 * something the tile *is*, chosen by the Kind select, and this configures it
 * rather than deciding it. Like that tab it has no on/off switch — it is only
 * ever shown for a tile whose kind is already `item`.
 */
export function ItemTab({ draft, onChange, statusDefs = {}, tiles }: Props) {
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
    else if (type === "armor") setItem({ ...DEFAULT_ARMOR });
    else if (type === "shield") setItem({ ...DEFAULT_SHIELD });
    else if (type === "consumable") setItem({ ...DEFAULT_CONSUMABLE });
    else if (type === "artifact") setItem({ ...DEFAULT_ARTIFACT });
    // Deep enough to matter: the default's effect is a shared object, and a
    // shallow copy would let a stone edited in the tile editor write through it
    // into every other stone that took the same default.
    else if (type === "stone") {
      setItem({ ...DEFAULT_STONE, effect: { ...DEFAULT_STONE.effect } });
    } else setItem({ ...DEFAULT_CONTAINER });
  };

  const patchWeapon = (fields: Partial<WeaponItem>) => {
    if (item.type !== "weapon") return;
    setItem({ ...item, ...fields });
  };

  const patchArmor = (fields: Partial<ArmorItem>) => {
    if (item.type !== "armor") return;
    setItem({ ...item, ...fields });
  };

  const patchConsumable = (fields: Partial<ConsumableItem>) => {
    if (item.type !== "consumable") return;
    setItem({ ...item, ...fields });
  };

  const patchShield = (fields: Partial<ShieldItem>) => {
    if (item.type !== "shield") return;
    setItem({ ...item, ...fields });
  };

  const patchArtifact = (fields: Partial<ArtifactItem>) => {
    if (item.type !== "artifact") return;
    setItem({ ...item, ...fields });
  };

  // Anything carriable but this tile itself: a potion that left a full potion
  // behind would be a bottle that never empties.
  const residueTiles = tiles.filter(
    (tile) => tile.kind === "item" && tile.id !== draft.id,
  );

  const patchContainer = (fields: Partial<ContainerItem>) => {
    if (item.type !== "container") return;
    setItem({ ...item, ...fields });
  };

  const patchStone = (fields: Partial<ArcaneStoneItem>) => {
    if (item.type !== "stone") return;
    setItem({ ...item, ...fields });
  };

  /**
   * The elements are authored once, below the arm rather than inside four of
   * them.
   *
   * What wearing a thing makes you is the same question whichever kind of thing
   * it is, so it gets one control in one place — four copies inside the branches
   * above would be four chances for them to drift apart, and an author would
   * have to learn that a tunic and a shield ask it differently.
   *
   * Offered only for the things a body actually wears or holds. A loaf of bread
   * has nowhere to put an element and no square to be in, and a control for a
   * field that could never be read is a promise the simulation does not keep.
   */
  const wearable =
    item.type === "weapon" ||
    item.type === "armor" ||
    item.type === "shield" ||
    item.type === "stone";

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <SectionTitle info="Picked up off the board into a bag. On the floor it is a placement like any other. Author it flat and intangible (Tile tab) so it lies on the ground without blocking it.">
          Item
        </SectionTitle>

        <div className="flex flex-col gap-1 border-t-2 border-border pt-3 text-xs">
          <FieldLabel info={TYPE_INFO[item.type]}>Type</FieldLabel>
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
            <WeaponFields
              weapon={item}
              onChange={patchWeapon}
              masteryInfo="Scales this weapon, and is what the wielder trains by swinging it."
              tiles={tiles}
              statusDefs={statusDefs}
            />

            <SwitchField
              checked={item.twoHanded === true}
              onCheckedChange={(twoHanded) => patchWeapon({ twoHanded })}
              label="Two handed"
              info="Occupies both hands: nothing else can be held, and there is no second swing to alternate with."
            />
          </div>
        ) : item.type === "armor" ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1 text-xs">
              <FieldLabel info="One of each is worn, so four pieces stack. A slot refuses a piece authored for another.">
                Slot
              </FieldLabel>
              <div>
                <Segmented<ArmorSlot>
                  value={armorSlotOf(item)}
                  onChange={(slot) => patchArmor({ slot })}
                  options={ARMOR_SLOT_OPTIONS}
                  size="sm"
                  ariaLabel="Slot"
                />
              </div>
            </div>

            <StatField
              label="Defence"
              info="Subtracted from every blow that lands, whatever struck it."
              value={item.def}
              min={0}
              max={MAX_ARMOR_DEF}
              onChange={(def) => patchArmor({ def })}
              readout={describeDefence(item.def)}
            />

            <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
              <FieldLabel info="Extra defence against blows from weapons of that mastery, on top of Defence.">
                Resists
              </FieldLabel>

              <div className="flex flex-wrap gap-4">
                {WEAPON_MASTERIES.map((mastery) => {
                  const against = item.resist?.[mastery] ?? 0;
                  return (
                    <StatField
                      key={mastery}
                      label={MASTERY_LABELS[mastery]}
                      value={against}
                      min={0}
                      max={MAX_ARMOR_DEF}
                      onChange={(level) =>
                        patchArmor({
                          resist: { ...item.resist, [mastery]: level },
                        })
                      }
                      readout={
                        against > 0
                          ? `${MASTERY_LABELS[mastery]} blows do ${item.def + against} less.`
                          : undefined
                      }
                    />
                  );
                })}
              </div>
            </div>
          </div>
        ) : item.type === "consumable" ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-start gap-4">
              <label className="flex flex-col gap-1 text-xs">
                <FieldLabel
                  info={`The verb beside the name wherever the action is offered. Blank reads as “${CONSUME_FALLBACK_VERB}”.`}
                >
                  Action label
                </FieldLabel>
                <Input
                  type="text"
                  className="w-32"
                  value={item.label ?? ""}
                  placeholder={CONSUME_FALLBACK_VERB}
                  onChange={(e) => patchConsumable({ label: e.target.value })}
                />
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <FieldLabel info="Comic-book noise shown over whoever used it. Blank is silent.">
                  Sound
                </FieldLabel>
                <Input
                  type="text"
                  className="w-32"
                  maxLength={MAX_CONSUMABLE_SOUND_LENGTH}
                  value={item.sound ?? ""}
                  placeholder="crunch"
                  onChange={(e) => patchConsumable({ sound: e.target.value })}
                />
              </label>

              <StatField
                label="HP"
                info="Added to the user's hit points. Negative poisons."
                value={item.hp}
                min={-MAX_CONSUMABLE_HP_SHIFT}
                max={MAX_CONSUMABLE_HP_SHIFT}
                onChange={(hp) => patchConsumable({ hp })}
                readout={describeShift(item.hp, "Heals", "Harms")}
              />

              <StatField
                label="Pile"
                info="How many share one square, in a bag or on a tile. One more starts a second pile."
                value={pileOf(item)}
                min={MIN_PILE}
                max={MAX_PILE}
                onChange={(pile) => patchConsumable({ pile })}
                readout={
                  pileOf(item) > MIN_PILE
                    ? `Up to ${pileOf(item)} per square.`
                    : "One per square."
                }
              />
            </div>

            <StatusGrants
              statuses={item.statuses ?? []}
              statusDefs={statusDefs}
              onChange={(statuses) =>
                patchConsumable({ statuses: statuses.length ? statuses : undefined })
              }
              blank={(id) => ({ id })}
              info="Started on use, on top of the HP shift. Override the duration to make this a bigger meal than the next thing."
            />

            <label className="flex flex-col gap-1 text-xs">
              <FieldLabel info="Lands where the item was, then in the bag, then in a free hand. With nowhere to put it, the item cannot be used.">
                Leaves behind
              </FieldLabel>
              <Select
                className="w-56"
                ariaLabel="Leaves behind"
                value={item.leaves ?? ""}
                onValueChange={(leaves) =>
                  patchConsumable({ leaves: leaves || undefined })
                }
                options={[
                  { value: "", label: "Nothing" },
                  ...residueTiles.map((tile) => ({
                    value: tile.id,
                    label: tile.name,
                  })),
                ]}
              />
            </label>
          </div>
        ) : item.type === "artifact" ? (
          <StatField
            label="Pile"
            info="How many share one square. 1 means each takes a square of its own — a torch, a key. Raise it for a thing that is only ever counted, like a shard."
            value={item.pile ?? MIN_PILE}
            min={MIN_PILE}
            max={MAX_PILE}
            onChange={(pile) => patchArtifact({ pile })}
            readout={
              (item.pile ?? MIN_PILE) > MIN_PILE
                ? `Up to ${item.pile} per square.`
                : "One per square."
            }
          />
        ) : item.type === "stone" ? (
          <StoneFields
            stone={item}
            onChange={patchStone}
            tiles={tiles}
            statusDefs={statusDefs}
          />
        ) : item.type === "shield" ? (
          <StatField
            label="Defence"
            info="Subtracted from every blow that lands, whatever struck it."
            value={item.def}
            min={0}
            max={MAX_ARMOR_DEF}
            onChange={(def) => patchShield({ def })}
            readout={describeDefence(item.def)}
          />
        ) : (
          <div className="flex flex-wrap items-start gap-4">
            <StatField
              label="Size"
              info="Squares inside it."
              value={item.size}
              min={1}
              max={MAX_CONTAINER_SIZE}
              onChange={(size) => patchContainer({ size })}
            />

            <SwitchField
              checked={item.equippable}
              onCheckedChange={(equippable) => patchContainer({ equippable })}
              label="Equippable"
              info="On: a backpack — goes in the bag slot and its contents are the inventory. Off: a chest or a body, opened where it lies and never carried."
            />
          </div>
        )}

        {wearable ? (
          <div className="border-t-2 border-border pt-3">
            <ElementFields
              label="Wearer's elements"
              info="Added to the wearer's own elements while this is worn or held, for incoming elemental damage — a tunic of flames makes you fire. The receiving side of the wheel, not what a stone asks to cast."
              elements={item.elements}
              onChange={(elements) => setItem({ ...item, elements })}
            />
          </div>
        ) : null}
      </section>
    </div>
  );
}

/**
 * What a piece of armour is worth, in words.
 *
 * Flat and subtracted, so the sentence can say the thing outright rather than
 * gesturing at a curve: every blow that lands is worth this much less, and an
 * author reading it back knows immediately whether they have just written a
 * padded coat or a wall.
 */
function describeDefence(def: number): string {
  if (def === 0) return "Nothing on its own.";
  return `Every blow that lands does ${def} less.`;
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
