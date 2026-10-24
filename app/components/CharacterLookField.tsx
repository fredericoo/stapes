import { useMemo } from "react";
import {
  composeSheet,
  randomLook,
  resolveHumanLook,
  type HumanAppearance,
  type Outfit,
} from "../lib/humanSprite";
import { HumanLookFields, WalkPreview, useLayerBlocks } from "./HumanLookFields";

const PREVIEW_ZOOM = 3;

/** The player tile's own outfit in data/tiles.json, so the preview wears what a new character starts in. */
const STARTING_OUTFIT: Outfit = { clothes: "white-tunic" };

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
        {error ? <p className="text-xs text-danger">Couldn't load the looks: {error}</p> : null}
        {sheet ? <WalkPreview sheet={sheet} zoom={PREVIEW_ZOOM} /> : null}
        {parts ? (
          <HumanLookFields
            parts={parts}
            look={look}
            layers={["head"]}
            onChange={(next) =>
              onChange({ skin: next.skin, hair: next.hair, head: next.parts.head })
            }
          />
        ) : null}
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
