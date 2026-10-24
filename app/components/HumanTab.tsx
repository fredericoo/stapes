import { useMemo } from "react";
import {
  composeSheet,
  lookOfTileHuman,
  tileHumanFromLook,
  wearsHumanSheet,
  type TileHuman,
} from "../lib/humanSprite";
import type { TileDef } from "../lib/types";
import { SwitchField } from "../ui";
import { HumanLookFields, WalkPreview, useLayerBlocks } from "./HumanLookFields";

const NEW_HUMAN: TileHuman = {
  skin: "default",
  hair: "red",
  head: "short-hair",
  outfit: { clothes: "white-tunic", shoes: "dark-boots" },
};

const TILE_LAYERS = ["head", "clothes", "shoes", "hat"] as const;

export function HumanTab({
  draft,
  onChange,
}: {
  draft: TileDef;
  onChange: (next: TileDef) => void;
}) {
  const { parts, error } = useLayerBlocks();
  const human = draft.human;
  const look = useMemo(() => (human ? lookOfTileHuman(human) : null), [human]);
  const sheet = useMemo(() => (parts && look ? composeSheet(parts, look) : null), [parts, look]);

  return (
    <div className="flex flex-col gap-3">
      <SwitchField
        size="section"
        label="Draw from human parts"
        checked={human !== undefined}
        onCheckedChange={(on) => onChange({ ...draft, human: on ? NEW_HUMAN : undefined })}
        info="The tile is drawn from the human parts instead of its own sheet. Skin, hair and head are fixed; the outfit is what it wears in a slot with nothing equipped."
      />
      {human && !wearsHumanSheet(draft) ? (
        <p className="border-2 border-danger bg-danger/10 px-2 py-1 text-xs text-danger">
          This tile's frames don't fit one 48×64 character block, so it keeps drawing from its own
          sheet. Give it the player's frames to wear the parts.
        </p>
      ) : null}
      {error ? <p className="text-xs text-danger">Couldn't load the parts: {error}</p> : null}
      {human && parts && look && sheet ? (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4">
          <div className="flex min-w-0 flex-col gap-4">
            <HumanLookFields
              parts={parts}
              look={look}
              layers={TILE_LAYERS}
              onChange={(next) => onChange({ ...draft, human: tileHumanFromLook(next) })}
            />
          </div>
          <WalkPreview sheet={sheet} />
        </div>
      ) : null}
    </div>
  );
}
