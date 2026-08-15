import type { TileDef, TilesetDef } from "../lib/types";
import type { ItemDrag } from "./useItemDrag";
import { TilePreview } from "./TilePreview";

/**
 * The thing under the pointer while it is being dragged.
 *
 * Its own layer above everything rather than a sprite moved inside a panel,
 * because a drag crosses panels: a sword leaving a chest and arriving in a bag
 * passes over the boundary between two components, and anything drawn inside
 * either of them would be clipped at the edge of it.
 *
 * Positioned by writing a transform straight onto the node — see
 * `./useItemDrag` — so the page around the game is not re-rendered every few
 * milliseconds to move one 32-pixel sprite.
 *
 * Invisible to the pointer, which is the whole reason a drop can be resolved at
 * all: with pointer events on, the layer would be the topmost element under the
 * cursor and every hit test would find it instead of the slot beneath.
 */

/** Which sprite stands for a tile in hand — the one facing the reader. */
const FRONT: "s" = "s";

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
      // Hidden rather than unmounted, so the node the hook writes its transform
      // to exists before the first pointer move: mounting it on drag start would
      // put the first frame of every drag at the top-left corner of the window.
      style={{ visibility: held ? "visible" : "hidden" }}
      aria-hidden="true"
    >
      {/* Centred under the finger rather than hanging off it, on the inner
          element so the outer one's transform stays purely the pointer
          position. */}
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
