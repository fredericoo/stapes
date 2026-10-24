import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import * as v from "valibot";
import type { Route } from "./+types/npcs";
import { AdminShell } from "../../components/AppShell";
import {
  fetchTiles,
  fetchTilesets,
  saveTiles,
  saveTilesets,
  tilesetUrl,
  uploadTileset,
} from "../../lib/api";
import { requireAdmin } from "../../lib/auth";
import {
  DEFAULT_LOOK,
  FRAME_PX,
  HAIR_COLOURS,
  HAIR_COLOUR_NAMES,
  LAYERS,
  SHEET_FACINGS,
  SHEET_HEIGHT_PX,
  SHEET_WIDTH_PX,
  SKIN_TONES,
  SKIN_TONE_NAMES,
  composeSheet,
  humanLookSchema,
  randomLook,
  splitVariants,
  wearsHumanSheet,
  type HumanLook,
  type LayerId,
  type PartVariants,
  type Rgba,
} from "../../lib/humanSprite";
import { rgbaPngBlob, triggerDownload } from "../../lib/pngDownload";
import type { Direction, TileDef, TilesetDef } from "../../lib/types";
import { Button, Dialog, FieldLabel, Input, Select, useToast } from "../../ui";

const STORAGE_KEY = "stapes-npc-look";
const PREVIEW_ZOOM = 6;
const SHEET_ZOOM = 3;
const THUMB_ZOOM = 3;
const WALK_FRAME_MS = 200;
const STAND_COLUMN = 1;
const SOUTH_ROW = SHEET_FACINGS.indexOf("s");
const NO_TILE = "";

/** Columns of the sheet in the order a walk plays them: step, stand, the other step, stand. */
const WALK_CYCLE = [0, 1, 2, 1];

const FACING_LABEL: Record<Direction, string> = { n: "North", e: "East", s: "South", w: "West" };

export async function clientLoader() {
  await requireAdmin();
  return null;
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  const file = form.get("file");
  const tileId = String(form.get("tileId") ?? NO_TILE);
  const id = slugify(name);
  if (!id) return { ok: false, error: "Give the sheet a name." };
  if (!(file instanceof File)) return { ok: false, error: "The sheet did not render." };

  if (tileId !== NO_TILE) {
    const tiles = await fetchTiles();
    const tile = tiles.find((t) => t.id === tileId);
    if (!tile) return { ok: false, error: `No tile called ${tileId}.` };
    await writeTileset(id, name, file);
    tile.anchor = { tilesetId: id, x: 0, y: 0 };
    await saveTiles(tiles);
    return { ok: true, error: null };
  }

  await writeTileset(id, name, file);
  return { ok: true, error: null };
}

