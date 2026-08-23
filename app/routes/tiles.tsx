import { useState, useMemo } from "react";
import { Form, useFetcher, useLoaderData, useNavigation } from "react-router";
import type { Route } from "./+types/tiles";
import { AppShell } from "../components/AppShell";
import { TileEditorDialog, tileIsAnimated } from "../components/TileEditorDialog";
import { TilePreview } from "../components/TilePreview";
import { statusesById } from "../lib/status";
import { readPngSize } from "../lib/png";
import {
  fetchBootstrap,
  fetchTiles,
  fetchTilesets,
  saveTiles,
  saveTilesets,
  uploadTilesetBytes,
} from "../lib/api";
import type { TileDef, TilesetDef } from "../lib/types";
import { Button, Dialog, Input, useToast } from "../ui";

export async function clientLoader() {
  return await fetchBootstrap();
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "save-tile") {
    const raw = String(form.get("tile") ?? "");
    const tile = JSON.parse(raw) as TileDef;
    const tiles = await fetchTiles();
    const idx = tiles.findIndex((t) => t.id === tile.id);
    if (idx >= 0) tiles[idx] = tile;
    else tiles.push(tile);
    await saveTiles(tiles);
    return { ok: true, intent };
  }

  if (intent === "delete-tile") {
    const id = String(form.get("id") ?? "");
    const tiles = await fetchTiles();
    await saveTiles(tiles.filter((t) => t.id !== id));
    return { ok: true, intent };
  }

  if (intent === "upload-tileset") {
    const name = String(form.get("name") ?? "").trim();
    const file = form.get("file");
    if (!name) return { ok: false, error: "Name required" };
    if (!(file instanceof File)) return { ok: false, error: "File required" };
    const bytes = new Uint8Array(await file.arrayBuffer());
    let size: { width: number; height: number };
    try {
      size = readPngSize(bytes);
    } catch {
      return { ok: false, error: "Not a valid PNG" };
    }
    if (size.width % 8 !== 0 || size.height % 8 !== 0) {
      return {
        ok: false,
        error: `Dimensions must be multiples of 8 (got ${size.width}×${size.height})`,
      };
    }
    const id = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const fileName = `${id}.png`;
    await uploadTilesetBytes(fileName, bytes);
    const tilesets = await fetchTilesets();
    const def: TilesetDef = {
      id,
      name,
      file: fileName,
      width: size.width,
      height: size.height,
    };
    const idx = tilesets.findIndex((t) => t.id === id);
    if (idx >= 0) tilesets[idx] = def;
    else tilesets.push(def);
    await saveTilesets(tilesets);
    return { ok: true, intent };
  }

  return { ok: false, error: "Unknown intent" };
}

export default function TilesPage() {
  const { tiles, tilesets, statuses } = useLoaderData<typeof clientLoader>();
  // Compiled once per load, not per render: `statusesById` parses every formula
  // in the catalogue. Only the names and the ranges are read here, but there is
  // one function that decides what a status is and this is it.
  const statusDefs = useMemo(() => statusesById(statuses), [statuses]);
  const fetcher = useFetcher<typeof clientAction>();
  const toast = useToast();
  const [editing, setEditing] = useState<TileDef | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const navigation = useNavigation();

  const openNew = () => {
    setIsNew(true);
    setEditing(null);
  };

  const openEdit = (tile: TileDef) => {
    setIsNew(false);
    setEditing(tile);
  };

  const dialogOpen = isNew || editing !== null;

  return (
    <AppShell
      trailing={
        <>
          <Button size="sm" onClick={() => setUploadOpen(true)}>
            Upload tileset
          </Button>
          <Button size="sm" variant="primary" onClick={openNew}>
            New tile
          </Button>
        </>
      }
    >
      <div className="h-full overflow-auto p-4">
        {tiles.length === 0 ? (
          <div className="border-2 border-border bg-panel p-6 text-sm shadow-hard">
            No tiles yet. Generate placeholders with{" "}
            <code className="bg-paper px-1">pnpm generate</code> or create one.
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
            {tiles.map((tile) => (
              <button
                key={tile.id}
                type="button"
                onClick={() => openEdit(tile)}
                className="flex flex-col items-stretch gap-2 border-2 border-border bg-panel p-2 text-left shadow-hard hover:bg-paper"
              >
                <TilePreview tile={tile} tilesets={tilesets} size={64} />
                <div>
                  <div className="text-sm font-bold">{tile.name}</div>
                  <div className="text-xs text-muted">{tile.id}</div>
                </div>
                <div className="flex flex-wrap gap-1">
                  <span className="border border-border bg-paper px-1 text-[10px] font-bold">
                    h{tile.height}
                  </span>
                  <span className="border border-border bg-paper px-1 text-[10px]">
                    {tile.type}
                  </span>
                  {tileIsAnimated(tile) ? (
                    <span className="border border-border bg-paper px-1 text-[10px]">
                      anim
                    </span>
                  ) : null}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <TileEditorDialog
        open={dialogOpen}
        onOpenChange={(o) => {
          if (!o) {
            setEditing(null);
            setIsNew(false);
          }
        }}
        tile={editing}
        statusDefs={statusDefs}
        tiles={tiles}
        tilesets={tilesets}
        isNew={isNew}
        onSave={(tile) => {
          if (isNew && tiles.some((t) => t.id === tile.id)) {
            toast.show("Id already exists");
            return;
          }
          const fd = new FormData();
          fd.set("intent", "save-tile");
          fd.set("tile", JSON.stringify(tile));
          fetcher.submit(fd, { method: "post" });
          setEditing(null);
          setIsNew(false);
          toast.show("Tile saved");
        }}
        onDelete={
          editing
            ? () => {
                if (
                  !confirm(
                    "Delete this tile? Map references will show as missing (magenta).",
                  )
                ) {
                  return;
                }
                const fd = new FormData();
                fd.set("intent", "delete-tile");
                fd.set("id", editing.id);
                fetcher.submit(fd, { method: "post" });
                setEditing(null);
                toast.show("Tile deleted");
              }
            : undefined
        }
      />

      <Dialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        title="Upload tileset"
        footer={
          <>
            <Button variant="secondary" onClick={() => setUploadOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="upload-tileset-form"
              disabled={navigation.state !== "idle"}
            >
              Upload
            </Button>
          </>
        }
      >
        <Form
          id="upload-tileset-form"
          method="post"
          encType="multipart/form-data"
          className="flex flex-col gap-3"
          onSubmit={() => {
            setTimeout(() => setUploadOpen(false), 0);
          }}
        >
          <input type="hidden" name="intent" value="upload-tileset" />
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-bold uppercase text-muted">Name</span>
            <Input
              name="name"
              value={uploadName}
              onChange={(e) => setUploadName(e.target.value)}
              required
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-bold uppercase text-muted">PNG file</span>
            <input
              type="file"
              name="file"
              accept="image/png"
              required
              className="text-sm"
            />
          </label>
          <p className="text-xs text-muted">
            Width and height must be multiples of 8px.
          </p>
        </Form>
      </Dialog>
    </AppShell>
  );
}
