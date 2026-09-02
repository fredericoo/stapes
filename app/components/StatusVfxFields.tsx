import type { LightDef } from "../lib/types";
import { MAX_LIGHT_LEVEL } from "../lib/lightingFlood";
import {
  DEFAULT_GLOW,
  DEFAULT_PARTICLES,
  DEFAULT_TINT,
  MAX_PARTICLE_RADIUS_PX,
  MAX_PARTICLE_RATE,
  MAX_PARTICLE_TTL_MS,
  MAX_RAMP_STOPS,
  MAX_TAPER_MS,
  type RampStop,
  type StatusParticles,
  type StatusTint,
  type StatusVfx,
} from "../lib/statusVfx";
import { Button, Input, Switch } from "../ui";

/**
 * Authoring what a status looks like.
 *
 * ## Sliders, not number fields
 *
 * Everything on a 0-to-1 scale gets a slider, and that is not decoration. A tint
 * strength is a *judgement* — the author is looking at the canvas beside this and
 * deciding when the rat looks poisoned enough — and a number field makes that a
 * cycle of type, tab, look, retype. A slider makes it one gesture with the
 * answer moving under it.
 *
 * Ranges keep number fields, because those are quantities an author reasons
 * about rather than dials they hunt for: a lifetime is "about a second", and 900
 * is easier to type than to find.
 *
 * ## Both halves are optional, and off by default
 *
 * A status with no effect authored is the state every status in the world is in,
 * so it has to be the resting state of this panel rather than something an
 * author has to zero out. Turning a half on fills it with a default that draws
 * something on the very first frame — an emitter of zeroes is a blank canvas
 * with fifteen fields beside it and no way to tell which one is the problem.
 */

/** Slider granularity for the 0-to-1 dials. Fine enough to be smooth, coarse enough to land on a round number. */
const UNIT_STEP = 0.05;

/** What a fresh ramp stop is worth, before the author moves it. */
const NEW_STOP: RampStop = { at: 0.5, color: "#fbb954" };

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-start gap-3">{children}</div>;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[11px] font-bold uppercase text-muted">{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-muted">{hint}</span> : null}
    </label>
  );
}

function NumberField({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (next: number) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        className="w-24"
        min={min}
        max={max}
        step={step}
        value={value}
        // Clamped on the way in rather than left to the schema, because the
        // schema's answer to an out-of-range number is to drop the whole status
        // — which here would mean the Save button going dark with no field
        // saying which one did it.
        onChange={(e) =>
          onChange(Math.min(max, Math.max(min, Number(e.target.value) || 0)))
        }
      />
    </Field>
  );
}

