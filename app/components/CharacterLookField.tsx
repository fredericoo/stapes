import { useEffect, useMemo, useRef, useState } from "react";
import { fetchBootstrap, tilesetUrl } from "../lib/api";
import { partsOn } from "../lib/humanParts";
import {
  FRAME_PX,
  HAIR_COLOURS,
  HAIR_COLOUR_NAMES,
  SHEET_FACINGS,
  SHEET_HEIGHT_PX,
  SHEET_WIDTH_PX,
  SKIN_TONES,
  SKIN_TONE_NAMES,
  composeSheet,
  randomLook,
  resolveHumanLook,
  type HumanAppearance,
  type Outfit,
} from "../lib/humanSprite";
import { CELL_SIZE, spriteRect, type Direction, type TileDef } from "../lib/types";
import { useLayerBlocks } from "./HumanLookFields";

/** The part the player tile's starting Cloth Tunic is drawn as, so the preview wears what a new character starts in. */
const STARTING_OUTFIT: Outfit = { clothes: "brown-tunic" };

const STAGE_COLS = 5;
const STAGE_ROWS = 4;
const STAGE_W = STAGE_COLS * CELL_SIZE;
const STAGE_H = STAGE_ROWS * CELL_SIZE;
const STAGE_ZOOM = 6;
const GROUND_TILE = "grass-2";
const TUFT_TILE = "grass";
/** Cells of the stage that also carry a grass tuft, so the floor is not one flat colour. */
const TUFT_CELLS: readonly [number, number][] = [
  [0, 1],
  [4, 0],
  [4, 2],
  [1, 3],
  [3, 3],
];

/**
 * A human's frame is 2×2 cells with the feet in the lower right cell, because
 * height is drawn up and to the left. This puts the middle of that cell in the middle of the stage.
 */
const STANDING_X = STAGE_W / 2 - 1.5 * CELL_SIZE;
const STANDING_Y = STAGE_H / 2 - 1.5 * CELL_SIZE;

const WALK_FRAME_MS = 200;
/** Columns of the sheet in the order a walk plays them: step, stand, the other step, stand. */
const WALK_CYCLE = [0, 1, 2, 1];
const CYCLES_PER_FACING = 2;
const TURN_ORDER: readonly Direction[] = ["s", "e", "n", "w"];

/** The 4×4 Bayer matrix, scaled to 0–1, that thresholds the floor's fade into a dither. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((n) => (n + 0.5) / 16);
/** Where the fade starts and ends, as a fraction of the distance from the centre to the stage's edge. */
const FADE_START = 0.45;
const FADE_END = 1;

export function randomAppearance(): HumanAppearance {
  const look = randomLook();
  return { skin: look.skin, hair: look.hair, head: look.parts.head };
}

