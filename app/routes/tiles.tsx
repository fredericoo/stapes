import { useEffect, useMemo, useRef, useState } from "react";
import { Form, useFetcher, useLoaderData, useNavigation } from "react-router";
import type { Route } from "./+types/tiles";
import { AppShell } from "../components/AppShell";
import {
  TileEditorDialog,
  tileIsAnimated,
} from "../components/TileEditorDialog";
import { TilePreview } from "../components/TilePreview";
import { statusesById } from "../lib/status";
import { isTypingTarget } from "../game/heldDirections";
import {
  filterTiles,
  TILE_FILTER_KINDS,
  type TileFilterKind,
} from "../lib/tileFilter";
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
import { Button, Dialog, Input, Segmented, useToast } from "../ui";

/** Reaches for the search field from anywhere on the page. */
const SEARCH_KEY = "/";

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
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TileFilterKind>("all");
  const searchRef = useRef<HTMLInputElement>(null);

  const openNew = () => {
    setIsNew(true);
    setEditing(null);
  };

  const openEdit = (tile: TileDef) => {
    setIsNew(false);
    setEditing(tile);
  };

  const dialogOpen = isNew || editing !== null;

  const visible = useMemo(
    () => filterTiles(tiles, query, filter),
    [tiles, query, filter],
  );

  /**
   * Slash reaches for the search field.
   *
   * Gated on {@link isTypingTarget} so the character still reaches any field
   * that already has focus — including this one, where slash is just a slash —
   * and on the dialogs, whose focus trap would fight a field behind them for
   * the caret and win, leaving the keystroke swallowed and nothing focused.
   */
  useEffect(() => {
    if (dialogOpen || uploadOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== SEARCH_KEY || event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dialogOpen, uploadOpen]);

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
      <div className="flex h-full flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b-2 border-border bg-panel px-4 py-2">
          <div className="relative w-56 max-w-full">
            <Input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                // Escape empties a field with something in it and lets go of an
                // empty one, so the same key always means "back out of this" and
                // never strands the caret in a box it just cleared.
                if (query) setQuery("");
                else e.currentTarget.blur();
              }}
              placeholder="Search tiles"
              aria-label="Search tiles"
              autoComplete="off"
              className="w-full pr-7"
            />
            {/*
              Only while the field is empty, which is what keeps it out of the
              way of the native clear button `type="search"` puts in this exact
              spot the moment there is something to clear. The two never show at
              once, so one corner does both jobs.

              Hidden below the breakpoint as well: a phone has no key to press,
              and the hint would be the one thing in the bar earning none of its
              room.
            */}
            {query === "" ? (
              <kbd
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 border border-border bg-paper px-1 text-[10px] leading-tight text-muted md:block"
              >
                {SEARCH_KEY}
              </kbd>
            ) : null}
          </div>
          <Segmented
            value={filter}
            options={TILE_FILTER_KINDS}
            onChange={setFilter}
            size="sm"
            ariaLabel="Filter tiles"
          />
          <span role="status" className="text-xs text-muted">
            {visible.length === tiles.length
              ? `${tiles.length} tiles`
              : `${visible.length} of ${tiles.length} tiles`}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {tiles.length === 0 ? (
            <div className="border-2 border-border bg-panel p-6 text-sm shadow-hard">
              No tiles yet. Generate placeholders with{" "}
              <code className="bg-paper px-1">pnpm generate</code> or create
              one.
            </div>
          ) : visible.length === 0 ? (
            <div className="flex flex-col items-start gap-3 border-2 border-border bg-panel p-6 text-sm shadow-hard">
              <span>Nothing here matches.</span>
              <Button
                size="sm"
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                  searchRef.current?.focus();
                }}
              >
                Clear search and filter
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
              {visible.map((tile) => (
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
      </div>

      <TileEditorDialog
        // One mount per edit, rather than an effect resetting seven pieces of
        // state when `open` goes true. Both ways of closing clear `editing` and
        // `isNew`, so the key always passes through "closed" and every open is a
        // fresh mount — which is what makes each field's initial value the
        // initial value again, including for the same tile opened twice.
        key={dialogOpen ? (isNew ? "new" : (editing?.id ?? "")) : "closed"}
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
