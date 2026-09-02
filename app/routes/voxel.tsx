import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { Route } from "./+types/voxel";
import { AppShell } from "../components/AppShell";
import { DirectionPreview } from "../components/voxel/DirectionPreview";
import { SliceEditor, type SliceTool } from "../components/voxel/SliceEditor";
import {
  fetchTiles,
  fetchTilesets,
  saveTiles,
  saveTilesets,
  uploadTileset,
} from "../lib/api";
import { readPngSize } from "../lib/png";
import { CELL_SIZE, DIRECTIONS } from "../lib/types";
import type { TileDef, TileHeight, TilesetDef } from "../lib/types";
import {
  DEFAULT_FRAME_DURATION_MS,
  emptyGrid,
  parseVoxelProject,
  renderGrid,
  renderSheet,
  resizeGrid,
  sheetSprites,
  sheetVariants,
  voxelDims,
  voxelIndex,
  type OutlineMode,
  type RenderOptions,
  type ShadeMode,
  type VoxelProject,
  type VoxelSize,
} from "../lib/voxel";
import { Button, Dialog, Input, Segmented, Select, Switch, useToast } from "../ui";

const STORAGE_KEY = "stapes-voxel-project";
const AUTOSAVE_DELAY_MS = 400;
const PREVIEW_ZOOM = 4;
const DEFAULT_PALETTE = [
  "#000000",
  "#5b3a29",
  "#8a5a3b",
  "#c8873e",
  "#3d5e3a",
  "#6d9b52",
  "#4a5568",
  "#9aa5b1",
  "#e8e0cf",
];

export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent !== "export-tileset") return { ok: false, error: "Unknown intent" };

  const name = String(form.get("name") ?? "").trim();
  const file = form.get("file");
  if (!name) return { ok: false, error: "Name required" };
  if (!(file instanceof File)) return { ok: false, error: "File required" };

  const bytes = new Uint8Array(await file.arrayBuffer());
  let size: { width: number; height: number };
  try {
    size = readPngSize(bytes);
  } catch {
    return { ok: false, error: "Sheet render produced an invalid PNG" };
  }

  const id = slugify(name);
  const fileName = `${id}.png`;
  await uploadTileset(new File([bytes], fileName, { type: "image/png" }), fileName);
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

  const tileRaw = String(form.get("tile") ?? "");
  if (tileRaw) {
    const tile = JSON.parse(tileRaw) as TileDef;
    const tiles = await fetchTiles();
    const tileIdx = tiles.findIndex((t) => t.id === tile.id);
    if (tileIdx >= 0) tiles[tileIdx] = tile;
    else tiles.push(tile);
    await saveTiles(tiles);
  }

  return { ok: true, intent, tilesetId: id };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function defaultProject(): VoxelProject {
  const size: VoxelSize = { cellsX: 1, cellsY: 1, levels: 1 };
  return {
    name: "new-sprite",
    size,
    palette: DEFAULT_PALETTE,
    frames: [
      {
        voxels: Array.from(emptyGrid(size)),
        durationMs: DEFAULT_FRAME_DURATION_MS,
      },
    ],
    directional: true,
  };
}

function loadStoredProject(): VoxelProject | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return parseVoxelProject(JSON.parse(raw));
  } catch {
    return null;
  }
}

