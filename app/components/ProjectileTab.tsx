import { useState } from "react";
import {
  DEFAULT_PROJECTILE_SPEED,
  MAX_PROJECTILE_SPEED,
  MIN_PROJECTILE_SPEED,
  type ProjectileBlock,
} from "../lib/projectile";
import { DEFAULT_IMPACT } from "../lib/particleVfx";
import { NO_VFX } from "../lib/statusVfx";
import type { Transition } from "../lib/tileTransition";
import type { TileDef, TilesetDef } from "../lib/types";
import { Button, FieldLabel, Switch } from "../ui";
import { ParticleFields } from "./ParticleFields";
import { StatField } from "./StatField";
import { type TransitionPlay, VfxPreview } from "./VfxPreview";

const SPEED_INFO =
  "Cells per second. A body walks at five, so twenty is four times walking pace and crosses six cells in about a third of a second. Everything that fires this flies it at this speed — that is the point of the projectile being its own tile.";

const HIT_INFO =
  "Thrown where it lands, and only on a blow that connected: a miss and a dodge land nothing, so neither leaves anything behind. Armour eating the damage still counts as a hit. It plays on top of the Effects tab's Disappear, which every landing plays whatever the blow came to — so this is what a shot that connected does *extra*, not instead.";

export function ProjectileTab({
  draft,
  onChange,
  tiles,
  tilesets,
}: {
  draft: TileDef;
  onChange: (next: TileDef) => void;
  tiles: TileDef[];
  tilesets: TilesetDef[];
}) {
  const [play, setPlay] = useState<TransitionPlay | null>(null);
  const block: ProjectileBlock = draft.interactions?.projectile ?? {
    cellsPerSecond: DEFAULT_PROJECTILE_SPEED,
  };

  const patch = (fields: Partial<ProjectileBlock>) =>
    onChange({
      ...draft,
      interactions: {
        ...draft.interactions,
        projectile: { ...block, ...fields },
      },
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <StatField
          label="Speed"
          info={SPEED_INFO}
          value={block.cellsPerSecond}
          min={MIN_PROJECTILE_SPEED}
          max={MAX_PROJECTILE_SPEED}
          onChange={(cellsPerSecond) => patch({ cellsPerSecond })}
          readout={describeSpeed(block.cellsPerSecond)}
        />
      </div>

      <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
        <div className="flex items-center gap-2">
          <FieldLabel info={HIT_INFO}>Hit effect</FieldLabel>
          <Switch
            checked={block.hit != null}
            onCheckedChange={(on) =>
              patch({
                hit: on ? starterHit() : undefined,
              })
            }
            ariaLabel="Hit effect"
          />
          {block.hit ? (
            <Button
              onClick={() =>
                setPlay((last) => ({
                  transition: block.hit!,
                  side: "disappear",
                  token: (last?.token ?? 0) + 1,
                }))
              }
              aria-label="Play hit effect"
            >
              Play
            </Button>
          ) : null}
        </div>
        {block.hit ? (
          <div className="flex flex-wrap items-start gap-4">
            <VfxPreview vfx={NO_VFX} tiles={tiles} tilesets={tilesets} transitionPlay={play} />
            <div className="min-w-0 flex-1 basis-80">
              <ParticleFields
                particles={block.hit.particles ?? DEFAULT_IMPACT}
                onChange={(particles) => patch({ hit: { ...block.hit!, particles } })}
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function starterHit(): Transition {
  return {
    durationMs: 100,
    particles: { ...DEFAULT_IMPACT, ramp: [...DEFAULT_IMPACT.ramp] },
  };
}

function describeSpeed(cellsPerSecond: number): string {
  const perCell = 1000 / cellsPerSecond;
  return `A cell every ${Math.round(perCell)}ms. A body walks one every 200ms.`;
}
