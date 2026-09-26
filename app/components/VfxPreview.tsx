import { useEffect, useMemo, useRef, useState } from "react";
import { PLAYER_TILE_ID } from "../game/constants";
import type { StatusVfx } from "../lib/statusVfx";
import type { Transition, TransitionSide } from "../lib/tileTransition";
import type { TileDef, TilesetDef } from "../lib/types";
import { VfxPreview as PreviewRenderer } from "../render/VfxPreview";
import { Select, Switch } from "../ui";

function subjectOptions(tiles: readonly TileDef[]) {
  const rest = tiles
    .filter((t) => t.id !== PLAYER_TILE_ID)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({ value: t.id, label: t.name || t.id }));
  const player = tiles.find((t) => t.id === PLAYER_TILE_ID);
  return [
    ...(player ? [{ value: player.id, label: player.name || player.id }] : []),
    { value: NO_SUBJECT, label: "Nothing — bare ground" },
    ...rest,
  ];
}

const NO_SUBJECT = "~none";

const NO_TILES: TileDef[] = [];

export type TransitionPlay = {
  transition: Transition;
  side: TransitionSide;
  token: number;
};

export function VfxPreview({
  vfx,
  tiles = NO_TILES,
  tilesets,
  subject: fixedSubject,
  winds = false,
  transitionPlay = null,
}: {
  vfx: StatusVfx;
  tiles?: TileDef[];
  tilesets: TilesetDef[];
  subject?: TileDef | null;
  winds?: boolean;
  transitionPlay?: TransitionPlay | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<PreviewRenderer | null>(null);
  const [subjectId, setSubjectId] = useState<string>(PLAYER_TILE_ID);
  const [night, setNight] = useState(false);
  const [taper, setTaper] = useState(1);

  const options = useMemo(() => subjectOptions(tiles), [tiles]);
  const subject =
    fixedSubject !== undefined ? fixedSubject : (tiles.find((t) => t.id === subjectId) ?? null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const preview = new PreviewRenderer(canvas);
    previewRef.current = preview;
    preview.start();
    return () => {
      previewRef.current = null;
      preview.dispose();
    };
  }, []);

  useEffect(() => {
    previewRef.current?.setSubject(subject, tilesets);
  }, [subject, tilesets]);

  useEffect(() => {
    previewRef.current?.setVfx(vfx);
  }, [vfx]);

  useEffect(() => {
    previewRef.current?.setNight(night);
  }, [night]);

  useEffect(() => {
    previewRef.current?.setTaper(taper);
  }, [taper]);

  useEffect(() => {
    if (!transitionPlay) return;
    previewRef.current?.playTransition(transitionPlay.transition, transitionPlay.side);
  }, [transitionPlay]);

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] font-bold uppercase text-muted">As it will look</span>
      <canvas
        ref={canvasRef}
        className="aspect-square w-full max-w-[288px] border-2 border-border [image-rendering:pixelated]"
        aria-label={`Preview of the effect on ${subject?.name ?? "bare ground"}`}
        role="img"
      />
      {fixedSubject === undefined ? (
        <label className="flex flex-col gap-0.5">
          <span className="text-[11px] font-bold uppercase text-muted">Drawn on</span>
          <Select
            value={subjectId}
            onValueChange={(id) => setSubjectId(id ?? PLAYER_TILE_ID)}
            options={options}
          />
        </label>
      ) : null}
      {winds ? (
        <>
          <label className="flex flex-col gap-0.5">
            <span className="text-[11px] font-bold uppercase text-muted">
              {vfx.taperMs > 0 ? `Left to run · ${taper.toFixed(2)}` : "Left to run · not set"}
            </span>
            <input
              type="range"
              className="w-full max-w-[288px] accent-accent disabled:opacity-40"
              min={0}
              max={1}
              step={0.05}
              value={taper}
              disabled={vfx.taperMs <= 0}
              aria-label="Left to run"
              onChange={(e) => setTaper(Number(e.target.value))}
            />
          </label>
        </>
      ) : null}
      <label className="flex items-center gap-2">
        <span className="text-[11px] font-bold uppercase text-muted">Unlit room</span>
        <Switch checked={night} onCheckedChange={setNight} ariaLabel="Unlit room" />
      </label>
      <p className="max-w-[288px] text-[11px] leading-snug text-muted">
        Through the same particles, the same tint shader and the same palette quantise the world
        runs.
      </p>
      <p className="max-w-[288px] text-[11px] leading-snug text-muted">
        {night
          ? "Anything lit by the room goes dark; a spark that lights itself does not. A cast light is approximated at the bearer's own cell — it says how bright and what colour, not how far."
          : "Daylight, which is what a colour is worth judging against. Turn the room out to see which particles the world lights."}
      </p>
    </div>
  );
}
