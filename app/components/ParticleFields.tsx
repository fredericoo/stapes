import {
  EMPTY_SHAPE,
  MAX_PARTICLE_RADIUS_PX,
  MAX_PARTICLE_RATE,
  MAX_PARTICLE_TTL_MS,
  MAX_RAMP_STOPS,
  PARTICLE_SHAPE_PX,
  type ParticleEmitterDef,
  type ParticleShape,
  type RampStop,
  shapeHas,
  toggleShapePixel,
} from "../lib/particleVfx";
import { Button, FieldLabel, Input, NumberInput, Switch } from "../ui";

const UNIT_STEP = 0.05;

const NEW_STOP: RampStop = { at: 0.5, color: "#fbb954" };

export function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-start gap-3">{children}</div>;
}

export function Field({
  label,
  info,
  hint,
  children,
}: {
  label: string;
  info?: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <FieldLabel info={info}>{label}</FieldLabel>
      {children}
      {hint ? <span className="text-[11px] text-muted">{hint}</span> : null}
    </label>
  );
}

export function NumberField({
  label,
  info,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  info?: React.ReactNode;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (next: number) => void;
}) {
  return (
    <Field label={label} info={info} hint={hint}>
      <NumberInput
        className="w-24"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={onChange}
      />
    </Field>
  );
}

export function UnitSlider({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <Field label={`${label} · ${value.toFixed(2)}`} hint={hint}>
      <input
        type="range"
        className="w-40 accent-accent"
        min={0}
        max={1}
        step={UNIT_STEP}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </Field>
  );
}

export function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-1">
        <input
          type="color"
          className="h-8 w-10 cursor-pointer border-2 border-border bg-paper"
          value={value}
          aria-label={label}
          onChange={(e) => onChange(e.target.value)}
        />
        <Input
          className="w-24 font-mono"
          value={value}
          aria-label={`${label} hex`}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </Field>
  );
}

function RampEditor({
  ramp,
  onChange,
}: {
  ramp: RampStop[];
  onChange: (next: RampStop[]) => void;
}) {
  const patch = (index: number, fields: Partial<RampStop>) =>
    onChange(ramp.map((s, i) => (i === index ? { ...s, ...fields } : s)));

  return (
    <div className="flex flex-col gap-2">
      <FieldLabel info="Colour over one particle's life. One stop is a constant colour; four is a fire. Stops are sorted when drawn, so one dragged past its neighbour reorders the ramp; before the first stop and after the last, that stop holds.">
        Colour ramp
      </FieldLabel>
      {ramp.map((stop, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2">
          <ColorField
            label={`Stop ${i + 1}`}
            value={stop.color}
            onChange={(color) => patch(i, { color })}
          />
          <Field label={`At · ${stop.at.toFixed(2)}`}>
            <input
              type="range"
              className="w-32 accent-accent"
              min={0}
              max={1}
              step={UNIT_STEP}
              value={stop.at}
              aria-label={`Stop ${i + 1} position`}
              onChange={(e) => patch(i, { at: Number(e.target.value) })}
            />
          </Field>
          <Button
            disabled={ramp.length <= 1}
            onClick={() => onChange(ramp.filter((_, j) => j !== i))}
          >
            Remove
          </Button>
        </div>
      ))}
      <div>
        <Button
          disabled={ramp.length >= MAX_RAMP_STOPS}
          onClick={() => onChange([...ramp, { ...NEW_STOP }])}
        >
          Add stop
        </Button>
      </div>
    </div>
  );
}

function ShapeEditor({
  shape,
  color,
  onChange,
}: {
  shape: ParticleShape;
  color: string;
  onChange: (next: ParticleShape) => void;
}) {
  const cells = Array.from({ length: PARTICLE_SHAPE_PX }, (_, y) =>
    Array.from({ length: PARTICLE_SHAPE_PX }, (_, x) => ({ x, y })),
  ).flat();
  return (
    <div
      className="grid w-fit gap-px border-2 border-border bg-muted"
      style={{ gridTemplateColumns: `repeat(${PARTICLE_SHAPE_PX}, 1.25rem)` }}
    >
      {cells.map(({ x, y }) => {
        const on = shapeHas(shape, x, y);
        return (
          <button
            key={`${x},${y}`}
            type="button"
            className="size-5 cursor-pointer bg-ink"
            style={on ? { backgroundColor: color } : undefined}
            aria-label={`Pixel ${x + 1}, ${y + 1}`}
            aria-pressed={on}
            onClick={() => onChange(toggleShapePixel(shape, x, y))}
          />
        );
      })}
    </div>
  );
}

