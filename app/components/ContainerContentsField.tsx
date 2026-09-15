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
  const name = tilesById[instance.tileId]?.name;
  return name ? engravedName(name, instance.engraved) : instance.tileId;
}

/**
 * What the field last said, and how many times it has said anything.
 *
 * The counter is what makes a repeat audible. Clicking bread at a full crate
 * twice produces the same sentence both times, and a live region announces what
 * *changed* — so without something moving, the second click is silence, which
 * is precisely the answer a refused click must never give. {@link saidText}
 * turns the counter into a difference the region can see.
 *
 * `refused` decides whether it is drawn as well as read out: a refusal is the
 * only feedback a refused click has, and everything else — added, removed — is
 * already visible in the list it changed.
 */
type Announcement = { text: string; seq: number; refused: boolean };

/**
 * The line as the region carries it: the sentence, and on every other
 * announcement a trailing space.
 *
 * Invisible, unread, and the whole point — the same sentence twice in a row is
 * not a change, and a live region only announces changes. The alternative is
 * remounting the region with a `key`, which brings back the problem the region
 * is mounted early to avoid: a region that appears already carrying its text is
 * one nothing was watching.
 */
function saidText(said: Announcement | null): string {
  if (!said) return "";
  return said.seq % 2 === 0 ? said.text : `${said.text}\u00a0`;
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
  const [said, setSaid] = useState<Announcement | null>(null);
  /** Which square's remove button wants focus once the list is rebuilt. */
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

  /**
   * Where focus goes when the row under it stops existing: the square that slid
   * into its place, or the empty line when that was the last of them.
   *
   * The same answer `./SelectedStackList`'s `focusAfterRemove` gives, because it
   * is the same act — holding Enter on a trash icon should empty a crate rather
   * than work once and drop the author somewhere else. What is different here is
   * *when*: the row is inside a dialog, and the dialog's focus trap catches the
   * removal and pulls focus to the popup. So the row asks for a square by index
   * and this claims it after the list has been rebuilt, which is the only moment
   * the trap has finished having its say.
   */
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
        <p
          ref={emptyRef}
          tabIndex={-1}
          className="text-[11px] leading-snug text-muted"
        >
          Empty — whoever opens this finds nothing in it.
        </p>
      ) : (
        <ul
          ref={listRef}
          className="flex flex-col gap-1"
          aria-label="Contents, in slot order"
        >
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
                    still
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
                  <span className="flex items-center gap-1">
                    <span aria-hidden="true" className="text-muted">
                      ×
                    </span>
                    {/* Named on the box rather than by a `<label>` around it.
                        The box renders its own out-of-range message, and a
                        label wrapping both would fold that message into the
                        field's name: "How many Bread Must be at most 3". */}
                    <NumberInput
                      className="w-14"
                      aria-label={`How many ${name}`}
                      min={1}
                      max={max}
                      step={1}
                      value={item.count ?? 1}
                      onChange={(count) =>
                        onChange(setContentCount(contents, index, count))
                      }
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
                      say(
                        `${name} removed — ${contents.length - 1} of ${capacity} squares used.`,
                      );
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

      {/* Mounted whether or not there is anything to say, because a live region
          that arrives carrying its text is a live region most screen readers
          were not yet watching. */}
      <p
        role="status"
        className={[
          "text-[11px] leading-snug text-danger",
          said?.refused ? "" : "sr-only",
        ].join(" ")}
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
