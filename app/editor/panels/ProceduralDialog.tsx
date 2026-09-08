import { useMemo, useState } from "react";
import { TilePreview } from "../../components/TilePreview";
import { E, W, blobMaskToSlice } from "../../lib/autotile";
import type { Direction, TileDef, TilesetDef } from "../../lib/types";
import {
  Button,
  Dialog,
  FieldLabel,
  Input,
  NumberInput,
  Segmented,
} from "../../ui";
import {
  ROOF_COLOURS,
  ROOF_COLOUR_IDS,
  WINDOW_SPACING_RANGE,
  type DoorColumn,
  type DoorRow,
  type HouseConfig,
  type RoofColour,
} from "../house";
import { STOREY_RANGE } from "../proceduralSettings";
import { useMapAssets } from "./MapAssetsContext";

/**
 * The generators the button offers. One so far, and the list is here rather
 * than inferred so adding a second one is a row plus a form.
 */
const GENERATORS = [{ id: "house", label: "House" }] as const;

/**
 * The walls a house may be built from.
 *
 * A short list rather than the whole catalogue, because a "wall" here is a
 * four-unit tile the autotiler runs along a ring — most of the library is not
 * that, and offering it would mean offering houses that cannot stand up.
 */
const WALL_TILE_IDS = ["sw2", "brick-wall", "half-wall"];
const WINDOW_TILE_IDS = ["window-1"];
const DOOR_TILE_IDS = ["door-closed"];

/**
 * A wall drawn as a length of wall rather than as a lone post.
 *
 * The autotiler's slice 0 is an isolated cell, which is what a thumbnail gets
 * by default — and every wall in the catalogue has a nearly identical one, so
 * three of them side by side are three of the same picture. A run with
 * neighbours either side is what these tiles are actually used as.
 */
const WALL_RUN_SLICE = blobMaskToSlice(E | W);

/** Rows and columns of the placement grid, in the order they are drawn. */
const DOOR_ROWS: DoorRow[] = ["north", "centre", "south"];
const DOOR_COLUMNS: DoorColumn[] = ["west", "centre", "east"];

const DOOR_SPOT_LABELS: Record<string, string> = {
  "north:west": "North wall, west end",
  "north:centre": "North wall, centred",
  "north:east": "North wall, east end",
  "centre:west": "West wall, centred",
  "centre:east": "East wall, centred",
  "south:west": "South wall, west end",
  "south:centre": "South wall, centred",
  "south:east": "South wall, east end",
};

function doorSpotKey(row: DoorRow, column: DoorColumn): string {
  return `${row}:${column}`;
}

