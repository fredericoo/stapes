import { MAX_REFLECTIVE_COLORS, type TileReflective } from "../lib/types";
import { Button, FieldLabel, Switch } from "../ui";
import { ColorField, NumberField, Row } from "./ParticleFields";

const MAX_TURBULENCE_PX = 4;

export const DEFAULT_REFLECTIVE: TileReflective = {
  colors: ["#335c8c"],
  color: "#2e222f",
  turbulence: 1,
};

export function ReflectiveFields({
  reflective,
  onChange,
}: {
  reflective: TileReflective | undefined;
  onChange: (next: TileReflective | undefined) => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
      <div className="flex items-center gap-2">
        <FieldLabel info="Pixels of this tile's art in one of the mirror colours show whatever stands on the bank behind it, turned half a turn about its foot and painted in one flat colour. It is lit like the tile, so it darkens at night.">
          Reflective
        </FieldLabel>
        <Switch
          checked={reflective != null}
          onCheckedChange={(on) =>
            onChange(
              on ? { ...DEFAULT_REFLECTIVE, colors: [...DEFAULT_REFLECTIVE.colors] } : undefined,
            )
          }
          ariaLabel="Reflective"
        />
      </div>
      {reflective ? <ReflectiveSettings reflective={reflective} onChange={onChange} /> : null}
    </div>
  );
}

function ReflectiveSettings({
  reflective,
  onChange,
}: {
  reflective: TileReflective;
  onChange: (next: TileReflective) => void;
}) {
  const setColorAt = (index: number, hex: string) =>
    onChange({ ...reflective, colors: reflective.colors.map((c, i) => (i === index ? hex : c)) });
  const removeColorAt = (index: number) =>
    onChange({ ...reflective, colors: reflective.colors.filter((_, i) => i !== index) });

  return (
    <>
      <Row>
        {reflective.colors.map((hex, i) => (
          <div key={i} className="flex items-end gap-1">
            <ColorField
              label={`Mirror colour ${i + 1}`}
              value={hex}
              onChange={(next) => setColorAt(i, next)}
            />
            {reflective.colors.length > 1 ? (
              <Button size="sm" variant="ghost" onClick={() => removeColorAt(i)}>
                Remove
              </Button>
            ) : null}
          </div>
        ))}
        {reflective.colors.length < MAX_REFLECTIVE_COLORS ? (
          <Button
            size="sm"
            onClick={() => onChange({ ...reflective, colors: [...reflective.colors, "#000000"] })}
          >
            Add mirror colour
          </Button>
        ) : null}
      </Row>
      <Row>
        <ColorField
          label="Reflection colour"
          value={reflective.color}
          onChange={(color) => onChange({ ...reflective, color })}
        />
        <NumberField
          label="Turbulence (px)"
          info="How far a row of the reflection may sway sideways. 0 is a still mirror."
          value={reflective.turbulence}
          min={0}
          max={MAX_TURBULENCE_PX}
          step={1}
          onChange={(turbulence) => onChange({ ...reflective, turbulence })}
        />
      </Row>
    </>
  );
}
