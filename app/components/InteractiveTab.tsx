import type { ClimbAbility, DragInteraction } from "../lib/interactions";
import { DEFAULT_DRAG, MAX_DRAG_DISTANCE_TILES } from "../lib/interactions";
import type { TileDef, TilesetDef } from "../lib/types";
import { Input, Segmented, Switch } from "../ui";
import { TileIdMultiSelect } from "./TileIdMultiSelect";

type Props = {
  draft: TileDef;
  onChange: (next: TileDef) => void;
  tiles: TileDef[];
  tilesets: TilesetDef[];
};

/**
 * Ways the player can interact with this tile in play mode. One section per
 * interaction; drag is the first of them.
 */
export function InteractiveTab({ draft, onChange, tiles, tilesets }: Props) {
  const drag = draft.interactions?.drag;

  const setDrag = (next: DragInteraction | undefined) => {
    onChange({ ...draft, interactions: next ? { drag: next } : {} });
  };

  const patchDrag = (patch: Partial<DragInteraction>) => {
    if (!drag) return;
    setDrag({ ...drag, ...patch });
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <label className="flex items-center gap-2 text-sm font-bold">
          <Switch
            checked={Boolean(drag)}
            onCheckedChange={(on) => setDrag(on ? { ...DEFAULT_DRAG } : undefined)}
            ariaLabel="Draggable"
          />
          Drag
        </label>
        <p className="text-[11px] leading-snug text-muted">
          The player can grab this object from an adjacent tile on the same
          level and pull it to a new cell.
        </p>

        {drag ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-3">
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-bold uppercase text-muted">Distance</span>
              <Input
                type="number"
                min={1}
                max={MAX_DRAG_DISTANCE_TILES}
                step="any"
                value={drag.distanceTiles}
                className="w-24"
                onChange={(e) =>
                  patchDrag({
                    distanceTiles: clampDistance(Number(e.target.value)),
                  })
                }
              />
              <span className="text-[11px] leading-snug text-muted">
                Ground distance per drag. Orthogonal steps cost 1; diagonals
                cost √2 — use 1.5 to allow a single diagonal pull.
              </span>
            </label>

            <div className="flex flex-col gap-1 text-xs">
              <span className="font-bold uppercase text-muted">
                Climb height
              </span>
              <Segmented<ClimbAbility>
                value={drag.climb}
                onChange={(climb) => patchDrag({ climb })}
                options={[
                  { value: "none", label: "None" },
                  { value: "half", label: "Half" },
                  { value: "full", label: "Full" },
                ]}
                size="sm"
              />
              <span className="text-[11px] leading-snug text-muted">
                How far up it can be dragged. Going down is physics — turn on{" "}
                <strong>Affected by gravity</strong> on the Tile tab to let it
                be pushed off ledges.
              </span>
            </div>

            <TileIdMultiSelect
              tiles={tiles}
              tilesets={tilesets}
              selectedIds={drag.moveOnTileIds}
              onChange={(moveOnTileIds) => patchDrag({ moveOnTileIds })}
              label="Move on tiles"
              emptyHint="Any surface. Pick tiles to confine this object to them — it can only come to rest on top of one of the chosen tiles."
            />
          </div>
        ) : null}
      </section>
    </div>
  );
}

function clampDistance(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DRAG.distanceTiles;
  return Math.max(1, Math.min(MAX_DRAG_DISTANCE_TILES, value));
}