export default function VoxelPage() {
  const [project, setProject] = useState<VoxelProject>(defaultProject);
  const [hydrated, setHydrated] = useState(false);
  const [frameIdx, setFrameIdx] = useState(0);
  const [sliceZ, setSliceZ] = useState(0);
  const [selectedColor, setSelectedColor] = useState(1);
  const [tool, setTool] = useState<SliceTool>("paint");
  const [shadeMode, setShadeMode] = useState<ShadeMode>("faces");
  const [outline, setOutline] = useState<OutlineMode>("full");
  const [exportOpen, setExportOpen] = useState(false);
  const toast = useToast();

  const render: RenderOptions = useMemo(
    () => ({ shadeMode, outline }),
    [shadeMode, outline],
  );

  useEffect(() => {
    const stored = loadStoredProject();
    if (stored) setProject(stored);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const timer = setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [project, hydrated]);

  const dims = voxelDims(project.size);
  // `voxelProjectSchema` holds `frames` at one or more, so a clamped index
  // always lands on a frame.
  const clampedFrameIdx = Math.min(frameIdx, project.frames.length - 1);
  const frame = project.frames[clampedFrameIdx]!;
  const clampedSliceZ = Math.min(sliceZ, dims.vz - 1);

  const paintWrites = (writes: { x: number; y: number; value: number }[]) => {
    if (writes.length === 0) return;
    setProject((p) => {
      const d = voxelDims(p.size);
      const frames = p.frames.slice();
      const voxels = frames[clampedFrameIdx]!.voxels.slice();
      for (const w of writes) {
        voxels[voxelIndex(d, w.x, w.y, clampedSliceZ)] = w.value;
      }
      frames[clampedFrameIdx] = { ...frames[clampedFrameIdx]!, voxels };
      return { ...p, frames };
    });
  };

  const changeSize = (next: VoxelSize) => {
    setProject((p) => ({
      ...p,
      size: next,
      frames: p.frames.map((f) => ({
        ...f,
        voxels: Array.from(
          resizeGrid(Uint8Array.from(f.voxels), p.size, next),
        ),
      })),
    }));
    setSliceZ((z) => Math.min(z, voxelDims(next).vz - 1));
  };

  const loadProjectFile = async (file: File) => {
    try {
      const parsed = parseVoxelProject(JSON.parse(await file.text()));
      setProject(parsed);
      setFrameIdx(0);
      setSliceZ(0);
      setSelectedColor(1);
      toast.show("Project loaded");
    } catch {
      toast.show("Not a valid voxel project file");
    }
  };

  const resetProject = () => {
    if (!confirm("Start a new project? The current voxels will be lost.")) {
      return;
    }
    setProject(defaultProject());
    setFrameIdx(0);
    setSliceZ(0);
    setSelectedColor(1);
    setTool("paint");
  };

  const downloadProject = () => {
    const blob = new Blob([JSON.stringify(project, null, 2)], {
      type: "application/json",
    });
    triggerDownload(blob, `${slugify(project.name) || "voxel"}.voxel.json`);
  };

  const downloadSheetPng = async () => {
    const blob = await sheetPngBlob(project, render);
    triggerDownload(blob, `${slugify(project.name) || "voxel"}.png`);
  };

  return (
    <AppShell
      trailing={
        <>
          <Button size="sm" variant="ghost-inverse" onClick={resetProject}>
            New project
          </Button>
          <Button size="sm" variant="ghost-inverse" onClick={downloadProject}>
            Save project
          </Button>
          <label className="cursor-pointer border-2 border-paper/40 px-2 py-1 text-xs font-medium text-paper hover:border-paper">
            Load project
            <input
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) loadProjectFile(file);
                e.target.value = "";
              }}
            />
          </label>
          <Button size="sm" variant="ghost-inverse" onClick={downloadSheetPng}>
            Download PNG
          </Button>
          <Button size="sm" variant="primary" onClick={() => setExportOpen(true)}>
            Export tileset
          </Button>
        </>
      }
    >
      <div className="grid h-full min-h-0 grid-cols-[240px_1fr_280px]">
        <aside className="flex min-h-0 flex-col gap-4 overflow-auto border-r-2 border-border bg-panel p-3">
          <ProjectControls project={project} onChange={setProject} onResize={changeSize} />
          <PalettePanel
            palette={project.palette}
            selected={selectedColor}
            onSelect={setSelectedColor}
            onChange={(palette) => setProject((p) => ({ ...p, palette }))}
          />
          <FramesPanel
            project={project}
            frameIdx={frameIdx}
            render={render}
            onSelect={setFrameIdx}
            onChange={setProject}
          />
        </aside>

        <main className="flex min-h-0 flex-col items-center gap-3 overflow-auto p-4">
          <div className="flex items-center gap-3">
            <Segmented
              size="sm"
              ariaLabel="Tool"
              value={tool}
              onChange={setTool}
              options={[
                { value: "paint", label: "Paint" },
                { value: "erase", label: "Erase" },
                { value: "fill", label: "Fill" },
                { value: "pick", label: "Pick" },
              ]}
            />
            <span className="text-xs text-muted">
              right-click erases · layer ghost shows the slice below
            </span>
          </div>
          <SliceEditor
            voxels={frame.voxels}
            size={project.size}
            sliceZ={clampedSliceZ}
            palette={project.palette}
            selectedColor={selectedColor}
            tool={tool}
            onPaint={paintWrites}
            onPick={(idx) => {
              if (idx > 0) setSelectedColor(idx);
            }}
          />
          <HeightSlider dims={dims} sliceZ={clampedSliceZ} onChange={setSliceZ} />
        </main>

        <aside className="flex min-h-0 flex-col gap-3 overflow-auto border-l-2 border-border bg-panel p-3">
          <div className="flex flex-col gap-2">
            <span className="text-xs font-bold uppercase text-muted">Preview</span>
            <label className="flex items-center justify-between gap-2 text-xs">
              Face shading
              <Switch
                checked={shadeMode === "faces"}
                onCheckedChange={(on) => setShadeMode(on ? "faces" : "flat")}
                ariaLabel="Toggle face shading"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-bold uppercase text-muted">Outline</span>
              <Segmented
                size="sm"
                ariaLabel="Outline mode"
                value={outline}
                onChange={setOutline}
                options={[
                  { value: "none", label: "None" },
                  { value: "silhouette", label: "Edge" },
                  { value: "full", label: "Edge+depth" },
                ]}
              />
            </label>
          </div>
          <div className="grid grid-cols-2 place-items-center gap-3">
            {(project.directional ? DIRECTIONS : (["s"] as const)).map((d) => (
              <DirectionPreview
                key={d}
                project={project}
                direction={d}
                render={render}
                zoom={PREVIEW_ZOOM}
                label={d}
              />
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs">
            Directional (4 rotations)
            <Switch
              checked={project.directional}
              onCheckedChange={(directional) =>
                setProject((p) => ({ ...p, directional }))
              }
              ariaLabel="Toggle directional export"
            />
          </label>
        </aside>
      </div>

      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        project={project}
        render={render}
      />
    </AppShell>
  );
}

function HeightSlider({
  dims,
  sliceZ,
  onChange,
}: {
  dims: ReturnType<typeof voxelDims>;
  sliceZ: number;
  onChange: (z: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-bold uppercase text-muted">Layer</span>
      <input
        type="range"
        min={0}
        max={dims.vz - 1}
        value={sliceZ}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-48"
      />
      <span className="w-12 text-xs tabular-nums">
        {sliceZ + 1}/{dims.vz}
      </span>
    </div>
  );
}

const SIZE_OPTIONS = [1, 2, 3, 4];
const LEVEL_OPTIONS = [1, 2, 3, 4];

function ProjectControls({
  project,
  onChange,
  onResize,
}: {
  project: VoxelProject;
  onChange: React.Dispatch<React.SetStateAction<VoxelProject>>;
  onResize: (size: VoxelSize) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-bold uppercase text-muted">Model</span>
      <Input
        value={project.name}
        onChange={(e) => onChange((p) => ({ ...p, name: e.target.value }))}
        aria-label="Sprite name"
      />
      <div className="grid grid-cols-3 gap-2 text-xs">
        <SizeSelect
          label="W cells"
          value={project.size.cellsX}
          options={SIZE_OPTIONS}
          onChange={(cellsX) => onResize({ ...project.size, cellsX })}
        />
        <SizeSelect
          label="D cells"
          value={project.size.cellsY}
          options={SIZE_OPTIONS}
          onChange={(cellsY) => onResize({ ...project.size, cellsY })}
        />
        <SizeSelect
          label="Levels"
          value={project.size.levels}
          options={LEVEL_OPTIONS}
          onChange={(levels) => onResize({ ...project.size, levels })}
        />
      </div>
      <p className="text-[10px] leading-snug text-muted">
        1 cell = {CELL_SIZE}px footprint · 1 level = {CELL_SIZE} voxels tall
      </p>
    </div>
  );
}

function SizeSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: number;
  options: number[];
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-bold uppercase text-muted">{label}</span>
      <Select
        value={String(value)}
        onValueChange={(v) => {
          if (v) onChange(Number(v));
        }}
        options={options.map((o) => ({ value: String(o), label: String(o) }))}
      />
    </label>
  );
}