/** A row of tile thumbnails behaving as one radio group. */
function TileChoiceRow({
  label,
  tileIds,
  value,
  onChange,
  tiles,
  tilesets,
  allowNone,
  direction,
  autotileSlice,
}: {
  label: string;
  tileIds: readonly string[];
  value: string | null;
  onChange: (id: string | null) => void;
  tiles: TileDef[];
  tilesets: TilesetDef[];
  allowNone?: boolean;
  direction?: Direction;
  autotileSlice?: number;
}) {
  return (
    <div
      className="flex flex-wrap items-stretch gap-1"
      role="radiogroup"
      aria-label={label}
    >
      {allowNone ? (
        <button
          type="button"
          role="radio"
          aria-checked={value === null}
          onClick={() => onChange(null)}
          className={[
            "flex w-16 flex-col items-center justify-center gap-1 border-2 p-1 text-[10px]",
            value === null
              ? "border-accent bg-paper"
              : "border-border bg-panel hover:bg-paper",
          ].join(" ")}
        >
          <span className="flex h-10 items-center text-muted">None</span>
          <span className="max-w-full truncate">None</span>
        </button>
      ) : null}
      {tileIds.map((id) => {
        const tile = tiles.find((t) => t.id === id) ?? null;
        if (!tile) return null;
        const active = value === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            title={tile.name}
            onClick={() => onChange(id)}
            className={[
              "flex w-16 flex-col items-center gap-1 border-2 p-1 text-[10px]",
              active
                ? "border-accent bg-paper"
                : "border-border bg-panel hover:bg-paper",
            ].join(" ")}
          >
            <TilePreview
              tile={tile}
              tilesets={tilesets}
              size={40}
              chrome={false}
              still
              direction={direction}
              autotileSlice={autotileSlice}
            />
            <span className="max-w-full truncate">{tile.name}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The roof colours, each shown as the two tiles it is: the eave that fills a
 * level and the cap that finishes the ridge. The names are ours — the tiles are
 * called `roof-1`…`roof-6` — so the swatch has to do the explaining.
 */
function RoofColourRow({
  value,
  onChange,
  tiles,
  tilesets,
}: {
  value: RoofColour | null;
  onChange: (colour: RoofColour | null) => void;
  tiles: TileDef[];
  tilesets: TilesetDef[];
}) {
  return (
    <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Roof colour">
      {/* No roof at all is a first-class answer here, not an omission: a
          curtain wall, a tower and a walled yard are all this generator with
          the roof left off. */}
      <button
        type="button"
        role="radio"
        aria-checked={value === null}
        title="No roof — the walls stop at the top storey"
        onClick={() => onChange(null)}
        className={[
          "flex w-16 flex-col items-center justify-center gap-1 border-2 p-1 text-[10px]",
          value === null
            ? "border-accent bg-paper"
            : "border-border bg-panel hover:bg-paper",
        ].join(" ")}
      >
        <span className="flex h-10 items-center text-muted">None</span>
        <span>None</span>
      </button>
      {ROOF_COLOUR_IDS.map((colour) => {
        const { label, eaveTileId, ridgeTileId } = ROOF_COLOURS[colour];
        const eave = tiles.find((t) => t.id === eaveTileId) ?? null;
        const ridge = tiles.find((t) => t.id === ridgeTileId) ?? null;
        const active = value === colour;
        return (
          <button
            key={colour}
            type="button"
            role="radio"
            aria-checked={active}
            title={`${label} — ${eaveTileId} and ${ridgeTileId}`}
            onClick={() => onChange(colour)}
            className={[
              "flex flex-col items-center gap-1 border-2 p-1 text-[10px]",
              active
                ? "border-accent bg-paper"
                : "border-border bg-panel hover:bg-paper",
            ].join(" ")}
          >
            <span className="flex items-end gap-0.5">
              <TilePreview
                tile={eave}
                tilesets={tilesets}
                size={40}
                chrome={false}
                still
                direction="w"
              />
              <TilePreview
                tile={ridge}
                tilesets={tilesets}
                size={24}
                chrome={false}
                still
                direction="s"
              />
            </span>
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Where the door goes, as the two coordinates it is: a row and a column of the
 * wall ring. The middle of the grid names no wall, so it is the one square that
 * cannot be picked.
 */
function DoorPlacementGrid({
  row,
  column,
  onChange,
  disabled,
}: {
  row: DoorRow;
  column: DoorColumn;
  onChange: (row: DoorRow, column: DoorColumn) => void;
  disabled: boolean;
}) {
  return (
    <div
      className="grid w-max grid-cols-3 gap-0.5"
      role="radiogroup"
      aria-label="Door placement"
    >
      {DOOR_ROWS.map((r) =>
        DOOR_COLUMNS.map((c) => {
          const key = doorSpotKey(r, c);
          const label = DOOR_SPOT_LABELS[key];
          const active = !disabled && r === row && c === column;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={label ?? "No wall"}
              title={label ?? "No wall here"}
              disabled={disabled || !label}
              onClick={() => onChange(r, c)}
              className={[
                "size-8 border-2",
                !label ? "border-dashed border-border/50 bg-transparent" : "",
                label && active ? "border-accent bg-ink" : "",
                label && !active ? "border-border bg-panel hover:bg-paper" : "",
                "disabled:cursor-not-allowed disabled:opacity-40",
              ].join(" ")}
            />
          );
        }),
      )}
    </div>
  );
}

/** A searchable thumbnail grid over the whole catalogue. */
function FloorTilePicker({
  value,
  onChange,
  tiles,
  tilesets,
}: {
  value: string;
  onChange: (id: string) => void;
  tiles: TileDef[];
  tilesets: TilesetDef[];
}) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tiles;
    return tiles.filter(
      (t) => t.name.toLowerCase().includes(q) || t.id.includes(q),
    );
  }, [tiles, search]);

  return (
    <div className="flex flex-col gap-1">
      <Input
        placeholder="Search tiles…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full"
      />
      <div
        className="grid max-h-40 grid-cols-[repeat(auto-fill,minmax(56px,1fr))] content-start gap-1 overflow-auto border-2 border-border bg-panel p-1"
        role="radiogroup"
        aria-label="Floor tile"
      >
        {filtered.map((tile) => {
          const active = tile.id === value;
          return (
            <button
              key={tile.id}
              type="button"
              role="radio"
              aria-checked={active}
              title={tile.name}
              onClick={() => onChange(tile.id)}
              className={[
                "flex flex-col items-center gap-0.5 border-2 p-0.5",
                active
                  ? "border-accent bg-paper"
                  : "border-transparent hover:border-border hover:bg-paper",
              ].join(" ")}
            >
              <TilePreview
                tile={tile}
                tilesets={tilesets}
                size={32}
                chrome={false}
                still
              />
              <span className="max-w-full truncate text-[9px]">
                {tile.name}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The procedural generators, and the settings the next placement will use.
 *
 * The form edits a draft rather than the store: closing it with the X leaves
 * the tool exactly as it was, and only Place commits — which is also what
 * writes the settings to `localStorage`, so what comes back on the next visit
 * is the last house actually built rather than the last field touched.
 */
export function ProceduralDialog({
  open,
  onOpenChange,
  config,
  onPlace,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: HouseConfig;
  onPlace: (config: HouseConfig) => void;
}) {
  const { tiles, tilesets } = useMapAssets();
  const [generator, setGenerator] = useState<string>(GENERATORS[0].id);
  const [draft, setDraft] = useState<HouseConfig>(config);

  // The dialog is mounted for the life of the page, so the draft is seeded
  // from the standing settings each time it is opened rather than on mount.
  const [seededFor, setSeededFor] = useState(open);
  if (open !== seededFor) {
    setSeededFor(open);
    if (open) setDraft(config);
  }

  const patch = (next: Partial<HouseConfig>) =>
    setDraft((prev) => ({ ...prev, ...next }));

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Procedural"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onPlace(draft)}>
            Place
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col items-start gap-1">
          <FieldLabel>Generator</FieldLabel>
          <Segmented
            ariaLabel="Generator"
            value={generator}
            onChange={setGenerator}
            options={GENERATORS.map((g) => ({ value: g.id, label: g.label }))}
          />
        </div>

        <div className="flex flex-wrap gap-4">
          <div className="flex flex-col gap-1">
            <FieldLabel info="Storeys of wall. The roof starts on the level above the top one.">
              Height
            </FieldLabel>
            <NumberInput
              className="w-20"
              aria-label="Storeys"
              value={draft.storeys}
              min={STOREY_RANGE.min}
              max={STOREY_RANGE.max}
              step={1}
              onChange={(storeys) => patch({ storeys })}
            />
          </div>

          <div
            className={[
              "flex flex-col items-start gap-1",
              // A ridge with no roof on it has nothing to say, so the control
              // greys rather than vanishing: the field keeps its place, and
              // turning a roof back on does not move everything under it.
              draft.roofColour ? "" : "pointer-events-none opacity-50",
            ].join(" ")}
            aria-hidden={draft.roofColour ? undefined : true}
          >
            <FieldLabel info="Which way the ridge runs. Auto runs it along the building's longer side, which is where a gable's ridge goes. Vertical gables face north and south; horizontal ones face east and west.">
              Roof orientation
            </FieldLabel>
            <Segmented
              ariaLabel="Roof orientation"
              value={draft.roofOrientation}
              onChange={(roofOrientation) => patch({ roofOrientation })}
              options={[
                { value: "auto", label: "Auto" },
                { value: "vertical", label: "Vertical" },
                { value: "horizontal", label: "Horizontal" },
              ]}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <FieldLabel info="None leaves the walls open at the top — a curtain wall, a tower, a walled yard.">
            Roof
          </FieldLabel>
          <RoofColourRow
            value={draft.roofColour}
            onChange={(roofColour) => patch({ roofColour })}
            tiles={tiles}
            tilesets={tilesets}
          />
        </div>

        <div className="flex flex-col gap-1">
          <FieldLabel>Wall</FieldLabel>
          <TileChoiceRow
            label="Wall tile"
            tileIds={WALL_TILE_IDS}
            value={draft.wallTileId}
            onChange={(id) => patch({ wallTileId: id ?? draft.wallTileId })}
            tiles={tiles}
            tilesets={tilesets}
            autotileSlice={WALL_RUN_SLICE}
          />
        </div>

        <div className="flex flex-col gap-1">
          <FieldLabel info="Laid across the whole footprint, on top of whatever is already there.">
            Floor
          </FieldLabel>
          <FloorTilePicker
            value={draft.floorTileId}
            onChange={(floorTileId) => patch({ floorTileId })}
            tiles={tiles}
            tilesets={tilesets}
          />
        </div>

        <div className="flex flex-col gap-1">
          <FieldLabel info="Set into every storey's walls, clear of the corners and of the door. None leaves the walls blank.">
            Windows
          </FieldLabel>
          <div className="flex flex-wrap items-end gap-3">
            <TileChoiceRow
              label="Window tile"
              tileIds={WINDOW_TILE_IDS}
              value={draft.windowTileId}
              onChange={(windowTileId) => patch({ windowTileId })}
              tiles={tiles}
              tilesets={tilesets}
              allowNone
              direction="s"
            />
            <div className="flex flex-col items-start gap-1">
              <FieldLabel info="Cells from one window to the next along a wall. Bigger is further apart; a wall too short for two gets one.">
                Spacing
              </FieldLabel>
              <NumberInput
                className="w-20"
                aria-label="Window spacing"
                value={draft.windowSpacing}
                min={WINDOW_SPACING_RANGE.min}
                max={WINDOW_SPACING_RANGE.max}
                step={1}
                disabled={draft.windowTileId === null}
                onChange={(windowSpacing) => patch({ windowSpacing })}
              />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <FieldLabel info="Ground floor only, and never within two cells of a corner — a house too small for that gets none.">
            Door
          </FieldLabel>
          <TileChoiceRow
            label="Door tile"
            tileIds={DOOR_TILE_IDS}
            value={draft.doorTileId}
            onChange={(doorTileId) => patch({ doorTileId })}
            tiles={tiles}
            tilesets={tilesets}
            allowNone
          />
        </div>

        <div className="flex flex-col gap-1">
          <FieldLabel>Door placement</FieldLabel>
          <DoorPlacementGrid
            row={draft.doorRow}
            column={draft.doorColumn}
            disabled={draft.doorTileId === null}
            onChange={(doorRow, doorColumn) => patch({ doorRow, doorColumn })}
          />
        </div>

        <p className="text-xs text-muted">
          Drag a rectangle on the map to place it. The site has to be level and
          nothing may stand above it.
        </p>
      </div>
    </Dialog>
  );
}
