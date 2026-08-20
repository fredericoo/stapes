import { useMemo } from "react";
import { resolveContainer, resolveItem } from "../lib/item";
import type { EquipSlot, Kit, KitContent, KitEntry } from "../lib/kit";
import {
  DEFAULT_KIT_CHANCE,
  EQUIP_SLOTS,
  MAX_KIT_CHANCE,
  MAX_KIT_ENTRIES,
  MIN_KIT_CHANCE,
} from "../lib/kit";
import type { TileDef } from "../lib/types";
import { Button, Input, Select } from "../ui";

/**
 * What a body is born carrying, as a table an author fills in.
 *
 * **Rows rather than three fixed squares**, which is what makes a weighted drop
 * table writable at all: several rows may name one slot, they are rolled top
 * down, and the first that comes up takes it. A single certainty — the player's
 * backpack — is that same table with one row in it, which is the whole reason
 * people and rats can share a control.
 */

/** How the slots read to somebody filling this in, rather than in code. */
const SLOT_LABELS: Record<EquipSlot, string> = {
  weapon: "Weapon hand",
  offhand: "Off hand",
  bag: "Back",
};

const SLOT_OPTIONS = EQUIP_SLOTS.map((slot) => ({
  value: slot,
  label: SLOT_LABELS[slot],
}));

/**
 * A cleared chance field reads as never, not as NaN.
 *
 * Zero rather than the default, unlike the wait fields elsewhere in the editor:
 * emptying a box is somebody on their way to typing a smaller number, and
 * snapping it back to certainty mid-edit would fight them.
 */
function chanceFromInput(raw: string): number {
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) return MIN_KIT_CHANCE;
  return Math.min(MAX_KIT_CHANCE, Math.max(MIN_KIT_CHANCE, parsed));
}

export function KitEditor({
  kit,
  tiles,
  onChange,
}: {
  kit: Kit;
  /** The whole library; the carryable half of it is what a row may name. */
  tiles: TileDef[];
  onChange: (next: Kit) => void;
}) {
  // Once for the panel rather than once per row: every row offers the same
  // catalogue, and filtering per row would walk the library once per entry on
  // every keystroke.
  const carryable = useMemo(
    () => tiles.filter((tile) => resolveItem(tile) != null),
    [tiles],
  );
  const itemOptions = useMemo(
    () => carryable.map((tile) => ({ value: tile.id, label: tile.name })),
    [carryable],
  );
  const containerSizes = useMemo(() => {
    const sizes = new Map<string, number>();
    for (const tile of carryable) {
      const container = resolveContainer(tile);
      if (container) sizes.set(tile.id, container.size);
    }
    return sizes;
  }, [carryable]);

  const patchEntry = (index: number, fields: Partial<KitEntry>) => {
    onChange(
      kit.map((entry, i) => (i === index ? { ...entry, ...fields } : entry)),
    );
  };

  const patchContent = (
    index: number,
    contentIndex: number,
    fields: Partial<KitContent>,
  ) => {
    const entry = kit[index];
    if (!entry) return;
    patchEntry(index, {
      contents: (entry.contents ?? []).map((content, i) =>
        i === contentIndex ? { ...content, ...fields } : content,
      ),
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {kit.length === 0 ? (
        <p className="text-[11px] leading-snug text-muted">
          Nothing — this body is born empty-handed.
        </p>
      ) : null}

      {kit.map((entry, index) => {
        const size = containerSizes.get(entry.tileId);
        const contents = entry.contents ?? [];
        return (
          <section
            // By position, because a row has no identity of its own: the order
            // *is* the priority, and keying on the tile id would make two rows
            // offering the same sword collide.
            key={index}
            className="flex flex-col gap-2 border-2 border-border bg-panel p-2"
          >
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-[11px] font-bold uppercase text-muted">
                Slot
                <Select
                  value={entry.slot}
                  onValueChange={(slot) =>
                    patchEntry(index, { slot: (slot as EquipSlot) ?? "weapon" })
                  }
                  options={SLOT_OPTIONS}
                  className="min-w-[8rem]"
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] font-bold uppercase text-muted">
                Item
                <Select
                  value={entry.tileId || null}
                  onValueChange={(tileId) =>
                    patchEntry(index, { tileId: tileId ?? "" })
                  }
                  options={itemOptions}
                  placeholder="Pick an item…"
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] font-bold uppercase text-muted">
                Chance %
                <Input
                  type="number"
                  min={MIN_KIT_CHANCE}
                  max={MAX_KIT_CHANCE}
                  step="any"
                  value={entry.chance}
                  onChange={(e) =>
                    patchEntry(index, {
                      chance: chanceFromInput(e.target.value),
                    })
                  }
                  className="w-20"
                  aria-label="Chance this is there, in percent"
                />
              </label>
              <Button
                variant="ghost"
                onClick={() => onChange(kit.filter((_, i) => i !== index))}
              >
                Remove
              </Button>
            </div>

            {size !== undefined ? (
              <div className="flex flex-col gap-2 border-t-2 border-border pt-2">
                <span className="text-[11px] font-bold uppercase text-muted">
                  Inside it
                </span>
                <p className="max-w-lg text-[11px] leading-snug text-muted">
                  Each rolled on its own chance, and each lands in the next free
                  slot. Anything past the {size} this holds is dropped.
                </p>
                {contents.map((content, contentIndex) => (
                  <div key={contentIndex} className="flex flex-wrap items-end gap-2">
                    <Select
                      value={content.tileId || null}
                      onValueChange={(tileId) =>
                        patchContent(index, contentIndex, {
                          tileId: tileId ?? "",
                        })
                      }
                      // A container may not hold a container, so one is not on
                      // offer here — the same rule the roll and every drag keep.
                      options={itemOptions.filter(
                        (option) => !containerSizes.has(option.value),
                      )}
                      placeholder="Pick an item…"
                    />
                    <Input
                      type="number"
                      min={MIN_KIT_CHANCE}
                      max={MAX_KIT_CHANCE}
                      step="any"
                      value={content.chance}
                      onChange={(e) =>
                        patchContent(index, contentIndex, {
                          chance: chanceFromInput(e.target.value),
                        })
                      }
                      className="w-20"
                      aria-label="Chance this is inside, in percent"
                    />
                    <Button
                      variant="ghost"
                      onClick={() =>
                        patchEntry(index, {
                          contents: contents.filter(
                            (_, i) => i !== contentIndex,
                          ),
                        })
                      }
                    >
                      Remove
                    </Button>
                  </div>
                ))}
                <div>
                  <Button
                    variant="ghost"
                    disabled={contents.length >= size}
                    onClick={() =>
                      patchEntry(index, {
                        contents: [
                          ...contents,
                          { tileId: "", chance: DEFAULT_KIT_CHANCE },
                        ],
                      })
                    }
                  >
                    Add to {tiles.find((t) => t.id === entry.tileId)?.name ?? "it"}
                  </Button>
                </div>
              </div>
            ) : null}
          </section>
        );
      })}

      <div>
        <Button
          variant="ghost"
          disabled={kit.length >= MAX_KIT_ENTRIES}
          onClick={() =>
            onChange([
              ...kit,
              { slot: "weapon", tileId: "", chance: DEFAULT_KIT_CHANCE },
            ])
          }
        >
          Add item
        </Button>
      </div>
    </div>
  );
}
