import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import * as v from "valibot";
import type { Route } from "./+types/townsfolk";
import { AdminShell } from "../../components/AppShell";
import { fetchTiles, fetchTilesets, saveTiles, saveTilesets, uploadTileset } from "../../lib/api";
import { requireAdmin } from "../../lib/auth";
import {
  CLOAK_STYLES,
  DEFAULT_LOOK,
  FRAME_PX,
  HAIR_STYLES,
  LOWER_STYLES,
  SHEET_FACINGS,
  SHEET_HEIGHT_PX,
  SHEET_WIDTH_PX,
  figureLookSchema,
  rampFor,
  renderFigureSheet,
  type FigureLook,
} from "../../lib/figure";
import { STAPES_PALETTE } from "../../lib/palette";
import { rgbaPngBlob, triggerDownload } from "../../lib/pngDownload";
import { CELL_SIZE } from "../../lib/types";
import type { Direction, TileDef, TilesetDef } from "../../lib/types";
import { Button, Dialog, Input, Select, Switch, useToast } from "../../ui";

const STORAGE_KEY = "stapes-townsfolk-look";
const PREVIEW_ZOOM = 6;
const SHEET_ZOOM = 3;
const WALK_FRAME_MS = 200;

/** Columns of the sheet in the order a walk plays them: step, stand, the other step, stand. */
const WALK_CYCLE = [0, 1, 2, 1];

const FACING_LABEL: Record<Direction, string> = { n: "North", e: "East", s: "South", w: "West" };
const NO_TILE = "";

/** The first palette entry is the outline colour, and a part drawn in it would vanish into its outline. */
const SWATCHES = STAPES_PALETTE.slice(1);

export async function clientLoader() {
  await requireAdmin();
  return null;
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  const file = form.get("file");
  const tileId = String(form.get("tileId") ?? "");
  const id = slugify(name);
  if (!id) return { ok: false, error: "Give the sheet a name." };
  if (!(file instanceof File)) return { ok: false, error: "The sheet did not render." };

  const fileName = `${id}.png`;
  await uploadTileset(
    new File([await file.arrayBuffer()], fileName, { type: "image/png" }),
    fileName,
  );
  const tilesets = await fetchTilesets();
  const def: TilesetDef = {
    id,
    name,
    file: fileName,
    width: SHEET_WIDTH_PX,
    height: SHEET_HEIGHT_PX,
  };
  const at = tilesets.findIndex((t) => t.id === id);
  if (at >= 0) tilesets[at] = def;
  else tilesets.push(def);
  await saveTilesets(tilesets);

  if (tileId !== NO_TILE) {
    const tiles = await fetchTiles();
    const tile = tiles.find((t) => t.id === tileId);
    if (!tile) return { ok: false, error: `No tile called ${tileId}.` };
    tile.anchor = { tilesetId: id, x: 0, y: 0 };
    await saveTiles(tiles);
  }

  return { ok: true, error: null, tilesetId: id };
}

/**
 * Whether a tile's walk is drawn from a block laid out like this sheet, so
 * moving its anchor onto the sheet draws a whole character and not pieces of
 * one. A deer or a wolf walks too, from a block of another shape.
 */
function drawsFromCharacterBlock(tile: TileDef): boolean {
  const walk = tile.states?.moving?.sprites;
  if (!walk || !tile.sprites) return false;
  return [tile.sprites, walk].every((sprites) =>
    SHEET_FACINGS.every((facing) =>
      sprites[facing]?.frames.every(({ sprite: { rect, base } }) => {
        const inBlock =
          rect.x >= 0 &&
          rect.y >= 0 &&
          rect.x + rect.w <= SHEET_WIDTH_PX / CELL_SIZE &&
          rect.y + rect.h <= SHEET_HEIGHT_PX / CELL_SIZE;
        return (
          inBlock &&
          rect.w * CELL_SIZE === FRAME_PX &&
          rect.h * CELL_SIZE === FRAME_PX &&
          base.x === 1 &&
          base.y === 1
        );
      }),
    ),
  );
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function loadStoredLook(): FigureLook | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? v.parse(figureLookSchema, JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

function randomLook(): FigureLook {
  return {
    skin: pick(["#e6904e", "#cd683d", "#9e4539", "#fbb954", "#694f62"]),
    hair: { style: pick(HAIR_STYLES), colour: pick(SWATCHES) },
    beard: Math.random() < 0.25,
    shirt: pick(SWATCHES),
    lower: { style: Math.random() < 0.3 ? "robe" : "trousers", colour: pick(SWATCHES) },
    shoes: pick(SWATCHES),
    cloak: { style: Math.random() < 0.5 ? "none" : pick(CLOAK_STYLES), colour: pick(SWATCHES) },
  };
}

function useSheetCanvas(look: FigureLook): HTMLCanvasElement | null {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const next = document.createElement("canvas");
    next.width = SHEET_WIDTH_PX;
    next.height = SHEET_HEIGHT_PX;
    next
      .getContext("2d")
      ?.putImageData(new ImageData(renderFigureSheet(look), SHEET_WIDTH_PX, SHEET_HEIGHT_PX), 0, 0);
    setCanvas(next);
  }, [look]);
  return canvas;
}

