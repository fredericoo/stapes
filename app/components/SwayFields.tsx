import { MAX_SWAY_PX, type TileSway } from "../lib/types";
import { FieldLabel, Switch } from "../ui";
import { NumberField, Row } from "./ParticleFields";

const MAX_ROOT_PX = 64;

export const DEFAULT_SWAY: TileSway = { px: 1, rootPx: 4 };

export function SwayFields({
  sway,
  onChange,
}: {
  sway: TileSway | undefined;
  onChange: (next: TileSway | undefined) => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
      <div className="flex items-center gap-2">
        <FieldLabel info="The art leans with the wind as gusts cross the map, a whole pixel at a time, up and to the right, more toward the top. For trees, bushes and other plants. Only the drawing changes.">
          Sways in the wind
        </FieldLabel>
        <Switch
          checked={sway != null}
          onCheckedChange={(on) => onChange(on ? { ...DEFAULT_SWAY } : undefined)}
          ariaLabel="Sways in the wind"
        />
      </div>
      {sway ? (
        <Row>
          <NumberField
            label="Lean at the top (px)"
            info="How far the top of the art moves in a full gust, diagonally. The art below it moves less."
            value={sway.px}
            min={1}
            max={MAX_SWAY_PX}
            step={1}
            onChange={(px) => onChange({ ...sway, px })}
          />
          <NumberField
            label="Still base (px)"
            info="How much of the art never moves, measured from the bottom-right corner of the sprite up and to the left, the way height is drawn. A trunk, or the stems at the ground."
            value={sway.rootPx}
            min={0}
            max={MAX_ROOT_PX}
            step={1}
            onChange={(rootPx) => onChange({ ...sway, rootPx })}
          />
        </Row>
      ) : null}
    </div>
  );
}