async function writeTileset(id: string, name: string, file: File) {
  const fileName = `${id}.png`;
  await uploadTileset(new File([file], fileName, { type: "image/png" }), fileName);
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
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function loadPartFile(file: string): Promise<Rgba[]> {
  const response = await fetch(tilesetUrl(file));
  if (!response.ok) throw new Error(`${file}: ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(bitmap, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return splitVariants({ data, width, height });
}

function useParts(): { parts: PartVariants | null; error: string | null } {
  const [parts, setParts] = useState<PartVariants | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Promise.all(LAYERS.map(async (layer) => [layer.id, await loadPartFile(layer.file)] as const))
      .then((entries) => setParts(Object.fromEntries(entries) as PartVariants))
      .catch((err: unknown) => setError(String(err)));
  }, []);
  return { parts, error };
}

function loadStoredLook(): HumanLook | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? v.parse(humanLookSchema, JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function storeLook(look: HumanLook) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(look));
  } catch {
    /** Private windows can refuse storage; the look just isn't remembered. */
  }
}

/** A stored look can name a variant that was since removed from its file. */
function fitLook(look: HumanLook, parts: PartVariants): HumanLook {
  const fit = (id: LayerId) => {
    const index = look.variants[id];
    return index !== null && index < parts[id].length ? index : null;
  };
  return {
    ...look,
    variants: {
      base: fit("base") ?? 0,
      shoes: fit("shoes"),
      clothes: fit("clothes"),
      head: fit("head") ?? 0,
      hat: fit("hat"),
    },
  };
}

function useWalkColumn(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => (t + 1) % WALK_CYCLE.length), WALK_FRAME_MS);
    return () => clearInterval(timer);
  }, []);
  return WALK_CYCLE[tick]!;
}

function sheetBlob(sheet: Uint8ClampedArray<ArrayBuffer>): Promise<Blob> {
  return rgbaPngBlob(sheet, SHEET_WIDTH_PX, SHEET_HEIGHT_PX);
}

export default function NpcsPage() {
  const { parts, error } = useParts();
  const [look, setLook] = useState<HumanLook>(DEFAULT_LOOK);
  const [exportOpen, setExportOpen] = useState(false);

  useEffect(() => {
    if (!parts) return;
    setLook(fitLook(loadStoredLook() ?? DEFAULT_LOOK, parts));
  }, [parts]);

  const updateLook = (next: HumanLook) => {
    setLook(next);
    storeLook(next);
  };

  const sheet = useMemo(() => (parts ? composeSheet(parts, look) : null), [parts, look]);

  return (
    <AdminShell
      trailing={
        <>
          <Button
            size="sm"
            variant="ghost-inverse"
            disabled={!parts}
            onClick={() => parts && updateLook(randomLook(parts))}
          >
            Randomise
          </Button>
          <Button
            size="sm"
            variant="ghost-inverse"
            disabled={!sheet}
            onClick={async () => sheet && triggerDownload(await sheetBlob(sheet), "npc.png")}
          >
            Download PNG
          </Button>
          <Button size="sm" variant="primary" disabled={!sheet} onClick={() => setExportOpen(true)}>
            Save as tileset
          </Button>
        </>
      }
    >
      {error ? <p className="p-4 text-sm">Couldn't load the parts: {error}</p> : null}
      {parts && sheet ? (
        <NpcEditor parts={parts} look={look} sheet={sheet} onChange={updateLook} />
      ) : null}
      {sheet ? <ExportDialog open={exportOpen} onOpenChange={setExportOpen} sheet={sheet} /> : null}
    </AdminShell>
  );
}

function NpcEditor({
  parts,
  look,
  sheet,
  onChange,
}: {
  parts: PartVariants;
  look: HumanLook;
  sheet: Uint8ClampedArray<ArrayBuffer>;
  onChange: (look: HumanLook) => void;
}) {
  const column = useWalkColumn();
  return (
    <div className="grid h-full min-h-0 grid-cols-[320px_1fr]">
      <aside className="flex min-h-0 flex-col gap-4 overflow-auto border-r-2 border-border bg-panel p-3">
        <SkinField value={look.skin} onChange={(skin) => onChange({ ...look, skin })} />
        <HairField value={look.hair} onChange={(hair) => onChange({ ...look, hair })} />
        {LAYERS.map((layer) => (
          <VariantField
            key={layer.id}
            layer={layer.id}
            parts={parts}
            look={look}
            onChange={(index) =>
              onChange({ ...look, variants: { ...look.variants, [layer.id]: index } })
            }
          />
        ))}
      </aside>
      <main className="flex min-h-0 flex-col items-center gap-6 overflow-auto p-6">
        <div className="flex gap-4">
          {SHEET_FACINGS.map((facing, row) => (
            <figure key={facing} className="flex flex-col items-center gap-1 text-xs text-muted">
              <SheetCanvas
                sheet={sheet}
                sx={column * FRAME_PX}
                sy={row * FRAME_PX}
                width={FRAME_PX}
                height={FRAME_PX}
                zoom={PREVIEW_ZOOM}
              />
              <figcaption>{FACING_LABEL[facing]}</figcaption>
            </figure>
          ))}
        </div>
        <SheetCanvas
          sheet={sheet}
          sx={0}
          sy={0}
          width={SHEET_WIDTH_PX}
          height={SHEET_HEIGHT_PX}
          zoom={SHEET_ZOOM}
        />
      </main>
    </div>
  );
}

function SheetCanvas({
  sheet,
  sx,
  sy,
  width,
  height,
  zoom,
}: {
  sheet: Uint8ClampedArray<ArrayBuffer>;
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
    ctx.putImageData(
      new ImageData(sheet, SHEET_WIDTH_PX, SHEET_HEIGHT_PX),
      -sx,
      -sy,
      sx,
      sy,
      width,
      height,
    );
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

function OptionButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={[
        "flex items-center justify-center border-2",
        pressed ? "border-accent outline outline-2 outline-accent" : "border-border",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function Swatches({ colours }: { colours: readonly string[] }) {
  return (
    <span className="flex h-6 w-full">
      {colours.map((hex) => (
        <span key={hex} className="h-full flex-1" style={{ backgroundColor: hex }} />
      ))}
    </span>
  );
}

function SkinField({
  value,
  onChange,
}: {
  value: string;
  onChange: (skin: HumanLook["skin"]) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1">
        <FieldLabel>Skin</FieldLabel>
      </legend>
      <div className="grid grid-cols-3 gap-1 text-xs">
        {SKIN_TONE_NAMES.map((tone) => (
          <div key={tone} className="flex flex-col items-stretch gap-1 capitalize">
            <OptionButton
              label={`Skin: ${tone}`}
              pressed={tone === value}
              onClick={() => onChange(tone)}
            >
              <Swatches colours={SKIN_TONES[tone]} />
            </OptionButton>
            {tone}
          </div>
        ))}
      </div>
    </fieldset>
  );
}

function HairField({
  value,
  onChange,
}: {
  value: string;
  onChange: (hair: HumanLook["hair"]) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 flex w-full justify-between">
        <FieldLabel>Hair</FieldLabel>
        <span className="text-xs capitalize text-muted">{value}</span>
      </legend>
      <div className="grid grid-cols-6 gap-1">
        {HAIR_COLOUR_NAMES.map((hair) => (
          <OptionButton
            key={hair}
            label={`Hair: ${hair}`}
            pressed={hair === value}
            onClick={() => onChange(hair)}
          >
            <Swatches colours={HAIR_COLOURS[hair]} />
          </OptionButton>
        ))}
      </div>
    </fieldset>
  );
}

/** Each option shows the whole look wearing that variant, facing south and standing. */
function VariantField({
  layer,
  parts,
  look,
  onChange,
}: {
  layer: LayerId;
  parts: PartVariants;
  look: HumanLook;
  onChange: (index: number | null) => void;
}) {
  const def = LAYERS.find((l) => l.id === layer)!;
  const options: (number | null)[] = parts[layer].map((_, i) => i);
  if (def.optional) options.unshift(null);
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1">
        <FieldLabel info={`Drawn from ${def.file}, one 48×64 block per variant.`}>
          {def.label}
        </FieldLabel>
      </legend>
      <div className="flex flex-wrap gap-1">
        {options.map((index) => (
          <VariantOption
            key={index ?? "none"}
            label={index === null ? `${def.label}: none` : `${def.label}: ${index + 1}`}
            pressed={look.variants[layer] === index}
            sheet={composeSheet(parts, { ...look, variants: { ...look.variants, [layer]: index } })}
            onClick={() => onChange(index)}
          />
        ))}
      </div>
      {parts[layer].length === 0 ? (
        <p className="text-xs text-muted">None drawn yet. Add a block to {def.file}.</p>
      ) : null}
    </fieldset>
  );
}

function VariantOption({
  label,
  pressed,
  sheet,
  onClick,
}: {
  label: string;
  pressed: boolean;
  sheet: Uint8ClampedArray<ArrayBuffer>;
  onClick: () => void;
}) {
  return (
    <OptionButton label={label} pressed={pressed} onClick={onClick}>
      <SheetCanvas
        sheet={sheet}
        sx={STAND_COLUMN * FRAME_PX}
        sy={SOUTH_ROW * FRAME_PX}
        width={FRAME_PX}
        height={FRAME_PX}
        zoom={THUMB_ZOOM}
      />
    </OptionButton>
  );
}

function ExportDialog({
  open,
  onOpenChange,
  sheet,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheet: Uint8ClampedArray<ArrayBuffer>;
}) {
  const fetcher = useFetcher<typeof clientAction>();
  const toast = useToast();
  const [name, setName] = useState("");
  const [tileId, setTileId] = useState(NO_TILE);
  const [wearers, setWearers] = useState<TileDef[]>([]);
  const submitted = useRef(false);

  useEffect(() => {
    if (!open) return;
    fetchTiles().then((tiles) => setWearers(tiles.filter(wearsHumanSheet)));
  }, [open]);

  useEffect(() => {
    if (!submitted.current || fetcher.state !== "idle" || !fetcher.data) return;
    submitted.current = false;
    if (!fetcher.data.ok) {
      toast.show(fetcher.data.error ?? "Couldn't save the tileset");
      return;
    }
    toast.show(tileId === NO_TILE ? "Tileset saved" : `Tileset saved and ${tileId} now wears it`);
    onOpenChange(false);
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
    fd.set("file", new File([await sheetBlob(sheet)], `${id}.png`, { type: "image/png" }));
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
          <FieldLabel>Tileset name</FieldLabel>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Baker" />
        </label>
        <label className="flex flex-col gap-1">
          <FieldLabel>Tile to wear it</FieldLabel>
          <Select
            value={tileId}
            onValueChange={(next) => setTileId(next ?? NO_TILE)}
            options={[
              { value: NO_TILE, label: "None" },
              ...wearers.map((t) => ({ value: t.id, label: t.name })),
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
