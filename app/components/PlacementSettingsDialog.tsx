import { useState } from "react";
import type { Coord, PlacedTile, TileDef, TilesetDef } from "../lib/types";
import type { ItemInstance } from "../lib/itemInstance";
import { MAX_DESCRIPTION_LENGTH, MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import {
  MAX_ENGRAVING_LENGTH,
  UNKNOWN_ENGRAVING,
  engravedName,
  isEngravable,
} from "../lib/engraving";
import { MAX_REWARD_ITEMS } from "../lib/interactions";
import { useEditorStore } from "../editor/store";
import {
  Button,
  Dialog,
  FieldLabel,
  Input,
  OptionalNumberInput,
  Textarea,
} from "../ui";
import { ContainerContentsField } from "./ContainerContentsField";
import { TileIdMultiSelect } from "./TileIdMultiSelect";

/**
 * The three destination fields as they are being typed.
 *
 * Strings, because a field somebody has just emptied is not a zero and must not
 * commit as one — the same reason every other field in this dialog is held as
 * typed and read at the end.
 */
export type TeleportDraft = { x: string; y: string; z: string };

const NO_DESTINATION: TeleportDraft = { x: "", y: "", z: "" };

const DESTINATION_AXES = ["x", "y", "z"] as const;

function draftFromCoord(to: Coord | undefined): TeleportDraft {
  if (!to) return NO_DESTINATION;
  return { x: String(to.x), y: String(to.y), z: String(to.z) };
}

/**
 * The three fields as a cell, or null for "this placement goes nowhere".
 *
 * **A blank axis is a zero; only all three blank is no destination.** The
 * fields start empty on a placement nobody has authored yet, and they show `0`
 * as their placeholder — so "leave the two you do not care about alone and type
 * the one you do" is the obvious way to author a ladder, and it has to be the
 * way that works. Demanding all three silently threw that whole edit away: the
 * two untouched fields read as nothing, the destination came back null, and
 * Done cleared the field it looked like it was filling in.
 *
 * Emptying every field is still how a portal is un-authored, which is the one
 * thing the all-or-nothing rule was there for. It is just no longer something
 * you can trigger by not typing.
 */
export function readDestination(draft: TeleportDraft): Coord | null {
  if (!draft.x.trim() && !draft.y.trim() && !draft.z.trim()) return null;

  const x = axisValue(draft.x);
  const y = axisValue(draft.y);
  const z = axisValue(draft.z);
  if (x === null || y === null || z === null) return null;
  return { x, y, z };
}

/** One axis as its box shows it: blank stays blank, so the placeholder shows. */
function axisDraftValue(raw: string): number | undefined {
  return raw.trim() ? Number(raw) : undefined;
}

/** One axis: blank is the zero the placeholder promises, junk is a refusal. */
function axisValue(raw: string): number | null {
  if (!raw.trim()) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Everything that belongs to one *placement* rather than to its tile.
 *
 * A modal because this list only grows. The stack panel is a column of rows in
 * a side panel, and every field added inline pushes the actual stack — the
 * thing the panel is for — further down it. Direction stays on the row: it is
 * four buttons, it is visual, and it is flicked constantly while placing.
 *
 * **Committed on close, not per keystroke.** These are text fields, so a commit
 * per character would be an undo entry and a map identity each. Closing is the
 * one moment the author is definitely finished, and it catches Escape and the
 * ✕ as well as the Done button — a field committed only on blur loses whatever
 * was typed when the dialog is dismissed straight from the keyboard.
 */
export function PlacementSettingsDialog({
  placed,
  def,
  stackIndex,
  wired,
  gives,
  teleports,
  holds,
  giveable,
  stowable,
  tilesById,
  tilesets,
  channelListId,
  onClose,
}: {
  placed: PlacedTile;
  def: TileDef;
  stackIndex: number;
  /** Only wired tiles get a channel; see `isWired` in ./SelectedStackList. */
  wired: boolean;
  /** Only giver tiles get a reward; see `isGiver` in ./SelectedStackList. */
  gives: boolean;
  /**
   * Only an *absolute* teleporter gets a destination; see `needsDestination` in
   * ./SelectedStackList. A ladder carries its whole journey on the tile, so
   * there is nothing here for it to say.
   */
  teleports: boolean;
  /**
   * How many squares this container has, or null when the tile is not one; see
   * `isContainer` in ./SelectedStackList. A size rather than a flag because the
   * contents field needs the number anyway, and two sources for "is this a
   * container" is one too many.
   */
  holds: number | null;
  /** What a reward may hand over — plain items, never a container. */
  giveable: TileDef[];
  /** What may be authored into a container — plain items, because nothing nests. */
  stowable: TileDef[];
  /** For the contents field: pile ceilings and the name beside each square. */
  tilesById: Record<string, TileDef>;
  tilesets: TilesetDef[];
  channelListId: string;
  onClose: () => void;
}) {
  // Seeded once, because the parent mounts this only while it is open: every
  // open therefore starts from what the map holds now, with no effect needed to
  // re-sync after an undo or a different cell being selected into the row.
  const [channel, setChannel] = useState(placed.channel ?? "");
  const [description, setDescription] = useState(placed.description ?? "");
  const [engraved, setEngraved] = useState(placed.engraved ?? "");
  const [rewardTag, setRewardTag] = useState(placed.rewardTag ?? "");
  const [rewardTileIds, setRewardTileIds] = useState<string[]>(
    placed.rewardTileIds ?? [],
  );
  // Held as typed rather than as a `Coord`, because a field being cleared while
  // somebody retypes it is not a destination of zero — the same reason the text
  // fields above hold strings. `readDestination` is what turns the three back
  // into a cell, or into nothing.
  const [teleportTo, setTeleportTo] = useState<TeleportDraft>(() =>
    draftFromCoord(placed.teleportTo),
  );
  // Held as a draft like everything else here, so a chest filled and emptied
  // again while the dialog is open is one undo entry and not six.
  const [contents, setContents] = useState<ItemInstance[]>(
    () => placed.contents ?? [],
  );

  // Off the tile's own name rather than a flag on the def: a name with `%s` in
  // it *is* the declaration that this kind of thing is somebody's. One fact,
  // read where it is written. See `../lib/engraving`.
  const engravable = isEngravable(def.name);

  const commitAndClose = () => {
    const store = useEditorStore.getState();
    if (wired) store.setStackChannel(stackIndex, channel);
    if (gives) store.setStackReward(stackIndex, rewardTag, rewardTileIds);
    if (teleports) {
      store.setStackTeleport(stackIndex, readDestination(teleportTo));
    }
    if (holds !== null) store.setStackContents(stackIndex, contents);
    store.setStackDescription(stackIndex, description);
    if (engravable) store.setStackEngraving(stackIndex, engraved);
    onClose();
  };

  return (
    <Dialog
      open
      // Every dismissal routes here — Escape, the ✕, the backdrop — so there is
      // one way out and it is the one that saves.
      onOpenChange={(open) => {
        if (!open) commitAndClose();
      }}
      // The engraving filled in, because this dialog is about *this* placement
      // and not about the kind of thing it is: "Old Hermit's skull settings"
      // over the field that says so beats "%s's skull settings".
      title={`${engravedName(def.name, placed.engraved)} settings`}
      footer={
        <Button size="sm" onClick={commitAndClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-bold uppercase text-muted">Description</span>
          <Textarea
            rows={3}
            maxLength={MAX_DESCRIPTION_LENGTH}
            placeholder="What this says when somebody looks at it"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            // Autofocused because reading and writing descriptions is what this
            // dialog is mostly for; the channel is the rarer visit.
            autoFocus
          />
          <span className="text-[11px] leading-snug text-muted">
            Shown under the name on shift-look. Belongs to the cell, not the
            tile.
          </span>
        </label>

        {engravable ? (
          <label className="flex flex-col gap-1 text-xs">
            <FieldLabel info="Goes where the tile's name says %s. Belongs to the cell, not the tile — one skull tile is every skull in the world.">
              Engraved with
            </FieldLabel>
            <Input
              maxLength={MAX_ENGRAVING_LENGTH}
              placeholder={UNKNOWN_ENGRAVING}
              value={engraved}
              onChange={(e) => setEngraved(e.target.value)}
            />
          </label>
        ) : null}

        {wired ? (
          <label className="flex flex-col gap-1 text-xs">
            <FieldLabel info="Emitters drive the channel and receivers follow it. Sharing a name is the whole of the wiring.">
              Signal channel
            </FieldLabel>
            <Input
              list={channelListId}
              placeholder="channel"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
            />
          </label>
        ) : null}

        {gives ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-4">
            <label className="flex flex-col gap-1 text-xs">
              <FieldLabel info="Written on the player when they take it, and hides the reward from them afterwards. Two placements with the same tag are a choice: take one and the other closes.">
                Reward tag
              </FieldLabel>
              <Input
                placeholder="chest-42"
                value={rewardTag}
                onChange={(e) => setRewardTag(e.target.value)}
              />
            </label>

            <TileIdMultiSelect
              tiles={giveable}
              tilesets={tilesets}
              selectedIds={rewardTileIds}
              onChange={(ids) => setRewardTileIds(ids.slice(0, MAX_REWARD_ITEMS))}
              label="Items"
              info={`Up to ${MAX_REWARD_ITEMS}, never a container. The player needs room for all of them at once or is refused.`}
              emptyHint="None — nothing to give means no row is offered."
            />
          </div>
        ) : null}

        {holds !== null ? (
          <div className="border-t-2 border-border pt-4">
            <ContainerContentsField
              contents={contents}
              capacity={holds}
              stowable={stowable}
              tilesById={tilesById}
              tilesets={tilesets}
              onChange={setContents}
            />
          </div>
        ) : null}

        {teleports ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-4">
            <div className="flex flex-col gap-1 text-xs">
              <FieldLabel info="Belongs to the cell rather than the tile, so one portal tile can be every doorway in the world. Blank axes read as 0; all three blank leads nowhere.">
                Destination cell
              </FieldLabel>
              <div className="flex gap-2">
                {DESTINATION_AXES.map((axis) => (
                  <label key={axis} className="flex flex-1 flex-col gap-1">
                    <span className="font-bold uppercase text-muted">
                      {axis}
                    </span>
                    <OptionalNumberInput
                      step={1}
                      // The level bounds only, and only on z: x and y run as far
                      // as the world does, which nothing here knows.
                      {...(axis === "z"
                        ? { min: MIN_LEVEL, max: MAX_LEVEL }
                        : {})}
                      placeholder="0"
                      // The draft keeps strings so a blank axis stays blank —
                      // see `readDestination`. Only a whole number ever comes
                      // back out of the box, so junk never reaches the draft.
                      value={axisDraftValue(teleportTo[axis])}
                      onChange={(value) =>
                        setTeleportTo((current) => ({
                          ...current,
                          [axis]: value === undefined ? "" : String(value),
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
