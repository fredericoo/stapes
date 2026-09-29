import { useMemo } from "react";
import { resolveContainer, resolveItem } from "../lib/item";
import type { EquipSlot, Kit, KitContent, KitEntry } from "../lib/kit";
import {
  DEFAULT_KIT_CHANCE,
  EQUIP_SLOTS,
  MAX_KIT_CHANCE,
  MAX_KIT_ENTRIES,
  MIN_KIT_CHANCE,
  SLOT_LABELS,
} from "../lib/kit";
import type { TileDef } from "../lib/types";
import { Button, FieldLabel, NumberInput, Select } from "../ui";

const SLOT_OPTIONS = EQUIP_SLOTS.map((slot) => ({
  value: slot,
  label: SLOT_LABELS[slot],
}));

export function KitEditor({
  kit,
  tiles,
  onChange,
}: {
  kit: Kit;
  tiles: TileDef[];
  onChange: (next: Kit) => void;
}) {
  const carryable = useMemo(() => tiles.filter((tile) => resolveItem(tile) != null), [tiles]);
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
    onChange(kit.map((entry, i) => (i === index ? { ...entry, ...fields } : entry)));
  };

  const patchContent = (index: number, contentIndex: number, fields: Partial<KitContent>) => {
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
      {kit.length === 0 ? <p className="text-[11px] leading-snug text-muted">None.</p> : null}

      {kit.map((entry, index) => {
        const size = containerSizes.get(entry.tileId);
        const contents = entry.contents ?? [];
        return (
          <section key={index} className="flex flex-col gap-2 border-2 border-border bg-panel p-2">
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
                  onValueChange={(tileId) => patchEntry(index, { tileId: tileId ?? "" })}
                  options={itemOptions}
                  placeholder="Pick an item…"
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] font-bold uppercase text-muted">
                Chance %
                <NumberInput
                  min={MIN_KIT_CHANCE}
                  max={MAX_KIT_CHANCE}
                  value={entry.chance}
                  onChange={(chance) => patchEntry(index, { chance })}
                  className="w-20"
                  aria-label="Chance this is there, in percent"
                />
              </label>
              <Button variant="ghost" onClick={() => onChange(kit.filter((_, i) => i !== index))}>
                Remove
              </Button>
            </div>

            {size !== undefined ? (
              <div className="flex flex-col gap-2 border-t-2 border-border pt-2">
                <FieldLabel
                  info={`Each rolled on its own chance into the next free square. Anything past the ${size} it holds is dropped.`}
                >
                  Contents
                </FieldLabel>
                {contents.map((content, contentIndex) => (
                  <div key={contentIndex} className="flex flex-wrap items-end gap-2">
                    <Select
                      value={content.tileId || null}
                      onValueChange={(tileId) =>
                        patchContent(index, contentIndex, {
                          tileId: tileId ?? "",
                        })
                      }
                      options={itemOptions.filter((option) => !containerSizes.has(option.value))}
                      placeholder="Pick an item…"
                    />
                    <NumberInput
                      min={MIN_KIT_CHANCE}
                      max={MAX_KIT_CHANCE}
                      value={content.chance}
                      onChange={(chance) => patchContent(index, contentIndex, { chance })}
                      className="w-20"
                      aria-label="Chance this is inside, in percent"
                    />
                    <Button
                      variant="ghost"
                      onClick={() =>
                        patchEntry(index, {
                          contents: contents.filter((_, i) => i !== contentIndex),
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
                        contents: [...contents, { tileId: "", chance: DEFAULT_KIT_CHANCE }],
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
            onChange([...kit, { slot: "weapon", tileId: "", chance: DEFAULT_KIT_CHANCE }])
          }
        >
          Add item
        </Button>
      </div>
    </div>
  );
}
