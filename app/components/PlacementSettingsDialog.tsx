import { useState } from "react";
import type { PlacedTile, TileDef } from "../lib/types";
import { MAX_DESCRIPTION_LENGTH } from "../lib/types";
import { useEditorStore } from "../editor/store";
import { Button, Dialog, Input, Textarea } from "../ui";

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
  channelListId,
  onClose,
}: {
  placed: PlacedTile;
  def: TileDef;
  stackIndex: number;
  /** Only wired tiles get a channel; see `isWired` in ./SelectedStackList. */
  wired: boolean;
  channelListId: string;
  onClose: () => void;
}) {
  // Seeded once, because the parent mounts this only while it is open: every
  // open therefore starts from what the map holds now, with no effect needed to
  // re-sync after an undo or a different cell being selected into the row.
  const [channel, setChannel] = useState(placed.channel ?? "");
  const [description, setDescription] = useState(placed.description ?? "");

  const commitAndClose = () => {
    const store = useEditorStore.getState();
    if (wired) store.setStackChannel(stackIndex, channel);
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
      </div>
    </Dialog>
  );
}
