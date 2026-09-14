import { useState } from "react";
import { IconTrash } from "@tabler/icons-react";
import { pileMax } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { mintItemId } from "../lib/itemInstance";
import { stow, withCount } from "../lib/piles";
import type { TileDef, TilesetDef } from "../lib/types";
import { Button, FieldLabel, NumberInput, Tooltip } from "../ui";
import { TilePickList } from "./TileIdMultiSelect";
import { TilePreview } from "./TilePreview";

const PREVIEW_SIZE_PX = 24;

/**
 * One more of `tileId` in this container, or null when there is no room.
 *
 * **`stow` rather than an append**, which is the same call stashing something
 * in a bag makes in play — so clicking bread four times authors one pile of
 * four in one square, exactly as putting four loaves in would, and the fifth is
 * refused for the same reason the fifth would be. Writing the rule again here
 * would be a second answer to "what fits", and the editor would be the one
 * that was wrong.
 *
 * The id is minted rather than left off, so what the field hands around is an
 * {@link ItemInstance} and not a shape that only looks like one.
 * `serializeMap` strips it on the way to `data/map.json` and the world mints a
 * fresh one on load — see `../game/itemIds` — so nothing an author types here
 * reaches the file, and two chests of bread are still two different loaves.
 */
export function addContent(
  contents: readonly ItemInstance[],
  tileId: string,
  capacity: number,
  tilesById: Record<string, TileDef>,
): ItemInstance[] | null {
  return stow(contents, { id: mintItemId(), tileId }, capacity, tilesById);
}

/** How many of one entry this is. A count of one is written as no count. */
export function setContentCount(
  contents: readonly ItemInstance[],
  index: number,
  count: number,
): ItemInstance[] {
  return contents.map((item, i) => (i === index ? withCount(item, count) : item));
}

/** One entry gone, and the squares after it closed up. */
export function removeContent(
  contents: readonly ItemInstance[],
  index: number,
): ItemInstance[] {
  return contents.filter((_item, i) => i !== index);
}

/** The name to call an entry whose tile has gone from the catalogue. */
function nameOf(
  instance: ItemInstance,
  tilesById: Record<string, TileDef>,
): string {
  return tilesById[instance.tileId]?.name || instance.tileId;
}

/**
 * What one container placement is holding before anybody has played with it.
 *
 * **A placement field, not a tile one.** The tile says how big a crate is; this
 * says what is in *that* crate, which is why it sits beside the description and
 * the reward rather than in the tile editor — two crates of the same tile are a
 * larder and an armoury.
 *
 * The squares are listed rather than drawn as the grid a player sees. A grid
 * would be a second place the container's layout is decided, and what an author
 * needs here is the list with names and counts on it, which is the thing the
 * in-game panel deliberately does not give you room for.
 */
export function ContainerContentsField({
  contents,
  capacity,
  stowable,
  tilesById,
  tilesets,
  onChange,
}: {
  contents: ItemInstance[];
  /** The container's `size` — how many squares there are to fill. */
  capacity: number;
  /** What may go in: items, never a container, because nothing nests. */
  stowable: TileDef[];
  tilesById: Record<string, TileDef>;
  tilesets: TilesetDef[];
  onChange: (next: ItemInstance[]) => void;
}) {
  // Cleared by the next pick that lands, so the line says why *this* click did
  // nothing rather than standing as a permanent note about the container.
  const [refusal, setRefusal] = useState<string | null>(null);

  const pick = (tileId: string) => {
    const next = addContent(contents, tileId, capacity, tilesById);
    if (!next) {
      const name = tilesById[tileId]?.name || tileId;
      setRefusal(`No room for ${name} — all ${capacity} squares are taken.`);
      return;
    }
    setRefusal(null);
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <FieldLabel info="What this particular container is found holding. Minted fresh every time the world loads, so looting it and saving the map does not empty what the author wrote.">
          Contents
        </FieldLabel>
        <span className="font-mono text-[10px] text-muted">
          {contents.length}/{capacity}
        </span>
      </div>

      {contents.length === 0 ? (
        <p className="text-[11px] leading-snug text-muted">
          Empty — whoever opens this finds nothing in it.
        </p>
      ) : (
        <ul className="flex flex-col gap-1" aria-label="Contents, in slot order">
          {contents.map((item, index) => {
            const def = tilesById[item.tileId];
            const name = nameOf(item, tilesById);
            const max = def ? pileMax(def) : 1;
            return (
              <li
                key={item.id}
                className="flex items-center gap-2 border-2 border-border bg-paper p-1"
              >
                {def ? (
                  <TilePreview
                    tile={def}
                    tilesets={tilesets}
                    size={PREVIEW_SIZE_PX}
                  />
                ) : null}
                <span className="min-w-0 flex-1 truncate font-bold">
                  {name}
                  {def ? null : (
                    <span className="ml-1 font-normal text-muted">
                      (missing)
                    </span>
                  )}
                </span>
                {/* Only where a pile is a thing this tile can be: a count
                    beside a sword is a box that can never say anything but 1.
                    See `../lib/item`'s pileMax. */}
                {max > 1 ? (
                  <label className="flex items-center gap-1">
                    <span className="sr-only">{`How many ${name}`}</span>
                    <span aria-hidden="true" className="text-muted">
                      ×
                    </span>
                    <NumberInput
                      className="w-14"
                      min={1}
                      max={max}
                      step={1}
                      value={item.count ?? 1}
                      onChange={(count) =>
                        onChange(setContentCount(contents, index, count))
                      }
                    />
                  </label>
                ) : null}
                <Tooltip content={`Remove ${name}`}>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove ${name} from contents`}
                    className="text-muted hover:text-danger"
                    onClick={() => {
                      setRefusal(null);
                      onChange(removeContent(contents, index));
                    }}
                  >
                    <IconTrash size={16} aria-hidden="true" />
                  </Button>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      )}

      {refusal ? (
        <p role="status" className="text-[11px] leading-snug text-danger">
          {refusal}
        </p>
      ) : null}

      <TilePickList
        tiles={stowable}
        tilesets={tilesets}
        label="Add to contents"
        onPick={pick}
      />
    </div>
  );
}
