import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import * as v from "valibot";
import type { Route } from "./+types/npcs";
import { AdminShell } from "../../components/AppShell";
import { fetchTiles, fetchTilesets, saveTiles, saveTilesets, uploadTileset } from "../../lib/api";
import { requireAdmin } from "../../lib/auth";
import {
  DEFAULT_LOOK,
  SHEET_HEIGHT_PX,
  SHEET_WIDTH_PX,
  composeSheet,
  humanLookSchema,
  randomLook,
  wearsHumanSheet,
  type HumanLook,
  type LayerBlocks,
} from "../../lib/humanSprite";
import {
  HumanLookFields,
  SheetCanvas,
  WalkPreview,
  useLayerBlocks,
} from "../../components/HumanLookFields";
import { rgbaPngBlob, triggerDownload } from "../../lib/pngDownload";
import type { TileDef, TilesetDef } from "../../lib/types";
import { Button, Dialog, FieldLabel, Input, Select, useToast } from "../../ui";

const STORAGE_KEY = "stapes-npc-look";
const SHEET_ZOOM = 3;
const NO_TILE = "";

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

function sheetBlob(sheet: Uint8ClampedArray<ArrayBuffer>): Promise<Blob> {
  return rgbaPngBlob(sheet, SHEET_WIDTH_PX, SHEET_HEIGHT_PX);
}

export default function NpcsPage() {
  const { parts, error } = useLayerBlocks();
  const [look, setLook] = useState<HumanLook>(DEFAULT_LOOK);
  const [exportOpen, setExportOpen] = useState(false);

  useEffect(() => {
    const stored = loadStoredLook();
    if (stored) setLook(stored);
  }, []);

  const updateLook = (next: HumanLook) => {
    setLook(next);
    storeLook(next);
  };

  const sheet = useMemo(() => (parts ? composeSheet(parts, look) : null), [parts, look]);

  return (
    <AdminShell
      trailing={
        <>
          <Button size="sm" variant="ghost-inverse" onClick={() => updateLook(randomLook())}>
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
  parts: LayerBlocks;
  look: HumanLook;
  sheet: Uint8ClampedArray<ArrayBuffer>;
  onChange: (look: HumanLook) => void;
}) {
  return (
    <div className="grid h-full min-h-0 grid-cols-[320px_1fr]">
      <aside className="flex min-h-0 flex-col gap-4 overflow-auto border-r-2 border-border bg-panel p-3">
        <HumanLookFields parts={parts} look={look} onChange={onChange} />
      </aside>
      <main className="flex min-h-0 flex-col items-center gap-6 overflow-auto p-6">
        <WalkPreview sheet={sheet} />
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