function PalettePanel({
  palette,
  selected,
  onSelect,
  onChange,
}: {
  palette: string[];
  selected: number;
  onSelect: (idx: number) => void;
  onChange: (palette: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-bold uppercase text-muted">Palette</span>
      <div className="grid grid-cols-6 gap-1">
        {palette.map((color, idx) => {
          if (idx === 0) return null;
          return (
            <button
              key={`${idx}-${color}`}
              type="button"
              onClick={() => onSelect(idx)}
              aria-label={`Colour ${idx}: ${color}`}
              className={[
                "h-7 w-7 border-2",
                idx === selected
                  ? "border-accent outline outline-2 outline-accent"
                  : "border-border",
              ].join(" ")}
              style={{ backgroundColor: color }}
            />
          );
        })}
        <button
          type="button"
          onClick={() => {
            onChange([...palette, "#888888"]);
            onSelect(palette.length);
          }}
          aria-label="Add colour"
          className="h-7 w-7 border-2 border-dashed border-border text-xs font-bold text-muted hover:bg-paper"
        >
          +
        </button>
      </div>
      <label className="flex items-center gap-2 text-xs">
        Edit
        <input
          type="color"
          value={palette[selected] ?? "#888888"}
          onChange={(e) => {
            const next = palette.slice();
            next[selected] = e.target.value;
            onChange(next);
          }}
          aria-label="Edit selected colour"
          className="h-7 w-10 cursor-pointer border-2 border-border bg-paper"
        />
        <span className="tabular-nums text-muted">{palette[selected]}</span>
      </label>
    </div>
  );
}

function FramesPanel({
  project,
  frameIdx,
  render,
  onSelect,
  onChange,
}: {
  project: VoxelProject;
  frameIdx: number;
  render: RenderOptions;
  onSelect: (idx: number) => void;
  onChange: React.Dispatch<React.SetStateAction<VoxelProject>>;
}) {
  const clampedFrameIdx = Math.min(frameIdx, project.frames.length - 1);
  const frame = project.frames[clampedFrameIdx]!;

  const addFrame = (voxels: number[]) => {
    onChange((p) => ({
      ...p,
      frames: [
        ...p.frames,
        { voxels, durationMs: frame.durationMs },
      ],
    }));
    onSelect(project.frames.length);
  };

  const deleteFrame = () => {
    onChange((p) => ({
      ...p,
      frames: p.frames.filter((_, i) => i !== clampedFrameIdx),
    }));
    onSelect(Math.max(0, clampedFrameIdx - 1));
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-bold uppercase text-muted">
        Frames ({project.frames.length})
      </span>
      <div className="flex flex-wrap gap-1">
        {project.frames.map((f, idx) => (
          <FrameThumb
            key={`frame-${idx}-${project.frames.length}`}
            project={project}
            voxels={f.voxels}
            render={render}
            active={idx === frameIdx}
            onClick={() => onSelect(idx)}
          />
        ))}
      </div>
      <div className="flex gap-1">
        <Button
          size="sm"
          onClick={() => addFrame(Array.from(emptyGrid(project.size)))}
        >
          Blank
        </Button>
        <Button size="sm" onClick={() => addFrame(frame.voxels.slice())}>
          Duplicate
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={project.frames.length <= 1}
          onClick={deleteFrame}
        >
          Delete
        </Button>
      </div>
      <label className="flex items-center gap-2 text-xs">
        Duration
        <Input
          type="number"
          min={1}
          value={frame.durationMs}
          onChange={(e) => {
            const durationMs = Math.max(1, Number(e.target.value) || 1);
            onChange((p) => {
              const frames = p.frames.slice();
              frames[clampedFrameIdx] = {
                ...frames[clampedFrameIdx]!,
                durationMs,
              };
              return { ...p, frames };
            });
          }}
          className="w-20"
        />
        ms
      </label>
    </div>
  );
}

function FrameThumb({
  project,
  voxels,
  render,
  active,
  onClick,
}: {
  project: VoxelProject;
  voxels: number[];
  render: RenderOptions;
  active: boolean;
  onClick: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sprite = useMemo(
    () =>
      renderGrid(
        Uint8Array.from(voxels),
        project.size,
        project.palette,
        render,
      ),
    [voxels, project.size, project.palette, render],
  );

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(
      new ImageData(sprite.rgba, sprite.widthPx, sprite.heightPx),
      0,
      0,
    );
  }, [sprite]);

  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "border-2 p-0.5",
        active ? "border-accent" : "border-border hover:border-muted",
      ].join(" ")}
    >
      <canvas
        ref={canvasRef}
        width={sprite.widthPx}
        height={sprite.heightPx}
        className="h-10 w-10 object-contain [image-rendering:pixelated]"
      />
    </button>
  );
}

