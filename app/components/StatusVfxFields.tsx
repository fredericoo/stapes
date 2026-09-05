import type { LightDef } from "../lib/types";
import { MAX_LIGHT_LEVEL } from "../lib/lightingFlood";
import { DEFAULT_PARTICLES, type ParticleEmitterDef } from "../lib/particleVfx";
import {
  DEFAULT_GLOW,
  DEFAULT_TINT,
  MAX_TAPER_MS,
  type StatusTint,
  type StatusVfx,
} from "../lib/statusVfx";
import {
  ColorField,
  NumberField,
  ParticleFields,
  Row,
  UnitSlider,
} from "./ParticleFields";
import { FieldLabel, Switch } from "../ui";

/**
 * Authoring what a status looks like: a colour on the body, a light it casts,
 * and a plume over the tile it is standing on.
 *
 * The plume's own controls are `./ParticleFields`, because a status is no longer
 * the only thing that has one.
 *
 * ## Both halves are optional, and off by default
 *
 * A status with no effect authored is the state every status in the world is in,
 * so it has to be the resting state of this panel rather than something an
 * author has to zero out. Turning a half on fills it with a default that draws
 * something on the very first frame — an emitter of zeroes is a blank canvas
 * with fifteen fields beside it and no way to tell which one is the problem.
 */

/** A toggle that turns half of an effect on, filled in with something visible. */
function HalfToggle({
  label,
  info,
  on,
  onToggle,
  children,
}: {
  label: string;
  info?: React.ReactNode;
  on: boolean;
  onToggle: (on: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
      <div className="flex items-center gap-2">
        <FieldLabel info={info}>{label}</FieldLabel>
        <Switch checked={on} onCheckedChange={onToggle} ariaLabel={label} />
      </div>
      {on ? children : null}
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
  const setParticles = (particles: ParticleEmitterDef | null) =>
    onChange({ ...vfx, particles });
  const setLight = (light: LightDef | null) => onChange({ ...vfx, light });

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      <div className="flex flex-col gap-2">
        <NumberField
          label="Fade over the last (ms)"
          info="Time left, not a share of the whole, so a poison stacked to ten minutes fades over the same final seconds a ten-second one does. Everything below scales together: particle rate and size, tint strength, light brightness."
          hint={
            vfx.taperMs > 0
              ? `Full strength until ${(vfx.taperMs / 1000).toFixed(1)}s remain.`
              : "0 never fades."
          }
          value={vfx.taperMs}
          min={0}
          max={MAX_TAPER_MS}
          step={250}
          onChange={(taperMs) => onChange({ ...vfx, taperMs })}
        />
      </div>

      <HalfToggle
        label="Tint"
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
        label="Light"
        info="Cast by the world's light bake from the body carrying this, the same road a torch in a bag travels, and added to everything else lighting the cell. Steady: a flicker would rebake the room every frame."
        on={vfx.light !== null}
        onToggle={(on) => setLight(on ? { ...DEFAULT_GLOW } : null)}
      >
        {vfx.light ? (
          <>
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