export function CharacterLookField({
  value,
  onChange,
  disabled = false,
}: {
  value: HumanAppearance;
  onChange: (appearance: HumanAppearance) => void;
  disabled?: boolean;
}) {
  const { parts, error } = useLayerBlocks();
  const look = useMemo(() => resolveHumanLook(value, STARTING_OUTFIT), [value]);
  const sheet = useMemo(() => (parts ? composeSheet(parts, look) : null), [parts, look]);

  return (
    <div className="flex w-full flex-col gap-1">
      <span className="text-[10px] uppercase tracking-widest text-paper/60">Look</span>
      <fieldset
        aria-label="Look"
        disabled={disabled}
        className="flex w-full flex-col gap-3 border-2 border-paper/40 bg-paper p-3 text-ink"
      >
        {error ? <p className="text-xs text-danger">Couldn't load your character.</p> : null}
        <Stage sheet={sheet} />
        <ChipRow
          legend="Skin"
          names={SKIN_TONE_NAMES}
          colourOf={(tone) => SKIN_TONES[tone][1]}
          value={value.skin}
          onChange={(skin) => onChange({ ...value, skin })}
        />
        <ChipRow
          legend="Hair colour"
          names={HAIR_COLOUR_NAMES}
          colourOf={(hair) => HAIR_COLOURS[hair][1]}
          value={value.hair}
          onChange={(hair) => onChange({ ...value, hair })}
        />
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-xs font-bold uppercase text-muted">Hairstyle</legend>
          <div className="flex flex-wrap gap-1">
            {partsOn("head").map((part) => (
              <button
                key={part.id}
                type="button"
                aria-pressed={part.id === value.head}
                onClick={() => onChange({ ...value, head: part.id })}
                className={[
                  "border-2 px-2 py-1 text-xs",
                  part.id === value.head ? "border-accent bg-accent/10" : "border-border",
                ].join(" ")}
              >
                {part.label}
              </button>
            ))}
          </div>
        </fieldset>
        <button
          type="button"
          className="self-start text-xs uppercase tracking-widest underline underline-offset-4"
          onClick={() => onChange(randomAppearance())}
        >
          Shuffle
        </button>
      </fieldset>
    </div>
  );
}

function ChipRow<T extends string>({
  legend,
  names,
  colourOf,
  value,
  onChange,
}: {
  legend: string;
  names: readonly T[];
  colourOf: (name: T) => string;
  value: T;
  onChange: (name: T) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 flex w-full justify-between text-xs font-bold uppercase text-muted">
        {legend}
        <span className="font-normal normal-case">{value}</span>
      </legend>
      <div className="flex gap-1">
        {names.map((name) => (
          <button
            key={name}
            type="button"
            aria-label={name}
            aria-pressed={name === value}
            title={name}
            onClick={() => onChange(name)}
            className={[
              "aspect-square min-w-0 max-w-8 flex-1 border-2",
              name === value ? "border-accent outline outline-2 outline-accent" : "border-border",
            ].join(" ")}
            style={{ backgroundColor: colourOf(name) }}
          />
        ))}
      </div>
    </fieldset>
  );
}

function useFloor(): ImageBitmap | null {
  const [floor, setFloor] = useState<ImageBitmap | null>(null);
  useEffect(() => {
    let live = true;
    buildFloor()
      .then((bitmap) => {
        if (live) setFloor(bitmap);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return floor;
}

let floorPromise: Promise<ImageBitmap> | null = null;

/** The grass the character stands on, faded to transparent towards the stage's edges. */
function buildFloor(): Promise<ImageBitmap> {
  floorPromise ??= (async () => {
    const { tiles, tilesets } = await fetchBootstrap();
    const ground = tiles.find((t) => t.id === GROUND_TILE);
    const tuft = tiles.find((t) => t.id === TUFT_TILE);
    if (!ground) throw new Error(`no ${GROUND_TILE} tile`);
    const images = new Map<string, Promise<ImageBitmap>>();
    const imageFor = (tilesetId: string) => {
      const file = tilesets.find((s) => s.id === tilesetId)?.file;
      if (!file) throw new Error(`no tileset ${tilesetId}`);
      let image = images.get(file);
      if (!image) {
        image = fetch(tilesetUrl(file)).then(async (r) => createImageBitmap(await r.blob()));
        images.set(file, image);
      }
      return image;
    };

    const canvas = new OffscreenCanvas(STAGE_W, STAGE_H);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    const drawCell = async (tile: TileDef, col: number, row: number) => {
      const frame = tile.sprite?.frames[0]?.sprite;
      if (!frame) return;
      const rect = spriteRect(tile.anchor, frame);
      ctx.drawImage(
        await imageFor(tile.anchor.tilesetId),
        rect.x * CELL_SIZE,
        rect.y * CELL_SIZE,
        CELL_SIZE,
        CELL_SIZE,
        col * CELL_SIZE,
        row * CELL_SIZE,
        CELL_SIZE,
        CELL_SIZE,
      );
    };
    for (let row = 0; row < STAGE_ROWS; row++) {
      for (let col = 0; col < STAGE_COLS; col++) await drawCell(ground, col, row);
    }
    if (tuft) for (const [col, row] of TUFT_CELLS) await drawCell(tuft, col, row);

    const pixels = ctx.getImageData(0, 0, STAGE_W, STAGE_H);
    for (let y = 0; y < STAGE_H; y++) {
      for (let x = 0; x < STAGE_W; x++) {
        const dx = (x + 0.5 - STAGE_W / 2) / (STAGE_W / 2);
        const dy = (y + 0.5 - STAGE_H / 2) / (STAGE_H / 2);
        const fade = (FADE_END - Math.hypot(dx, dy)) / (FADE_END - FADE_START);
        if (fade <= BAYER[(y % 4) * 4 + (x % 4)]!) pixels.data[(y * STAGE_W + x) * 4 + 3] = 0;
      }
    }
    ctx.putImageData(pixels, 0, 0);
    return canvas.transferToImageBitmap();
  })().catch((err: unknown) => {
    floorPromise = null;
    throw err;
  });
  return floorPromise;
}

/** Counts walk frames; the facing turns every `CYCLES_PER_FACING` full cycles. */
function useWalkTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), WALK_FRAME_MS);
    return () => clearInterval(timer);
  }, []);
  return tick;
}

function Stage({ sheet }: { sheet: Uint8ClampedArray<ArrayBuffer> | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const floor = useFloor();
  const tick = useWalkTick();
  const sprite = useMemo(() => {
    if (!sheet) return null;
    const canvas = new OffscreenCanvas(SHEET_WIDTH_PX, SHEET_HEIGHT_PX);
    canvas
      .getContext("2d")
      ?.putImageData(new ImageData(sheet, SHEET_WIDTH_PX, SHEET_HEIGHT_PX), 0, 0);
    return canvas;
  }, [sheet]);

  const column = WALK_CYCLE[tick % WALK_CYCLE.length]!;
  const facing =
    TURN_ORDER[Math.floor(tick / (WALK_CYCLE.length * CYCLES_PER_FACING)) % TURN_ORDER.length]!;
  const row = SHEET_FACINGS.indexOf(facing);

  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, STAGE_W, STAGE_H);
    if (floor) ctx.drawImage(floor, 0, 0);
    if (sprite) {
      ctx.drawImage(
        sprite,
        column * FRAME_PX,
        row * FRAME_PX,
        FRAME_PX,
        FRAME_PX,
        STANDING_X,
        STANDING_Y,
        FRAME_PX,
        FRAME_PX,
      );
    }
  }, [floor, sprite, column, row]);

  return (
    <canvas
      ref={ref}
      width={STAGE_W}
      height={STAGE_H}
      role="img"
      aria-label="Your character"
      style={{ width: STAGE_W * STAGE_ZOOM, height: STAGE_H * STAGE_ZOOM }}
      className="self-center [image-rendering:pixelated]"
    />
  );
}
