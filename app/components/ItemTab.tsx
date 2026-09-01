import type {
  ArcaneStoneItem,
  ArmorItem,
  ArmorSlot,
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
} from "../lib/item";
import { hasAnyInteraction, type TileInteractions } from "../lib/interactions";
import { SLOT_LABELS } from "../lib/kit";
import { MASTERY_LABELS, WEAPON_MASTERIES } from "../lib/mastery";
import type { StatusDef } from "../lib/status";
import type { TileDef } from "../lib/types";
import { Input, Segmented, Switch } from "../ui";
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
              tiles={tiles}
              statusDefs={statusDefs}
            />

            <label className="flex items-start gap-2 text-xs">
              <Switch
                checked={item.twoHanded === true}
                onCheckedChange={(twoHanded) => patchWeapon({ twoHanded })}
                ariaLabel="Two handed"
              />
              <span className="flex flex-col gap-1">
                <span className="font-bold uppercase text-muted">
                  Two handed
                </span>
                <span className="max-w-72 text-[11px] leading-snug text-muted">
                  On, it takes both hands: a greatsword, a bow, a pike. It sits
                  in one hand and spoken-for the other, so nothing else can be
                  held — and with no second weapon there is nothing to alternate
                  with. What it trades that second swing for is whatever you
                  write above.
                </span>
              </span>
            </label>
          </div>
        ) : item.type === "armor" ? (
          <div className="flex flex-col gap-3">
            <p className="max-w-lg text-[11px] leading-snug text-muted">
              Worn, and defence is the whole of what it does. It{" "}
              <strong>adds</strong> to everything else being worn and to whatever
              is in either hand — a helm, a mail shirt and a shield are three
              different answers to being hit, and a body with all three gets all
              three.
            </p>

            <div className="flex flex-col gap-1 text-xs">
              <span className="font-bold uppercase text-muted">Worn on</span>
              <div>
                <Segmented<ArmorSlot>
                  value={armorSlotOf(item)}
                  onChange={(slot) => patchArmor({ slot })}
                  options={ARMOR_SLOT_OPTIONS}
                  size="sm"
                  ariaLabel="Worn on"
                />
              </div>
              <span className="max-w-lg text-[11px] leading-snug text-muted">
                Which square it goes in, and the only thing separating a helmet
                from a breastplate. A body wears one of each, so four pieces
                stack; the square refuses anything authored for another one, so
                a helm cannot be worn as boots.
              </span>
            </div>

            <StatField
              label="Defence"
              hint="Taken off every blow that lands, whatever struck it."
              value={item.def}
              min={0}
              max={MAX_ARMOR_DEF}
              onChange={(def) => patchArmor({ def })}
              readout={describeDefence(item.def)}
            />

            <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
              <span className="text-xs font-bold uppercase text-muted">
                Resists
              </span>
              <p className="max-w-lg text-[11px] leading-snug text-muted">
                Extra defence against one <strong>kind</strong> of blow, on top
                of the flat number above — the kind being the attacking
                weapon&rsquo;s mastery. Mail that shrugs off blades and does
                nothing about a hammer is armour you choose for the fight in
                front of you, rather than one more rung on a ladder.
              </p>

              <div className="flex flex-wrap gap-4">
                {WEAPON_MASTERIES.map((mastery) => {
                  const against = item.resist?.[mastery] ?? 0;
                  return (
                    <StatField
                      key={mastery}
                      label={MASTERY_LABELS[mastery]}
                      hint=""
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

            <StatusGrants
              statuses={item.statuses ?? []}
              statusDefs={statusDefs}
              onChange={(statuses) =>
                patchConsumable({ statuses: statuses.length ? statuses : undefined })
              }
              blank={(id) => ({ id })}
              blurb={
                <>
                  What using this <strong>starts</strong>, as opposed to what it
                  does on the spot. Leave the duration blank to use the
                  status&rsquo;s own range — set it to make this a bigger meal
                  than the next thing.
                </>
              }
            />
          </div>
        ) : item.type === "artifact" ? (
          <p className="max-w-lg text-[11px] leading-snug text-muted">
            <strong>Nothing to configure, and that is what it is for.</strong> It
            can be picked up, carried and held in the off hand, and it does
            nothing else: it never replaces what its holder fights with, adds no
            defence, and cannot be used. A torch is the case this exists for
            &mdash; its light is authored on the sprite&rsquo;s frames, not here
            &mdash; so anything that lights a room, or is merely worth carrying,
            belongs on this type rather than on a weapon nobody wants to swing.
          </p>
        ) : item.type === "stone" ? (
          <StoneFields
            stone={item}
            onChange={patchStone}
            tiles={tiles}
            statusDefs={statusDefs}
          />
        ) : item.type === "shield" ? (
          <div className="flex flex-col gap-3">
            <p className="max-w-lg text-[11px] leading-snug text-muted">
              Held in the way of a blow, and never swung at anybody. Both hands
              take turns attacking, so a shield is a kind of its own rather than
              a weapon with no damage &mdash; a hand holding one simply sits the
              rotation out, and the other hand fights on alone.
            </p>

            <StatField
              label="Defence"
              hint="Taken off every blow that lands, whatever struck it."
              value={item.def}
              min={0}
              max={MAX_ARMOR_DEF}
              onChange={(def) => patchShield({ def })}
              readout={describeDefence(item.def)}
            />

            <p className="max-w-lg text-[11px] leading-snug text-muted">
              It <strong>adds</strong> to armour and to whatever is in the other
              hand. No resists here: what turns aside one <em>kind</em> of blow
              is worn, not held.
            </p>
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

        {wearable ? (
          <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
            <span className="text-xs font-bold uppercase text-muted">
              Made of
            </span>
            <ElementFields
              elements={item.elements}
              onChange={(elements) => setItem({ ...item, elements })}
              description="What wearing or holding this makes its bearer, for anything elemental thrown at them — a tunic of flames makes you fire for as long as it is on. Added to whatever the body already is. This is the receiving side of the wheel, and is not the same question as what a stone asks to be cast."
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
  if (def === 0) return "Nothing on its own — see Resists below.";
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