async function sheetPngBlob(
  project: VoxelProject,
  render: RenderOptions,
): Promise<Blob> {
  const { layout, rgba } = renderSheet(project, render);
  const canvas = document.createElement("canvas");
  canvas.width = layout.widthPx;
  canvas.height = layout.heightPx;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.putImageData(new ImageData(rgba, layout.widthPx, layout.heightPx), 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PNG encode failed"));
    }, "image/png");
  });
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

const TILE_HEIGHT_OPTIONS: { value: string; label: string }[] = [
  { value: "0", label: "0 — flat" },
  { value: "1", label: "1 — a seat, the tallest thing you can stand on indoors" },
  { value: "2", label: "2 — half level" },
  { value: "3", label: "3 — a body, as tall as the player" },
  { value: "4", label: "4 — full level" },
];

function ExportDialog({
  open,
  onOpenChange,
  project,
  render,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: VoxelProject;
  render: RenderOptions;
}) {
  const fetcher = useFetcher<typeof clientAction>();
  const toast = useToast();
  const [name, setName] = useState(project.name);
  const [createTile, setCreateTile] = useState(true);
  const [tileHeight, setTileHeight] = useState("4");
  const submittedRef = useRef(false);

  useEffect(() => {
    if (open) setName(project.name);
  }, [open, project.name]);

  useEffect(() => {
    if (!submittedRef.current || fetcher.state !== "idle" || !fetcher.data) {
      return;
    }
    submittedRef.current = false;
    if (fetcher.data.ok) {
      toast.show("Tileset exported");
      onOpenChange(false);
    } else {
      toast.show(fetcher.data.error ?? "Export failed");
    }
  }, [fetcher.state, fetcher.data, onOpenChange, toast]);

  const submit = async () => {
    const tilesetId = slugify(name);
    if (!tilesetId) {
      toast.show("Name required");
      return;
    }
    const blob = await sheetPngBlob(project, render);
    const fd = new FormData();
    fd.set("intent", "export-tileset");
    fd.set("name", name);
    fd.set("file", new File([blob], `${tilesetId}.png`, { type: "image/png" }));
    if (createTile) {
      fd.set("tile", JSON.stringify(buildTileDef(project, tilesetId, tileHeight)));
    }
    submittedRef.current = true;
    fetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
  };

  const copyVariants = async () => {
    const variants = sheetVariants(project, slugify(name) || "tileset-id");
    await navigator.clipboard.writeText(JSON.stringify(variants, null, 2));
    toast.show("Variants JSON copied");
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Export tileset"
      footer={
        <>
          <Button variant="secondary" onClick={copyVariants}>
            Copy variants JSON
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={fetcher.state !== "idle"}
          >
            Export
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-xs">
        <label className="flex flex-col gap-1">
          <span className="font-bold uppercase text-muted">Tileset name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex items-center gap-2">
          <Switch
            checked={createTile}
            onCheckedChange={setCreateTile}
            ariaLabel="Also create or update tile"
          />
          Also create/update tile <code>{slugify(name) || "…"}</code>
        </label>
        {createTile ? (
          <label className="flex flex-col gap-1">
            <span className="font-bold uppercase text-muted">Tile height</span>
            <Select
              value={tileHeight}
              onValueChange={(v) => {
                if (v) setTileHeight(v);
              }}
              options={TILE_HEIGHT_OPTIONS}
            />
          </label>
        ) : null}
        <p className="text-muted">
          Writes <code>{slugify(name) || "…"}.png</code> to the tilesets folder
          ({project.directional ? "4 direction rows" : "1 row"} ×{" "}
          {project.frames.length} frame{project.frames.length === 1 ? "" : "s"}).
        </p>
      </div>
    </Dialog>
  );
}

function buildTileDef(
  project: VoxelProject,
  tilesetId: string,
  tileHeight: string,
): TileDef {
  const sheet = sheetSprites(project, tilesetId);
  return {
    id: tilesetId,
    name: project.name,
    height: Number(tileHeight) as TileHeight,
    type: sheet.type,
    // The voxel editor makes art, not behaviour: whatever it exports is scenery
    // until somebody opens it in the tile editor and says otherwise.
    kind: "prop",
    attributes: {},
    sprite: sheet.sprite,
    sprites: sheet.sprites,
  };
}