function UnitSlider({
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

function ColorField({
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
        {/* The platform's own picker rather than a swatch grid of our palette:
            the useful colours in a burn are the ones *between* two ramp entries,
            and the quantise on the preview beside this shows where they land. */}
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

/** A toggle that turns half of an effect on, filled in with something visible. */
function HalfToggle({
  label,
  on,
  onToggle,
  children,
}: {
  label: string;
  on: boolean;
  onToggle: (on: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-bold uppercase text-muted">{label}</span>
        <Switch checked={on} onCheckedChange={onToggle} ariaLabel={label} />
      </div>
      {on ? children : null}
    </div>
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
      <p className="max-w-lg text-[11px] leading-snug text-muted">
        The colour over one particle's life. One stop is a constant colour; four
        is a fire. Stops are sorted when they are drawn, so dragging one past its
        neighbour reorders the ramp rather than breaking it — and a life before
        the first stop or after the last holds that stop.
      </p>
      {ramp.map((stop, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2">
          <ColorField label={`Stop ${i + 1}`} value={stop.color} onChange={(color) => patch(i, { color })} />
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
            // The last stop cannot go: a ramp with no stops is not a colour, and
            // the schema refuses it — so the button that would produce one is
            // off rather than the Save button going dark a moment later.
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

function ParticleFields({
  particles,
  onChange,
}: {
  particles: StatusParticles;
  onChange: (next: StatusParticles) => void;
}) {
  const patch = (fields: Partial<StatusParticles>) =>
    onChange({ ...particles, ...fields });

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
        {/* Both ends kept ordered here rather than checked later, the same way
            the status duration pair is: an inverted range is malformed, and the
            editor should not be able to author one. */}
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
          onChange={(riseFrom) =>
            patch({ riseFrom, riseTo: Math.max(riseFrom, particles.riseTo) })
          }
        />
        <NumberField
          label="To"
          value={particles.riseTo}
          min={-32}
          max={32}
          step={0.25}
          onChange={(riseTo) =>
            patch({ riseTo, riseFrom: Math.min(riseTo, particles.riseFrom) })
          }
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
          label="Lit by the room"
          hint={
            particles.lit
              ? "Dark rooms hide these. Right for smoke, gas, dust."
              : "Its own light source. Right for embers and sparks."
          }
        >
          <Switch
            checked={particles.lit}
            onCheckedChange={(lit) => patch({ lit })}
            ariaLabel="Lit by the room"
          />
        </Field>
      </Row>

      <RampEditor ramp={particles.ramp} onChange={(ramp) => patch({ ramp })} />
    </div>
  );
}

export function StatusVfxFields({
  vfx,
  onChange,
}: {
  vfx: StatusVfx;
  onChange: (next: StatusVfx) => void;
}) {
  const setTint = (tint: StatusTint | null) => onChange({ ...vfx, tint });
  const setParticles = (particles: StatusParticles | null) =>
    onChange({ ...vfx, particles });
  const setLight = (light: LightDef | null) => onChange({ ...vfx, light });

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      <div className="flex flex-col gap-2">
        <NumberField
          label="Winds down over the last (ms)"
          hint={
            vfx.taperMs > 0
              ? `Full strength until ${(vfx.taperMs / 1000).toFixed(1)}s are left, then fading to nothing.`
              : "0 never fades — full strength right up to the instant it ends."
          }
          value={vfx.taperMs}
          min={0}
          max={MAX_TAPER_MS}
          step={250}
          onChange={(taperMs) => onChange({ ...vfx, taperMs })}
        />
        <p className="max-w-lg text-[11px] leading-snug text-muted">
          Time <em>left</em>, not a share of the whole — so a poison stacked to
          ten minutes fades over the same final seconds a ten-second one does.
          Everything below scales together: how many particles are born, how big
          they are, how hard the colour is worn, and how bright the light is.
        </p>
      </div>

      <HalfToggle
        label="Colour on the body"
        on={vfx.tint !== null}
        // The default rather than a zeroed block, so turning this on shows
        // something on the canvas immediately. Turning it off keeps nothing —
        // an author who wanted it back gets the default again, which is a better
        // answer than the half-finished thing they were rejecting.
        onToggle={(on) => setTint(on ? { ...DEFAULT_TINT } : null)}
      >
        {vfx.tint ? (
          <Row>
            <ColorField
              label="Colour"
              value={vfx.tint.color}
              onChange={(color) => setTint({ ...vfx.tint!, color })}
            />
            <UnitSlider
              label="Strength"
              hint="How far the sprite's colour is dragged."
              value={vfx.tint.strength}
              onChange={(strength) => setTint({ ...vfx.tint!, strength })}
            />
            <UnitSlider
              label="Keep shading"
              hint="1 is a palette swap. 0 flattens towards the colour."
              value={vfx.tint.keepLuma}
              onChange={(keepLuma) => setTint({ ...vfx.tint!, keepLuma })}
            />
          </Row>
        ) : null}
      </HalfToggle>

      <HalfToggle
        label="Particles"
        on={vfx.particles !== null}
        onToggle={(on) =>
          setParticles(on ? { ...DEFAULT_PARTICLES, ramp: [...DEFAULT_PARTICLES.ramp] } : null)
        }
      >
        {vfx.particles ? (
          <ParticleFields particles={vfx.particles} onChange={setParticles} />
        ) : null}
      </HalfToggle>

      <HalfToggle
        label="Light it casts"
        on={vfx.light !== null}
        onToggle={(on) => setLight(on ? { ...DEFAULT_GLOW } : null)}
      >
        {vfx.light ? (
          <>
            <p className="max-w-lg text-[11px] leading-snug text-muted">
              Cast by the world's own light bake, from the body carrying this —
              the same road a torch in a bag travels. It accumulates with
              everything else lighting that cell. Steady, with no flicker: a
              light that changed every frame would rebake the room every frame.
            </p>
            <Row>
              <ColorField
                label="Colour"
                value={vfx.light.color}
                onChange={(color) => setLight({ ...vfx.light!, color })}
              />
              <NumberField
                label="Radius (cells)"
                hint={`Where it reaches zero. ${MAX_LIGHT_LEVEL} is the furthest any light carries.`}
                value={vfx.light.radius}
                min={0}
                max={MAX_LIGHT_LEVEL}
                step={1}
                onChange={(radius) => setLight({ ...vfx.light!, radius })}
              />
              <UnitSlider
                label="Intensity"
                value={vfx.light.intensity}
                onChange={(intensity) => setLight({ ...vfx.light!, intensity })}
              />
            </Row>
          </>
        ) : null}
      </HalfToggle>
    </div>
  );
}
