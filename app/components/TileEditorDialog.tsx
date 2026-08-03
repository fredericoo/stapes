import { useEffect, useState } from "react";
import type {
  Direction,
  Frame,
  LightDef,
  SpriteRef,
  TileDef,
  TileHeight,
  TilesetDef,
  VariantKey,
} from "../lib/types";
import {
  DIRECTIONS,
  defaultBase,
  isAnimated,
  resolveLightPassing,
} from "../lib/types";
import { SpriteSelector } from "./SpriteSelector";
import { TilePreview } from "./TilePreview";
import { Button, Dialog, Input, Segmented, Select, TabPanel, Tabs } from "../ui";

function emptyFrame(tilesetId: string): Frame {
  const rect = { x: 0, y: 0, w: 1, h: 1 };
  return {
    sprite: { tilesetId, rect, base: defaultBase(rect) },
    durationMs: 200,
  };
}

const DEFAULT_LIGHT: LightDef = {
  radius: 5,
  intensity: 1,
  color: "#ffcc88",
};

function blankTile(tilesets: TilesetDef[]): TileDef {
  const ts = tilesets[0]?.id ?? "";
  return {
    id: "",
    name: "New Tile",
    height: 0,
    directional: false,
    variants: { default: [emptyFrame(ts)] },
    attributes: {},
    lightPassing: false,
  };
}

/** Normalise optional lighting fields for the editor draft. */
function withLightingDefaults(tile: TileDef): TileDef {
  const { blocksLight: _deprecated, ...rest } = tile;
  return {
    ...rest,
    lightPassing: resolveLightPassing(tile),
  };
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tile: TileDef | null;
  tilesets: TilesetDef[];
  isNew: boolean;
  onSave: (tile: TileDef) => void;
  onDelete?: () => void;
};

