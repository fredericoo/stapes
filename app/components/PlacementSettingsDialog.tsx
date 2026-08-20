import { useState } from "react";
import type { Coord, PlacedTile, TileDef, TilesetDef } from "../lib/types";
import { MAX_DESCRIPTION_LENGTH, MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import type { TeleportDestinationKind } from "../lib/interactions";
import { MAX_REWARD_ITEMS } from "../lib/interactions";
import { useEditorStore } from "../editor/store";
import { Button, Dialog, Input, Textarea } from "../ui";
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
  teleportDestinationKind,
  giveable,
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
  /** Only teleporters get a destination; see `isTeleporter` in ./SelectedStackList. */
  teleports: boolean;
  /**
   * How the three numbers read, which is the tile's answer rather than this
   * slot's — see `TeleportInteraction.destination`. Null when the tile does not
   * teleport, in which case there is nothing to label.
   */
  teleportDestinationKind: TeleportDestinationKind | null;
  /** What a reward may hand over — plain items, never a container. */
  giveable: TileDef[];
  tilesets: TilesetDef[];
  channelListId: string;
  onClose: () => void;
}) {
  // Seeded once, because the parent mounts this only while it is open: every
  // open therefore starts from what the map holds now, with no effect needed to
  // re-sync after an undo or a different cell being selected into the row.
  const [channel, setChannel] = useState(placed.channel ?? "");
  const [description, setDescription] = useState(placed.description ?? "");
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

  const commitAndClose = () => {
    const store = useEditorStore.getState();
    if (wired) store.setStackChannel(stackIndex, channel);
    if (gives) store.setStackReward(stackIndex, rewardTag, rewardTileIds);
    if (teleports) {
      store.setStackTeleport(stackIndex, readDestination(teleportTo));
    }
    store.setStackDescription(stackIndex, description);
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
      title={`${def.name} settings`}
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
            Shown under the tile’s name when a player holds shift and looks at
            this placement. It belongs to the spot, not to the tile — swap the
            tile in this slot and the text stays.
          </span>
        </label>

        {wired ? (
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-bold uppercase text-muted">
              Signal channel
            </span>
            <Input
              list={channelListId}
              placeholder="channel"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
            />
            <span className="text-[11px] leading-snug text-muted">
              Emitters drive the channel and receivers follow it. Sharing a name
              is the whole of the wiring.
            </span>
          </label>
        ) : null}

        {gives ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-4">
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-bold uppercase text-muted">Reward tag</span>
              <Input
                placeholder="chest-42"
                value={rewardTag}
                onChange={(e) => setRewardTag(e.target.value)}
              />
              <span className="text-[11px] leading-snug text-muted">
                Written on the player when they take it, and what hides it from
                them afterwards. Give two placements the <em>same</em> tag to
                make them a choice: take the left chest and the right one
                closes. Sharing a tag is the whole of the binding, exactly as it
                is for a channel.
              </span>
            </label>

            <TileIdMultiSelect
              tiles={giveable}
              tilesets={tilesets}
              selectedIds={rewardTileIds}
              onChange={(ids) => setRewardTileIds(ids.slice(0, MAX_REWARD_ITEMS))}
              label="Items given"
              emptyHint="Pick what this one hands over. A tag with nothing to give is not offered at all."
            />
            <span className="text-[11px] leading-snug text-muted">
              Items only, never a container: a bag cannot go inside a bag, so
              there would be nowhere to put it. At most {MAX_REWARD_ITEMS},
              which is the biggest bag there is — the player needs room for the
              lot at once or they are refused.
            </span>
          </div>
        ) : null}

        {teleports ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-4">
            <div className="flex flex-col gap-1 text-xs">
              <span className="font-bold uppercase text-muted">
                {teleportDestinationKind === "relative"
                  ? "Destination offset"
                  : "Destination cell"}
              </span>
              <div className="flex gap-2">
                {DESTINATION_AXES.map((axis) => (
                  <label key={axis} className="flex flex-1 flex-col gap-1">
                    <span className="font-bold uppercase text-muted">
                      {axis}
                    </span>
                    <Input
                      type="number"
                      step={1}
                      // The level bounds only, and only on z: x and y run as far
                      // as the world does, which nothing here knows.
                      {...(axis === "z"
                        ? { min: MIN_LEVEL, max: MAX_LEVEL }
                        : {})}
                      placeholder="0"
                      value={teleportTo[axis]}
                      onChange={(e) =>
                        setTeleportTo((current) => ({
                          ...current,
                          [axis]: e.target.value,
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
              <span className="text-[11px] leading-snug text-muted">
                {teleportDestinationKind === "relative"
                  ? "Counted from this placement’s own cell, never from wherever the player was standing — z + 1 is one floor up from here. Leave any of the three blank and this placement leads nowhere."
                  : "The cell itself, whole. Leave any of the three blank and this placement leads nowhere."}
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
