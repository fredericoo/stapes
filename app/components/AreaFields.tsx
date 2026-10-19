import { useState } from "react";
import {
  type AreaShape,
  type AreaSubject,
  areaOffsets,
  MAX_AREA_RADIUS,
  MIN_AREA_RADIUS,
} from "../lib/area";
import {
  type AreaBurst,
  MAX_PERCENT_STAT,
  MAX_REACH_HEIGHT,
  MAX_SPELL_DAMAGE,
  MIN_PERCENT_STAT,
  type SpellArea,
} from "../lib/item";
import { DEFAULT_IMPACT } from "../lib/particleVfx";
import type { StatusDef } from "../lib/status";
import { NO_VFX } from "../lib/statusVfx";
import {
  burstParticleCount,
  MAX_BURST_PARTICLES,
  MAX_TRANSITION_MS,
  MIN_TRANSITION_MS,
} from "../lib/tileTransition";
import type { TileDef, TilesetDef } from "../lib/types";
import { Button, FieldLabel, Segmented, Switch, SwitchField } from "../ui";
import { ParticleFields } from "./ParticleFields";
import { StatField } from "./StatField";
import { StatusCures } from "./StatusCures";
import { StatusGrants } from "./StatusGrants";
import { type TransitionPlay, VfxPreview } from "./VfxPreview";

const SHAPE_OPTIONS: Array<{ value: AreaShape; label: string }> = [
  { value: "circle", label: "Circle" },
  { value: "square", label: "Square" },
  { value: "cross", label: "Cross" },
  { value: "diagonal-cross", label: "Diagonal" },
];

const AFFECTS_OPTIONS: Array<{ value: AreaSubject; label: string }> = [
  { value: "others", label: "Others" },
  { value: "self", label: "Caster" },
  { value: "both", label: "Both" },
];

const STARTER_AREA: SpellArea = {
  shape: "circle",
  radius: 2,
  height: 2,
  affects: "others",
  throughWalls: false,
  damage: 10,
};

const STARTER_BURST_MS = 400;

const DEFAULT_AREA_STATUS_CHANCE = 100;

const MS_PER_SECOND = 1000;

const BURST_STEP_S = 0.1;

const AREA_INFO =
  "Lands on every body in a shape around where the bolt lands: the caster for a bolt on the caster, the target for one on a target. The target is inside its own area, so it takes the bolt and the area both. Each body gets its own damage roll.";

const BURST_INFO =
  "Particles thrown on every cell the area covered when it lands. The rate is for the whole area and is shared between its cells, so a bigger area is not a heavier one. While the spell winds up, the cells it will cover are marked on the ground.";

export function AreaFields({
  area,
  onChange,
  statusDefs,
  tiles,
  tilesets,
}: {
  area: SpellArea | undefined;
  onChange: (area: SpellArea | undefined) => void;
  statusDefs: Record<string, StatusDef>;
  tiles: TileDef[];
  tilesets?: TilesetDef[];
}) {
  return (
    <div className="flex flex-col gap-3 border-t-2 border-border pt-3">
      <div className="flex items-center gap-2">
        <FieldLabel info={AREA_INFO}>Area</FieldLabel>
        <Switch
          checked={area !== undefined}
          onCheckedChange={(on) => onChange(on ? { ...STARTER_AREA } : undefined)}
          ariaLabel="Area"
        />
      </div>
      {area ? (
        <AreaBody
          area={area}
          onChange={onChange}
          statusDefs={statusDefs}
          tiles={tiles}
          tilesets={tilesets}
        />
      ) : null}
    </div>
  );
}