function useWalkFrame(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => (t + 1) % WALK_CYCLE.length), WALK_FRAME_MS);
    return () => clearInterval(timer);
  }, []);
  return WALK_CYCLE[tick]!;
}

export default function TownsfolkPage() {
  const [look, setLook] = useState<FigureLook>(DEFAULT_LOOK);
  const [hydrated, setHydrated] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const sheet = useSheetCanvas(look);
  const column = useWalkFrame();

  useEffect(() => {
    const stored = loadStoredLook();
    if (stored) setLook(stored);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) localStorage.setItem(STORAGE_KEY, JSON.stringify(look));
  }, [look, hydrated]);

  const downloadPng = async () => {
    triggerDownload(await sheetBlob(look), "townsfolk.png");
  };

  return (
    <AdminShell
      trailing={
        <>
          <Button size="sm" variant="ghost-inverse" onClick={() => setLook(randomLook())}>
            Randomise
          </Button>
          <Button size="sm" variant="ghost-inverse" onClick={downloadPng}>
            Download PNG
          </Button>
          <Button size="sm" variant="primary" onClick={() => setExportOpen(true)}>
            Save as tileset
          </Button>
        </>
      }
    >
      <div className="grid h-full min-h-0 grid-cols-[320px_1fr]">
        <aside className="flex min-h-0 flex-col gap-4 overflow-auto border-r-2 border-border bg-panel p-3">
          <StyleField
            label="Hair"
            value={look.hair.style}
            options={HAIR_STYLES}
            onChange={(style) => setLook((l) => ({ ...l, hair: { ...l.hair, style } }))}
          />
          <ColourField
            label="Hair colour"
            value={look.hair.colour}
            onChange={(colour) => setLook((l) => ({ ...l, hair: { ...l.hair, colour } }))}
          />
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={look.beard}
              onCheckedChange={(beard) => setLook((l) => ({ ...l, beard }))}
              ariaLabel="Beard"
            />
            Beard, in the hair colour
          </label>
          <ColourField
            label="Skin"
            value={look.skin}
            onChange={(skin) => setLook((l) => ({ ...l, skin }))}
          />
          <ColourField
            label="Shirt"
            value={look.shirt}
            onChange={(shirt) => setLook((l) => ({ ...l, shirt }))}
          />
          <StyleField
            label="Legs"
            value={look.lower.style}
            options={LOWER_STYLES}
            onChange={(style) => setLook((l) => ({ ...l, lower: { ...l.lower, style } }))}
          />
          <ColourField
            label={look.lower.style === "robe" ? "Robe colour" : "Trousers colour"}
            value={look.lower.colour}
            onChange={(colour) => setLook((l) => ({ ...l, lower: { ...l.lower, colour } }))}
          />
          <ColourField
            label="Shoes"
            value={look.shoes}
            onChange={(shoes) => setLook((l) => ({ ...l, shoes }))}
          />
          <StyleField
            label="Cloak"
            value={look.cloak.style}
            options={CLOAK_STYLES}
            onChange={(style) => setLook((l) => ({ ...l, cloak: { ...l.cloak, style } }))}
          />
          {look.cloak.style === "none" ? null : (
            <ColourField
              label="Cloak colour"
              value={look.cloak.colour}
              onChange={(colour) => setLook((l) => ({ ...l, cloak: { ...l.cloak, colour } }))}
            />
          )}
        </aside>

        <main className="flex min-h-0 flex-col items-center gap-6 overflow-auto p-6">
          <div className="flex flex-wrap justify-center gap-4">
            {SHEET_FACINGS.map((facing, row) => (
              <figure key={facing} className="flex flex-col items-center gap-1">
                <SheetView
                  sheet={sheet}
                  sx={column * FRAME_PX}
                  sy={row * FRAME_PX}
                  width={FRAME_PX}
                  height={FRAME_PX}
                  zoom={PREVIEW_ZOOM}
                />
                <figcaption className="text-xs text-muted">{FACING_LABEL[facing]}</figcaption>
              </figure>
            ))}
          </div>
          <figure className="flex flex-col items-center gap-1">
            <SheetView
              sheet={sheet}
              sx={0}
              sy={0}
              width={SHEET_WIDTH_PX}
              height={SHEET_HEIGHT_PX}
              zoom={SHEET_ZOOM}
            />
            <figcaption className="max-w-sm text-center text-xs text-muted">
              The sheet, laid out like the player in <code>people.png</code>: rows face south, east,
              west and north; columns are a step, standing, and the other step. A tile drawn from
              the player's frames draws this sheet from its anchor unchanged.
            </figcaption>
          </figure>
        </main>
      </div>

      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} look={look} />
    </AdminShell>
  );
}

