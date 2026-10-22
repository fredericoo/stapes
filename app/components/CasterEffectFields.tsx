import { useState } from "react";
import { DEFAULT_IMPACT } from "../lib/particleVfx";
import { NO_VFX } from "../lib/statusVfx";
import {
  burstParticleCount,
  MAX_BURST_PARTICLES,
  MAX_TRANSITION_MS,
  MIN_TRANSITION_MS,
  type Transition,
} from "../lib/tileTransition";
import type { TileDef, TilesetDef } from "../lib/types";
import { Button, FieldLabel, Switch } from "../ui";
import { ParticleFields } from "./ParticleFields";
import { StatField } from "./StatField";
import { type TransitionPlay, VfxPreview } from "./VfxPreview";

const STARTER_EFFECT_MS = 600;

const MS_PER_SECOND = 1000;

const LENGTH_STEP_S = 0.1;

const CASTER_EFFECT_INFO =
  "Particles thrown on the caster the moment the spell goes off, whoever it lands on. Drawn to the caster's size. A cast that was broken or refused plays nothing.";

export function CasterEffectFields({
  effect,
  onChange,
  tiles,
  tilesets,
}: {
  effect: Transition | undefined;
  onChange: (effect: Transition | undefined) => void;
  tiles: TileDef[];
  tilesets?: TilesetDef[];
}) {
  const [play, setPlay] = useState<TransitionPlay | null>(null);
  const overBudget =
    effect?.particles &&
    burstParticleCount(effect.particles.ratePerSecond, effect.durationMs) > MAX_BURST_PARTICLES;

  return (
    <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
      <div className="flex items-center gap-2">
        <FieldLabel info={CASTER_EFFECT_INFO}>Caster effect</FieldLabel>
        <Switch
          checked={effect !== undefined}
          onCheckedChange={(on) => onChange(on ? starterEffect() : undefined)}
          ariaLabel="Caster effect"
        />
        {effect && tilesets ? (
          <Button
            onClick={() =>
              setPlay((last) => ({
                transition: effect,
                side: "appear",
                token: (last?.token ?? 0) + 1,
              }))
            }
            aria-label="Play caster effect"
          >
            Play
          </Button>
        ) : null}
      </div>
      {effect ? (
        <div className="flex flex-col gap-3">
          <StatField
            label="Length (s)"
            info="How long the effect keeps throwing particles."
            value={effect.durationMs / MS_PER_SECOND}
            min={MIN_TRANSITION_MS / MS_PER_SECOND}
            max={MAX_TRANSITION_MS / MS_PER_SECOND}
            step={LENGTH_STEP_S}
            onChange={(seconds) => onChange({ ...effect, durationMs: seconds * MS_PER_SECOND })}
          />
          {overBudget ? (
            <p className="text-[11px] text-danger">
              Too many particles: lower the rate or shorten the effect.
            </p>
          ) : null}
          <div className="flex flex-wrap items-start gap-4">
            {tilesets ? (
              <VfxPreview vfx={NO_VFX} tiles={tiles} tilesets={tilesets} transitionPlay={play} />
            ) : null}
            <div className="min-w-0 flex-1 basis-80">
              <ParticleFields
                particles={effect.particles ?? DEFAULT_IMPACT}
                onChange={(particles) => onChange({ ...effect, particles })}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function starterEffect(): Transition {
  return {
    durationMs: STARTER_EFFECT_MS,
    particles: { ...DEFAULT_IMPACT, ramp: [...DEFAULT_IMPACT.ramp] },
  };
}
