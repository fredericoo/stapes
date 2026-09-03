import { useEffect, useMemo, useRef, useState } from "react";
import { PLAYER_TILE_ID } from "../game/constants";
import type { StatusVfx } from "../lib/statusVfx";
import type { TileDef, TilesetDef } from "../lib/types";
import { VfxPreview as PreviewRenderer } from "../render/VfxPreview";
import { Select, Switch } from "../ui";

/**
 * The rendering simulation, and the picker that says what it is drawn on.
 *
 * The canvas is the point of the whole effects section: a tint is three numbers
 * and a plume is fifteen, and not one of them means anything written down. What
 * an author is actually deciding is whether a fire looks like a fire, and the
 * only way to answer that is to show them one — through the same particle
 * simulation, the same tint shader and the same palette quantise the world uses,
 * so what they approve here is what ships. See `../render/VfxPreview`.
 *
 * ## Why it draws on a *tile* and not on a battler
 *
 * Statuses land on bodies today, but they are not going to stay there — a bush
 * catching fire is the same effect on a different subject, and an author needs to
 * see it on the thing it will be on. So the subject is anything in the catalogue,
 * and switching it is one control.
 *
 * ## Two callers, and one of them already knows its subject
 *
 * The status editor picks a subject, because a status has none of its own. The
 * tile editor **is** the subject, so it passes one and the picker goes away with
 * it — along with the wind-down scrubber, which is a fact about a status and
 * nothing a tile has. A control that can never do anything is worse than no
 * control: it implies the tile has a taper somewhere.
 */

/** How the picker is ordered: the player first, then everything alphabetically. */
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

/**
 * The picker's value for "draw the plume over empty floor".
 *
 * A sentinel rather than an empty string, because the `Select` reads an empty
 * value as "nothing chosen" and would sit blank instead of saying what it is
 * showing.
 */
const NO_SUBJECT = "~none";

/** Shared empty, so a caller with a fixed subject allocates nothing to say so. */
const NO_TILES: TileDef[] = [];

export function VfxPreview({
  vfx,
  tiles = NO_TILES,
  tilesets,
  subject: fixedSubject,
}: {
  vfx: StatusVfx;
  /**
   * The catalogue the subject is picked from.
   *
   * Unread when {@link fixedSubject} says what to draw on, and optional for
   * exactly that caller — handing a whole catalogue to a picker that is not
   * going to be rendered says the wrong thing about what this needs.
   */
  tiles?: TileDef[];
  tilesets: TilesetDef[];
  /**
   * The tile to draw on, for a caller that already has one.
   *
   * Present is what turns the picker and the scrubber off — see the note above.
   * Null draws the plume over bare ground, which is the honest answer for a tile
   * that has no sprite authored yet.
   */
  subject?: TileDef | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<PreviewRenderer | null>(null);
  /**
   * The player, because it is the sprite an author has in their head when they
   * write a status — everything that can be poisoned today is a body, and the
   * player is the body they will be looking at when it happens.
   */
  const [subjectId, setSubjectId] = useState<string>(PLAYER_TILE_ID);
  /**
   * Daylight by default, because that is what a colour is judged against — a
   * ramp tuned in the dark is a ramp tuned against one particular ambient.
   */
  const [night, setNight] = useState(false);
  /**
   * Untouched by default. The scrubber is for looking at the wind-down; the
   * thing an author is usually judging is the effect at full strength.
   */
  const [taper, setTaper] = useState(1);

  const options = useMemo(() => subjectOptions(tiles), [tiles]);
  const subject =
    fixedSubject !== undefined
      ? fixedSubject
      : (tiles.find((t) => t.id === subjectId) ?? null);

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

  // Split from the effect above rather than folded into it, because a subject
  // change must not tear the canvas down: rebuilding the renderer would throw
  // away every particle in the air and restart the plume the author is judging.
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

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] font-bold uppercase text-muted">
        As it will look
      </span>
      <canvas
        ref={canvasRef}
        className="aspect-square w-full max-w-[288px] border-2 border-border [image-rendering:pixelated]"
        // The canvas is the whole readout, so it needs a name — there is nothing
        // else on this panel that says what it is showing.
        aria-label={`Preview of the effect on ${subject?.name ?? "bare ground"}`}
        role="img"
      />
      {/* Both belong to the status editor: one picks a subject the status does
          not have, the other scrubs a wind-down a tile does not have. A caller
          that brought its own subject gets neither. */}
      {fixedSubject === undefined ? (
        <>
          <label className="flex flex-col gap-0.5">
            <span className="text-[11px] font-bold uppercase text-muted">
              Drawn on
            </span>
            <Select
              value={subjectId}
              onValueChange={(id) => setSubjectId(id ?? PLAYER_TILE_ID)}
              options={options}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[11px] font-bold uppercase text-muted">
              {vfx.taperMs > 0
                ? `Left to run · ${taper.toFixed(2)}`
                : "Left to run · not set"}
            </span>
            {/* Scrubbed rather than waited out: a fade an author had to sit
                through thirty seconds of is a fade nobody would tune. Disabled
                when nothing winds down, so the control cannot imply an effect
                that is not there. */}
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
        <span className="text-[11px] font-bold uppercase text-muted">
          Unlit room
        </span>
        <Switch
          checked={night}
          onCheckedChange={setNight}
          ariaLabel="Unlit room"
        />
      </label>
      <p className="max-w-[288px] text-[11px] leading-snug text-muted">
        Through the same particles, the same tint shader and the same palette
        quantise the world runs.
      </p>
      <p className="max-w-[288px] text-[11px] leading-snug text-muted">
        {night
          ? "Anything lit by the room goes dark; a spark that lights itself does not. A cast light is approximated at the bearer's own cell — it says how bright and what colour, not how far."
          : "Daylight, which is what a colour is worth judging against. Turn the room out to see which particles the world lights."}
      </p>
    </div>
  );
}
