import { useEffect, useRef, useState } from "react";
import { IconTrash } from "@tabler/icons-react";
import { engravedName } from "../lib/engraving";
import { pileMax } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { mintItemId } from "../lib/itemInstance";
import { stow, withCount } from "../lib/piles";
import type { TileDef, TilesetDef } from "../lib/types";
import { Button, FieldLabel, NumberInput, Tooltip } from "../ui";
import { TilePickList } from "./TileIdMultiSelect";
import { TilePreview } from "./TilePreview";

const PREVIEW_SIZE_PX = 24;

export function addContent(
  contents: readonly ItemInstance[],
  tileId: string,
  capacity: number,
  tilesById: Record<string, TileDef>,
): ItemInstance[] | null {
  return stow(contents, { id: mintItemId(), tileId }, capacity, tilesById);
}

export function setContentCount(
  contents: readonly ItemInstance[],
  index: number,
  count: number,
): ItemInstance[] {
  return contents.map((item, i) => (i === index ? withCount(item, count) : item));
}

export function removeContent(contents: readonly ItemInstance[], index: number): ItemInstance[] {
  return contents.filter((_item, i) => i !== index);
}

function nameOf(instance: ItemInstance, tilesById: Record<string, TileDef>): string {
  const name = tilesById[instance.tileId]?.name;
  return name ? engravedName(name, instance.engraved) : instance.tileId;
}

type Announcement = { text: string; seq: number; refused: boolean };

function saidText(said: Announcement | null): string {
  if (!said) return "";
  return said.seq % 2 === 0 ? said.text : `${said.text}\u00a0`;
}

export function ContainerContentsField({
  contents,
  capacity,
  stowable,
  tilesById,
  tilesets,
  onChange,
}: {
  contents: ItemInstance[];
  capacity: number;
  stowable: TileDef[];
  tilesById: Record<string, TileDef>;
  tilesets: TilesetDef[];
  onChange: (next: ItemInstance[]) => void;
}) {
  const [said, setSaid] = useState<Announcement | null>(null);
  const [claiming, setClaiming] = useState<number | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const emptyRef = useRef<HTMLParagraphElement>(null);

  const say = (text: string, refused = false) =>
    setSaid((last) => ({ text, refused, seq: (last?.seq ?? 0) + 1 }));

  const pick = (tileId: string) => {
    const name = tilesById[tileId]?.name || tileId;
    const next = addContent(contents, tileId, capacity, tilesById);
    if (!next) {
      say(`No room for ${name} — all ${capacity} squares are taken.`, true);
      return;
    }
    onChange(next);
    say(`${name} added — ${next.length} of ${capacity} squares used.`);
  };

  useEffect(() => {
    if (claiming === null) return;
    setClaiming(null);
    const buttons = listRef.current?.querySelectorAll<HTMLElement>(
      'button[data-remove-content="true"]',
    );
    if (buttons && buttons.length > 0) {
      buttons[Math.min(claiming, buttons.length - 1)]?.focus();
      return;
    }
    emptyRef.current?.focus();
  }, [claiming]);

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
        <p ref={emptyRef} tabIndex={-1} className="text-[11px] leading-snug text-muted">
          Empty — whoever opens this finds nothing in it.
        </p>
      ) : (
        <ul ref={listRef} className="flex flex-col gap-1" aria-label="Contents, in slot order">
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
                  <TilePreview tile={def} tilesets={tilesets} size={PREVIEW_SIZE_PX} still />
                ) : null}
                <span className="min-w-0 flex-1 truncate font-bold">
                  {name}
                  {def ? null : <span className="ml-1 font-normal text-muted">(missing)</span>}
                </span>
                {max > 1 ? (
                  <span className="flex items-center gap-1">
                    <span aria-hidden="true" className="text-muted">
                      ×
                    </span>
                    <NumberInput
                      className="w-14"
                      aria-label={`How many ${name}`}
                      min={1}
                      max={max}
                      step={1}
                      value={item.count ?? 1}
                      onChange={(count) => onChange(setContentCount(contents, index, count))}
                    />
                  </span>
                ) : null}
                <Tooltip content={`Remove ${name}`}>
                  <Button
                    size="icon"
                    variant="ghost"
                    data-remove-content="true"
                    aria-label={`Remove ${name} from contents`}
                    className="text-muted hover:text-danger"
                    onClick={() => {
                      onChange(removeContent(contents, index));
                      say(`${name} removed — ${contents.length - 1} of ${capacity} squares used.`);
                      setClaiming(index);
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

      <p
        role="status"
        className={["text-[11px] leading-snug text-danger", said?.refused ? "" : "sr-only"].join(
          " ",
        )}
      >
        {saidText(said)}
      </p>

      <FieldLabel info="Clicking adds one. More of something already in here joins that pile where the tile piles at all; otherwise it takes a square of its own.">
        Add to contents
      </FieldLabel>
      <TilePickList
        tiles={stowable}
        tilesets={tilesets}
        label="Add to contents"
        mode="add"
        onPick={pick}
      />
    </div>
  );
}