function AreaBody({
  area,
  onChange,
  statusDefs,
  tiles,
  tilesets,
}: {
  area: SpellArea;
  onChange: (area: SpellArea) => void;
  statusDefs: Record<string, StatusDef>;
  tiles: TileDef[];
  tilesets?: TilesetDef[];
}) {
  const patch = (fields: Partial<SpellArea>) => onChange({ ...area, ...fields });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex flex-col gap-1 text-xs">
          <FieldLabel info="Which cells around the centre it covers, out to the radius.">
            Shape
          </FieldLabel>
          <Segmented<AreaShape>
            value={area.shape}
            onChange={(shape) => patch({ shape })}
            options={SHAPE_OPTIONS}
            size="sm"
            ariaLabel="Area shape"
          />
        </div>
        <div className="flex flex-col gap-1 text-xs">
          <FieldLabel info="Others: everybody but the caster. Caster: only the caster, if they stand inside it. Both: everybody inside it. A harmful area skips anybody the caster may not harm.">
            Affects
          </FieldLabel>
          <Segmented<AreaSubject>
            value={area.affects}
            onChange={(affects) => patch({ affects })}
            options={AFFECTS_OPTIONS}
            size="sm"
            ariaLabel="Who the area affects"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <StatField
          label="Radius"
          info="How many cells out from the centre it reaches."
          value={area.radius}
          min={MIN_AREA_RADIUS}
          max={MAX_AREA_RADIUS}
          onChange={(radius) => patch({ radius })}
          readout={`${areaOffsets(area.shape, area.radius).length} cells.`}
        />
        <StatField
          label="Height"
          info="Height units up or down from the centre, four to a level, as a stone's reach."
          value={area.height}
          min={0}
          max={MAX_REACH_HEIGHT}
          step={0.5}
          onChange={(height) => patch({ height })}
        />
        <StatField
          label="Damage"
          info="Health it moves on each body, separate from the bolt's own. Negative mends, positive harms."
          value={area.damage ?? 0}
          min={-MAX_SPELL_DAMAGE}
          max={MAX_SPELL_DAMAGE}
          onChange={(damage) => patch({ damage: damage || undefined })}
        />
        <StatField
          label="Variance"
          info="How much one body's share varies, as a share of the damage."
          value={area.variance ?? 0}
          min={MIN_PERCENT_STAT}
          max={MAX_PERCENT_STAT}
          onChange={(variance) => patch({ variance: variance || undefined })}
        />
      </div>

      <SwitchField
        checked={area.throughWalls}
        onCheckedChange={(throughWalls) => patch({ throughWalls })}
        label="Through walls"
        info="On: every body in the shape is reached. Off: a body needs a clear line from the centre, so standing behind a wall is safe."
      />

      <StatusGrants
        statuses={area.statuses ?? []}
        statusDefs={statusDefs}
        onChange={(statuses) => patch({ statuses: statuses.length ? statuses : undefined })}
        blank={(id) => ({ id, chance: DEFAULT_AREA_STATUS_CHANCE })}
        info="Rolled once per entry for each body the area reaches. An area needs damage, a status or a cure."
      />

      <StatusCures
        cures={area.cures ?? []}
        statusDefs={statusDefs}
        onChange={(cures) => patch({ cures: cures.length ? cures : undefined })}
        info="Taken off each body the area reaches, after its health moves."
      />

      <BurstFields
        cells={areaOffsets(area.shape, area.radius).length}
        burst={area.burst}
        onChange={(burst) => patch({ burst })}
        tiles={tiles}
        tilesets={tilesets}
      />
    </div>
  );
}

function BurstFields({
  cells,
  burst,
  onChange,
  tiles,
  tilesets,
}: {
  cells: number;
  burst: AreaBurst | undefined;
  onChange: (burst: AreaBurst | undefined) => void;
  tiles: TileDef[];
  tilesets?: TilesetDef[];
}) {
  const [play, setPlay] = useState<TransitionPlay | null>(null);
  const overBudget =
    burst &&
    burstParticleCount(burst.particles.ratePerSecond, burst.durationMs) > MAX_BURST_PARTICLES;

  return (
    <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
      <div className="flex items-center gap-2">
        <FieldLabel info={BURST_INFO}>Burst</FieldLabel>
        <Switch
          checked={burst !== undefined}
          onCheckedChange={(on) => onChange(on ? starterBurst() : undefined)}
          ariaLabel="Area burst"
        />
        {burst && tilesets ? (
          <Button
            onClick={() =>
              setPlay((last) => ({
                transition: oneCellOf(burst, cells),
                side: "disappear",
                token: (last?.token ?? 0) + 1,
              }))
            }
            aria-label="Play burst on one cell"
          >
            Play
          </Button>
        ) : null}
      </div>
      {burst ? (
        <div className="flex flex-col gap-3">
          <StatField
            label="Length (s)"
            info="How long the burst keeps throwing particles."
            value={burst.durationMs / MS_PER_SECOND}
            min={MIN_TRANSITION_MS / MS_PER_SECOND}
            max={MAX_TRANSITION_MS / MS_PER_SECOND}
            step={BURST_STEP_S}
            onChange={(seconds) => onChange({ ...burst, durationMs: seconds * MS_PER_SECOND })}
          />
          {overBudget ? (
            <p className="text-[11px] text-danger">
              Too many particles: lower the rate or shorten the burst.
            </p>
          ) : null}
          <div className="flex flex-wrap items-start gap-4">
            {tilesets ? (
              <VfxPreview vfx={NO_VFX} tiles={tiles} tilesets={tilesets} transitionPlay={play} />
            ) : null}
            <div className="min-w-0 flex-1 basis-80">
              <ParticleFields
                particles={burst.particles}
                onChange={(particles) => onChange({ ...burst, particles })}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** What a single cell of the area throws, since the rate is shared out between them all. */
function oneCellOf(burst: AreaBurst, cells: number): AreaBurst {
  return {
    ...burst,
    particles: { ...burst.particles, ratePerSecond: burst.particles.ratePerSecond / cells },
  };
}

function starterBurst(): AreaBurst {
  return {
    durationMs: STARTER_BURST_MS,
    particles: { ...DEFAULT_IMPACT, ramp: [...DEFAULT_IMPACT.ramp] },
  };
}
