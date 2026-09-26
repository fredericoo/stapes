import type { TileDef, TilesetDef } from "../lib/types";
import type { ItemDrag } from "./useItemDrag";
import { TilePreview } from "./TilePreview";

const FRONT = "s" as const;

const DRAGGED_SIZE_PX = 40;

export function DragLayer({
  drag,
  tilesById,
  tilesets,
}: {
  drag: ItemDrag;
  tilesById: Record<string, TileDef>;
  tilesets: TilesetDef[];
}) {
  const held = drag.held;
  const tile = held ? (tilesById[held.instance.tileId] ?? null) : null;

  return (
    <div
      ref={drag.layerRef}
      className="pointer-events-none fixed left-0 top-0 z-50"
      style={{ visibility: held ? "visible" : "hidden" }}
      aria-hidden="true"
    >
      <div style={{ transform: "translate(-50%, -50%)" }}>
        {tile ? (
          <TilePreview
            tile={tile}
            tilesets={tilesets}
            size={DRAGGED_SIZE_PX}
            direction={FRONT}
            still
            chrome={false}
            background={null}
          />
        ) : null}
      </div>
    </div>
  );
}
