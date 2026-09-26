import { useState } from "react";
import type { Coord, PlacedTile, TileDef, TilesetDef } from "../lib/types";
import type { ItemInstance } from "../lib/itemInstance";
import { MAX_INSCRIPTION_LENGTH, MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import {
  MAX_ENGRAVING_LENGTH,
  UNKNOWN_ENGRAVING,
  engravedName,
  isEngravable,
} from "../lib/engraving";
import { MAX_REWARD_ITEMS } from "../lib/interactions";
import { useEditorStore } from "../editor/store";
import { Button, Dialog, FieldLabel, Input, OptionalNumberInput, Textarea } from "../ui";
import { ContainerContentsField } from "./ContainerContentsField";
import { TileIdMultiSelect } from "./TileIdMultiSelect";

export type TeleportDraft = { x: string; y: string; z: string };

const NO_DESTINATION: TeleportDraft = { x: "", y: "", z: "" };

const DESTINATION_AXES = ["x", "y", "z"] as const;

function draftFromCoord(to: Coord | undefined): TeleportDraft {
  if (!to) return NO_DESTINATION;
  return { x: String(to.x), y: String(to.y), z: String(to.z) };
}

export function readDestination(draft: TeleportDraft): Coord | null {
  if (!draft.x.trim() && !draft.y.trim() && !draft.z.trim()) return null;

  const x = axisValue(draft.x);
  const y = axisValue(draft.y);
  const z = axisValue(draft.z);
  if (x === null || y === null || z === null) return null;
  return { x, y, z };
}

function axisDraftValue(raw: string): number | undefined {
  return raw.trim() ? Number(raw) : undefined;
}

function axisValue(raw: string): number | null {
  if (!raw.trim()) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

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
  wired: boolean;
  gives: boolean;
  teleports: boolean;
  holds: number | null;
  giveable: TileDef[];
  stowable: TileDef[];
  tilesById: Record<string, TileDef>;
  tilesets: TilesetDef[];
  channelListId: string;
  onClose: () => void;
}) {
  const [channel, setChannel] = useState(placed.channel ?? "");
  const [inscription, setInscription] = useState(placed.inscription ?? "");
  const [description, setDescription] = useState(placed.description ?? "");
  const [engraved, setEngraved] = useState(placed.engraved ?? "");
  const [rewardTag, setRewardTag] = useState(placed.rewardTag ?? "");
  const [rewardTileIds, setRewardTileIds] = useState<string[]>(placed.rewardTileIds ?? []);
  const [teleportTo, setTeleportTo] = useState<TeleportDraft>(() =>
    draftFromCoord(placed.teleportTo),
  );
  const [contents, setContents] = useState<ItemInstance[]>(() => placed.contents ?? []);

  const engravable = isEngravable(def.name);

  const commitAndClose = () => {
    const store = useEditorStore.getState();
    if (wired) store.setStackChannel(stackIndex, channel);
    if (gives) store.setStackReward(stackIndex, rewardTag, rewardTileIds);
    if (teleports) {
      store.setStackTeleport(stackIndex, readDestination(teleportTo));
    }
    if (holds !== null) store.setStackContents(stackIndex, contents);
    store.setStackInscription(stackIndex, inscription);
    store.setStackDescription(stackIndex, description);
    if (engravable) store.setStackEngraving(stackIndex, engraved);
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) commitAndClose();
      }}
      title={`${engravedName(def.name, placed.engraved)} settings`}
      footer={
        <Button size="sm" onClick={commitAndClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-bold uppercase text-muted">Inscription</span>
          <Textarea
            rows={3}
            maxLength={MAX_INSCRIPTION_LENGTH}
            placeholder="What this says to anybody who walks up to it"
            value={inscription}
            onChange={(e) => setInscription(e.target.value)}
            autoFocus
          />
          <span className="text-[11px] leading-snug text-muted">
            Read out to anybody standing next to it, like a sign. Belongs to the cell, not the tile.
          </span>
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="font-bold uppercase text-muted">Description</span>
          <Textarea
            rows={3}
            maxLength={MAX_INSCRIPTION_LENGTH}
            placeholder="What examining this would tell you"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <span className="text-[11px] leading-snug text-muted">
            Only on the item card and on shift-look — never recited to passers-by. Belongs to the
            cell, not the tile.
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
                    <span className="font-bold uppercase text-muted">{axis}</span>
                    <OptionalNumberInput
                      step={1}
                      {...(axis === "z" ? { min: MIN_LEVEL, max: MAX_LEVEL } : {})}
                      placeholder="0"
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
