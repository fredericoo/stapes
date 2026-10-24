import { useEffect, useMemo, useRef, useState } from "react";
import * as v from "valibot";
import { LAYERS, partsOn, type HumanPartId, type LayerId } from "../lib/humanParts";
import { loadLayerBlocks } from "../lib/humanSheets";
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
  humanLookSchema,
  type HumanLook,
  type LayerBlocks,
} from "../lib/humanSprite";
import type { Direction } from "../lib/types";
import { FieldLabel } from "../ui";

const PREVIEW_ZOOM = 6;
const THUMB_ZOOM = 3;
const WALK_FRAME_MS = 200;
const STAND_COLUMN = 1;
const SOUTH_ROW = SHEET_FACINGS.indexOf("s");

/** Columns of the sheet in the order a walk plays them: step, stand, the other step, stand. */
const WALK_CYCLE = [0, 1, 2, 1];

const FACING_LABEL: Record<Direction, string> = { n: "North", e: "East", s: "South", w: "West" };

export function useLayerBlocks(): { parts: LayerBlocks | null; error: string | null } {
  const [parts, setParts] = useState<LayerBlocks | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadLayerBlocks()
      .then(setParts)
      .catch((err: unknown) => setError(String(err)));
  }, []);
  return { parts, error };
}

/** Parsing checks the part belongs on that layer, which the computed key alone cannot. */
function withPart(look: HumanLook, layer: LayerId, id: HumanPartId | null): HumanLook {
  return v.parse(humanLookSchema, { ...look, parts: { ...look.parts, [layer]: id } });
}

function useWalkColumn(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => (t + 1) % WALK_CYCLE.length), WALK_FRAME_MS);
    return () => clearInterval(timer);
  }, []);
  return WALK_CYCLE[tick]!;
}

/**
 * Skin, hair and a thumbnail row per layer. A layer with one part and no
 * "none" (the body) offers no choice, so it is left out.
 */
export function HumanLookFields({
  parts,
  look,
  onChange,
  layers = LAYERS.map((l) => l.id),
}: {
  parts: LayerBlocks;
  look: HumanLook;
  onChange: (look: HumanLook) => void;
  layers?: readonly LayerId[];
}) {
  return (
    <>
      <SkinField value={look.skin} onChange={(skin) => onChange({ ...look, skin })} />
      <HairField value={look.hair} onChange={(hair) => onChange({ ...look, hair })} />
      {layers
        .filter((layer) => optionsOn(layer).length > 1)
        .map((layer) => (
          <VariantField
            key={layer}
            layer={layer}
            parts={parts}
            look={look}
            onChange={(id) => onChange(withPart(look, layer, id))}
          />
        ))}
    </>
  );
}

/** Owns the walk clock so its ticks re-render the four previews and nothing else. */
export function WalkPreview({ sheet }: { sheet: Uint8ClampedArray<ArrayBuffer> }) {
  const column = useWalkColumn();
  return (
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
  );
}

export function SheetCanvas({
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

function optionsOn(layer: LayerId): { id: HumanPartId | null; label: string }[] {
  const options: { id: HumanPartId | null; label: string }[] = partsOn(layer).map((p) => ({
    id: p.id,
    label: p.label,
  }));
  const optional = LAYERS.find((l) => l.id === layer)!.optional;
  return optional ? [{ id: null, label: "None" }, ...options] : options;
}

/** Each option shows the whole look wearing that part, facing south and standing. */
function VariantField({
  layer,
  parts,
  look,
  onChange,
}: {
  layer: LayerId;
  parts: LayerBlocks;
  look: HumanLook;
  onChange: (id: HumanPartId | null) => void;
}) {
  const def = LAYERS.find((l) => l.id === layer)!;
  const options = optionsOn(layer);
  const sheets = useMemo(
    () => optionsOn(layer).map(({ id }) => composeSheet(parts, withPart(look, layer, id))),
    [parts, look, layer],
  );
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1">
        <FieldLabel info={`Drawn from ${def.file} and named in app/lib/humanParts.ts.`}>
          {def.label}
        </FieldLabel>
      </legend>
      <div className="flex flex-wrap gap-1">
        {options.map(({ id, label }, i) => (
          <VariantOption
            key={id ?? "none"}
            label={`${def.label}: ${label}`}
            pressed={look.parts[layer] === id}
            sheet={sheets[i]!}
            onClick={() => onChange(id)}
          />
        ))}
      </div>
      {options.length === 0 || (options.length === 1 && def.optional) ? (
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
