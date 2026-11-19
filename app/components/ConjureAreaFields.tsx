import { type AreaShape, areaOffsets, MAX_AREA_RADIUS, MIN_AREA_RADIUS } from "../lib/area";
import type { ConjureArea, StoneSubject } from "../lib/item";
import { FieldLabel, Segmented, SwitchField } from "../ui";
import { SHAPE_OPTIONS } from "./AreaFields";
import { StatField } from "./StatField";

const DEFAULT_CONJURE_AREA: ConjureArea = { shape: "ring", radius: 3 };

const CENTRE_OPTIONS: { value: StoneSubject; label: string }[] = [
  { value: "caster", label: "Caster" },
  { value: "target", label: "Target" },
];

export function ConjureAreaFields({
  area,
  onChange,
}: {
  area: ConjureArea | undefined;
  onChange: (area: ConjureArea | undefined) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <SwitchField
        checked={area !== undefined}
        onCheckedChange={(on) => onChange(on ? DEFAULT_CONJURE_AREA : undefined)}
        label="Fill a shape"
        info="Puts the tile in every cell of the shape that will hold it. Cells with a wall, a drop, open water or a body in the way are skipped. Refused only when none fit."
      />
      {area ? (
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex flex-col gap-1 text-xs">
            <FieldLabel info="Around the caster, or around the target. With nobody targeted, a shape on the target is centred on the cell the caster faces. Only a shape on the target is shown while the cast winds up.">
              Centre
            </FieldLabel>
            <Segmented<StoneSubject>
              value={area.on ?? "caster"}
              onChange={(on) => onChange({ ...area, on: on === "target" ? on : undefined })}
              options={CENTRE_OPTIONS}
              size="sm"
              ariaLabel="Conjure centre"
            />
          </div>
          <div className="flex flex-col gap-1 text-xs">
            <FieldLabel info="Which cells around the centre it fills, out to the radius.">
              Shape
            </FieldLabel>
            <Segmented<AreaShape>
              value={area.shape}
              onChange={(shape) => onChange({ ...area, shape })}
              options={SHAPE_OPTIONS}
              size="sm"
              ariaLabel="Conjure shape"
            />
          </div>
          <StatField
            label="Radius"
            info="How many cells out from the centre it reaches."
            value={area.radius}
            min={MIN_AREA_RADIUS}
            max={MAX_AREA_RADIUS}
            onChange={(radius) => onChange({ ...area, radius })}
            readout={`${areaOffsets(area.shape, area.radius).length} cells at most.`}
          />
        </div>
      ) : null}
    </div>
  );
}