function sheetBlob(look: FigureLook): Promise<Blob> {
  return rgbaPngBlob(renderFigureSheet(look), SHEET_WIDTH_PX, SHEET_HEIGHT_PX);
}

function SheetView({
  sheet,
  sx,
  sy,
  width,
  height,
  zoom,
}: {
  sheet: HTMLCanvasElement | null;
  sx: number;
  sy: number;
  width: number;
  height: number;
  zoom: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    if (sheet) ctx.drawImage(sheet, sx, sy, width, height, 0, 0, width, height);
  }, [sheet, sx, sy, width, height]);
  return (
    <canvas
      ref={ref}
      width={width}
      height={height}
      style={{ width: width * zoom, height: height * zoom }}
      className="border-2 border-border bg-[#239063] [image-rendering:pixelated]"
    />
  );
}

function StyleField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="font-bold uppercase text-muted">{label}</span>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next) onChange(next as T);
        }}
        options={options.map((o) => ({ value: o, label: o[0]!.toUpperCase() + o.slice(1) }))}
      />
    </label>
  );
}

function ColourField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  const ramp = useMemo(() => rampFor(value), [value]);
  return (
    <fieldset className="flex flex-col gap-1 text-xs">
      <legend className="mb-1 flex w-full items-center justify-between font-bold uppercase text-muted">
        {label}
        <span className="flex" title="Shadow, base and highlight as drawn">
          {ramp.map((hex, i) => (
            <span key={i} className="h-3 w-3" style={{ backgroundColor: hex }} />
          ))}
        </span>
      </legend>
      <div className="grid grid-cols-8 gap-1">
        {SWATCHES.map((hex) => (
          <button
            key={hex}
            type="button"
            onClick={() => onChange(hex)}
            aria-label={`${label}: ${hex}`}
            aria-pressed={hex === value}
            className={[
              "h-6 w-full border-2",
              hex === value ? "border-accent outline outline-2 outline-accent" : "border-border",
            ].join(" ")}
            style={{ backgroundColor: hex }}
          />
        ))}
      </div>
    </fieldset>
  );
}

function ExportDialog({
  open,
  onOpenChange,
  look,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  look: FigureLook;
}) {
  const fetcher = useFetcher<typeof clientAction>();
  const toast = useToast();
  const [name, setName] = useState("");
  const [tileId, setTileId] = useState(NO_TILE);
  const [walkers, setWalkers] = useState<TileDef[]>([]);
  const submitted = useRef(false);

  useEffect(() => {
    if (!open) return;
    fetchTiles().then((tiles) => setWalkers(tiles.filter(drawsFromCharacterBlock)));
  }, [open]);

  useEffect(() => {
    if (!submitted.current || fetcher.state !== "idle" || !fetcher.data) return;
    submitted.current = false;
    if (fetcher.data.ok) {
      toast.show(tileId === NO_TILE ? "Tileset saved" : `Tileset saved and ${tileId} now wears it`);
      onOpenChange(false);
    } else {
      toast.show(fetcher.data.error ?? "Couldn't save the tileset");
    }
  }, [fetcher.state, fetcher.data, onOpenChange, toast, tileId]);

  const submit = async () => {
    const id = slugify(name);
    if (!id) {
      toast.show("Give the sheet a name.");
      return;
    }
    const fd = new FormData();
    fd.set("name", name);
    fd.set("tileId", tileId);
    fd.set("file", new File([await sheetBlob(look)], `${id}.png`, { type: "image/png" }));
    submitted.current = true;
    fetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Save as tileset"
      footer={
        <Button variant="primary" onClick={submit} disabled={fetcher.state !== "idle"}>
          Save
        </Button>
      }
    >
      <div className="flex flex-col gap-3 text-xs">
        <label className="flex flex-col gap-1">
          <span className="font-bold uppercase text-muted">Tileset name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Baker" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-bold uppercase text-muted">Tile to wear it</span>
          <Select
            value={tileId}
            onValueChange={(next) => setTileId(next ?? NO_TILE)}
            options={[
              { value: NO_TILE, label: "None" },
              ...walkers.map((t) => ({ value: t.id, label: t.name })),
            ]}
          />
        </label>
        <p className="text-muted">
          Writes <code>{slugify(name) || "…"}.png</code> to the tilesets. A tile picked here has its
          anchor moved to the new sheet and keeps everything else.
        </p>
      </div>
    </Dialog>
  );
}