export function ParticleFields({
  particles,
  onChange,
}: {
  particles: ParticleEmitterDef;
  onChange: (next: ParticleEmitterDef) => void;
}) {
  const patch = (fields: Partial<ParticleEmitterDef>) => onChange({ ...particles, ...fields });

  return (
    <div className="flex flex-col gap-3">
      <Row>
        <NumberField
          label="Per second"
          hint="How many are born."
          value={particles.ratePerSecond}
          min={0}
          max={MAX_PARTICLE_RATE}
          onChange={(ratePerSecond) => patch({ ratePerSecond })}
        />
        <NumberField
          label="Lives from (ms)"
          value={particles.ttlFromMs}
          min={0}
          max={MAX_PARTICLE_TTL_MS}
          onChange={(ttlFromMs) =>
            patch({ ttlFromMs, ttlToMs: Math.max(ttlFromMs, particles.ttlToMs) })
          }
        />
        <NumberField
          label="To (ms)"
          hint="A spread is what makes a plume look random."
          value={particles.ttlToMs}
          min={0}
          max={MAX_PARTICLE_TTL_MS}
          onChange={(ttlToMs) =>
            patch({ ttlToMs, ttlFromMs: Math.min(ttlToMs, particles.ttlFromMs) })
          }
        />
      </Row>

      <Row>
        <NumberField
          label="Spread (cells)"
          hint="0.5 is exactly the tile."
          value={particles.spawnRadiusCells}
          min={0}
          max={4}
          step={0.05}
          onChange={(spawnRadiusCells) => patch({ spawnRadiusCells })}
        />
        <NumberField
          label="Starts at (height)"
          hint="0 is the floor of the tile."
          value={particles.spawnElevFrom}
          min={0}
          max={32}
          step={0.5}
          onChange={(spawnElevFrom) =>
            patch({
              spawnElevFrom,
              spawnElevTo: Math.max(spawnElevFrom, particles.spawnElevTo),
            })
          }
        />
        <NumberField
          label="Up to (height)"
          hint="4 is one whole level."
          value={particles.spawnElevTo}
          min={0}
          max={32}
          step={0.5}
          onChange={(spawnElevTo) =>
            patch({
              spawnElevTo,
              spawnElevFrom: Math.min(spawnElevTo, particles.spawnElevFrom),
            })
          }
        />
      </Row>

      <Row>
        <NumberField
          label="Rises from"
          hint="Height units a second. Up is up-left on screen."
          value={particles.riseFrom}
          min={-32}
          max={32}
          step={0.25}
          onChange={(riseFrom) => patch({ riseFrom, riseTo: Math.max(riseFrom, particles.riseTo) })}
        />
        <NumberField
          label="To"
          value={particles.riseTo}
          min={-32}
          max={32}
          step={0.25}
          onChange={(riseTo) => patch({ riseTo, riseFrom: Math.min(riseTo, particles.riseFrom) })}
        />
        <NumberField
          label="Drift"
          hint="Cells a second sideways, drawn once at birth."
          value={particles.driftCellsPerSecond}
          min={0}
          max={8}
          step={0.05}
          onChange={(driftCellsPerSecond) => patch({ driftCellsPerSecond })}
        />
        <NumberField
          label="Gravity"
          hint="Negative pulls back down — the fallout."
          value={particles.gravity}
          min={-64}
          max={64}
          step={0.25}
          onChange={(gravity) => patch({ gravity })}
        />
      </Row>

      <Row>
        <NumberField
          label="Wind east"
          hint="Cells a second squared. Negative blows west."
          value={particles.windX}
          min={-32}
          max={32}
          step={0.25}
          onChange={(windX) => patch({ windX })}
        />
        <NumberField
          label="Wind south"
          hint="Builds over a particle's life, so a plume bends as it climbs."
          value={particles.windY}
          min={-32}
          max={32}
          step={0.25}
          onChange={(windY) => patch({ windY })}
        />
      </Row>

      <Row>
        <Field
          label="Shape"
          hint={
            particles.shape
              ? "Drawn pixel for pixel, coloured by the ramp."
              : "A circle, sized by the radius."
          }
        >
          <Switch
            checked={particles.shape !== null}
            onCheckedChange={(on) => patch({ shape: on ? [...EMPTY_SHAPE] : null })}
            ariaLabel="Draw a shape instead of a circle"
          />
        </Field>
        {particles.shape ? (
          <ShapeEditor
            shape={particles.shape}
            color={particles.ramp[0]?.color ?? "#ffffff"}
            onChange={(shape) => patch({ shape })}
          />
        ) : null}
      </Row>

      <Row>
        {particles.shape ? null : (
          <>
            <NumberField
              label="Radius from (px)"
              hint="Rounded to whole pixels — a circle between two sizes does not exist."
              value={particles.radiusFromPx}
              min={0}
              max={MAX_PARTICLE_RADIUS_PX}
              step={1}
              onChange={(radiusFromPx) => patch({ radiusFromPx })}
            />
            <NumberField
              label="To (px)"
              hint="Larger than the first makes them grow as they fade."
              value={particles.radiusToPx}
              min={0}
              max={MAX_PARTICLE_RADIUS_PX}
              step={1}
              onChange={(radiusToPx) => patch({ radiusToPx })}
            />
          </>
        )}
        <UnitSlider
          label="Opacity from"
          value={particles.alphaFrom}
          onChange={(alphaFrom) => patch({ alphaFrom })}
        />
        <UnitSlider
          label="To"
          hint="Blended before the palette quantise, so it stays on the ramp."
          value={particles.alphaTo}
          onChange={(alphaTo) => patch({ alphaTo })}
        />
      </Row>

      <Row>
        <Field
          label="Affected by lighting"
          hint={
            particles.lit ? "Dark rooms hide these: smoke, gas, dust." : "Self-lit: embers, sparks."
          }
        >
          <Switch
            checked={particles.lit}
            onCheckedChange={(lit) => patch({ lit })}
            ariaLabel="Affected by lighting"
          />
        </Field>
      </Row>

      <RampEditor ramp={particles.ramp} onChange={(ramp) => patch({ ramp })} />
    </div>
  );
}