export function TileEditorDialog({
  open,
  onOpenChange,
  tile,
  tilesets,
  isNew,
  onSave,
  onDelete,
}: Props) {
  const [draft, setDraft] = useState<TileDef>(() =>
    withLightingDefaults(tile ?? blankTile(tilesets)),
  );
  const [dir, setDir] = useState<VariantKey>(
    tile?.directional ? "n" : "default",
  );
  const [frameIndex, setFrameIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [lightOpen, setLightOpen] = useState(false);

  // Reset when opening with a different tile
  useEffect(() => {
    if (!open) return;
    const next = withLightingDefaults(tile ?? blankTile(tilesets));
    setDraft(next);
    setDir(next.directional ? "n" : "default");
    setFrameIndex(0);
    setError(null);
    setLightOpen(Boolean(next.light));
  }, [open, tile, tilesets]);

  const frames = draft.variants[dir] ?? [];
  const frame = frames[frameIndex] ?? frames[0];
  const tileset =
    tilesets.find((t) => t.id === frame?.sprite.tilesetId) ?? tilesets[0] ?? null;

  const setFrames = (next: Frame[]) => {
    setDraft((d) => ({
      ...d,
      variants: { ...d.variants, [dir]: next },
    }));
  };

  const updateFrame = (patch: Partial<Frame>) => {
    if (!frame) return;
    const next = frames.map((f, i) =>
      i === frameIndex ? { ...f, ...patch } : f,
    );
    setFrames(next);
  };

  const setSprite = (sprite: SpriteRef) => {
    updateFrame({ sprite });
  };

  const toggleDirectional = (on: boolean) => {
    if (on === draft.directional) return;
    if (on) {
      const base = draft.variants.default ?? draft.variants.n ?? [emptyFrame(tilesets[0]?.id ?? "")];
      const variants: TileDef["variants"] = {};
      for (const d of DIRECTIONS) {
        variants[d] = structuredClone(base);
      }
      setDraft({ ...draft, directional: true, variants });
      setDir("n");
      setFrameIndex(0);
    } else {
      if (!confirm("Convert to non-directional? Keeping N as default.")) return;
      const keep = draft.variants.n ?? draft.variants.default ?? [];
      setDraft({
        ...draft,
        directional: false,
        variants: { default: structuredClone(keep) },
      });
      setDir("default");
      setFrameIndex(0);
    }
  };

  const handleSave = () => {
    if (!draft.id.trim()) {
      setError("Id is required");
      return;
    }
    if (!/^[a-z0-9-]+$/.test(draft.id)) {
      setError("Id must be lowercase letters, numbers, and hyphens");
      return;
    }
    if (!draft.name.trim()) {
      setError("Name is required");
      return;
    }
    if (draft.directional) {
      for (const d of DIRECTIONS) {
        if (!draft.variants[d]?.length) {
          setError(`Missing frames for direction ${d.toUpperCase()}`);
          return;
        }
      }
    } else if (!draft.variants.default?.length) {
      setError("At least one frame is required");
      return;
    }
    setError(null);
    const light = draft.light;
    if (light) {
      if (!(light.radius > 0) || !Number.isFinite(light.radius)) {
        setError("Light radius must be a positive number");
        return;
      }
      if (
        !(light.intensity >= 0) ||
        !(light.intensity <= 1) ||
        !Number.isFinite(light.intensity)
      ) {
        setError("Light intensity must be between 0 and 1");
        return;
      }
      if (!/^#[0-9a-fA-F]{6}$/.test(light.color)) {
        setError("Light colour must be a hex like #ffcc88");
        return;
      }
    }
    onSave({
      ...draft,
      lightPassing: draft.lightPassing ? true : undefined,
      affectedByGravity: draft.affectedByGravity ? true : undefined,
      blocksLight: undefined,
      light: light
        ? {
            radius: light.radius,
            intensity: light.intensity,
            color: light.color.toLowerCase(),
          }
        : undefined,
    });
  };

  const dirTabs = draft.directional
    ? DIRECTIONS.map((d) => ({ value: d, label: d.toUpperCase() }))
    : [{ value: "default", label: "Default" }];

  const frameTabs = [
    ...frames.map((_, i) => ({ value: String(i), label: `Frame ${i + 1}` })),
    { value: "add", label: "+" },
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={isNew ? "New Tile" : `Edit ${tile?.name ?? ""}`}
      wide
      footer={
        <>
          {!isNew && onDelete ? (
            <Button variant="danger" onClick={onDelete} className="mr-auto">
              Delete
            </Button>
          ) : null}
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSave}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-bold uppercase text-muted">Id</span>
            <Input
              value={draft.id}
              disabled={!isNew}
              onChange={(e) => setDraft({ ...draft, id: e.target.value })}
              placeholder="grass"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-bold uppercase text-muted">Name</span>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <div className="flex flex-col gap-1 text-xs">
            <span className="font-bold uppercase text-muted">Height</span>
            <Segmented<TileHeight>
              value={draft.height}
              onChange={(height) => setDraft({ ...draft, height })}
              options={[
                { value: 0, label: "0 flat" },
                { value: 1, label: "1 half" },
                { value: 2, label: "2 full" },
              ]}
              size="sm"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.directional}
              onChange={(e) => toggleDirectional(e.target.checked)}
              className="hard-checkbox"
            />
            Directional
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.lightPassing ?? false}
              onChange={(e) =>
                setDraft({ ...draft, lightPassing: e.target.checked })
              }
              className="hard-checkbox"
            />
            Passes light
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.affectedByGravity ?? false}
              onChange={(e) =>
                setDraft({ ...draft, affectedByGravity: e.target.checked })
              }
              className="hard-checkbox"
            />
            Affected by gravity
          </label>
        </div>

        <div className="flex flex-col gap-2 border-2 border-border p-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={lightOpen}
              onChange={(e) => {
                const on = e.target.checked;
                setLightOpen(on);
                setDraft({
                  ...draft,
                  light: on ? (draft.light ?? { ...DEFAULT_LIGHT }) : undefined,
                });
              }}
              className="hard-checkbox"
            />
            Emits light
          </label>
          {lightOpen && draft.light ? (
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs">
                <span className="font-bold uppercase text-muted">Radius</span>
                <Input
                  type="number"
                  min={1}
                  step={1}
                  className="w-20"
                  value={draft.light.radius}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      light: {
                        ...draft.light!,
                        radius: Number(e.target.value) || 1,
                      },
                    })
                  }
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="font-bold uppercase text-muted">Intensity</span>
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  className="w-20"
                  value={draft.light.intensity}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      light: {
                        ...draft.light!,
                        intensity: Number(e.target.value),
                      },
                    })
                  }
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="font-bold uppercase text-muted">Colour</span>
                <input
                  type="color"
                  value={draft.light.color}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      light: { ...draft.light!, color: e.target.value },
                    })
                  }
                  className="h-8 w-12 cursor-pointer border-2 border-border bg-panel p-0"
                />
              </label>
            </div>
          ) : null}
        </div>

        {error ? (
          <div className="border-2 border-danger bg-danger/10 px-2 py-1 text-sm text-danger">
            {error}
          </div>
        ) : null}

        <Tabs
          value={String(dir)}
          onValueChange={(v) => {
            setDir(v as VariantKey);
            setFrameIndex(0);
          }}
          items={dirTabs}
        >
          {dirTabs.map((t) => (
            <TabPanel key={t.value} value={t.value}>
              <Tabs
                value={String(frameIndex)}
                onValueChange={(v) => {
                  if (v === "add") {
                    const clone = structuredClone(
                      frames[frames.length - 1] ?? emptyFrame(tilesets[0]?.id ?? ""),
                    );
                    setFrames([...frames, clone]);
                    setFrameIndex(frames.length);
                    return;
                  }
                  setFrameIndex(Number(v));
                }}
                items={frameTabs}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-xs">
                    <span className="font-bold uppercase text-muted">Duration ms</span>
                    <Input
                      type="number"
                      className="w-24"
                      value={frame?.durationMs ?? 200}
                      onChange={(e) =>
                        updateFrame({ durationMs: Number(e.target.value) || 200 })
                      }
                    />
                  </label>
                  {frames.length > 1 ? (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => {
                        const next = frames.filter((_, i) => i !== frameIndex);
                        setFrames(next);
                        setFrameIndex(Math.max(0, frameIndex - 1));
                      }}
                    >
                      Remove frame
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    onClick={() => {
                      if (!frame) return;
                      setFrames([
                        ...frames.slice(0, frameIndex + 1),
                        structuredClone(frame),
                        ...frames.slice(frameIndex + 1),
                      ]);
                      setFrameIndex(frameIndex + 1);
                    }}
                  >
                    Duplicate frame
                  </Button>
                </div>

                <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_180px]">
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold uppercase text-muted">
                        Tileset
                      </span>
                      <Select
                        value={tileset?.id ?? null}
                        onValueChange={(id) => {
                          if (!id || !frame) return;
                          const rect = { ...frame.sprite.rect };
                          setSprite({
                            tilesetId: id,
                            rect,
                            base: frame.sprite.base,
                          });
                        }}
                        options={tilesets.map((t) => ({
                          value: t.id,
                          label: t.name,
                        }))}
                      />
                    </div>
                    <SpriteSelector
                      tileset={tileset}
                      value={frame?.sprite ?? null}
                      onChange={setSprite}
                    />
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <span className="text-xs font-bold uppercase text-muted">
                      Preview
                    </span>
                    <TilePreview
                      tile={draft}
                      tilesets={tilesets}
                      size={96}
                      direction={
                        draft.directional ? (dir as Direction) : undefined
                      }
                    />
                  </div>
                </div>
              </Tabs>
            </TabPanel>
          ))}
        </Tabs>
      </div>
    </Dialog>
  );
}

export function tileIsAnimated(tile: TileDef) {
  return isAnimated(tile);
}
