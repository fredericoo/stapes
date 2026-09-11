import { useState } from "react";
import { DEFAULT_PARTICLES, type ParticleEmitterDef } from "../lib/particleVfx";
import type { StatusVfx } from "../lib/statusVfx";
import {
  burstParticleCount,
  DEFAULT_CLUMP_PX,
  MAX_BURST_PARTICLES,
  MAX_CLUMP_PX,
  MAX_DROP_LEVELS,
  MAX_EDGE_WIDTH,
  MAX_SWEEP_ORIGIN_CELLS,
  MAX_TRANSITION_MS,
  MIN_CLUMP_PX,
  MIN_TRANSITION_MS,
  type TileTransitions,
  type Transition,
  type TransitionSide,
} from "../lib/tileTransition";
import type { TileDef, TilesetDef } from "../lib/types";
import { Button, FieldLabel, Segmented, Switch, SwitchField } from "../ui";
import { ColorField, NumberField, ParticleFields, Row } from "./ParticleFields";
import { VfxPreview, type TransitionPlay } from "./VfxPreview";

/**
 * How a tile arrives and how it leaves, authored beside a preview that plays it.
 *
 * Its own tab rather than more of the Tile tab, which already carries the art,
 * the light and the plume: this is two small forms that most tiles never open,
 * and the dot on the tab says whether this one has. See `../lib/tileTransition`
 * for what each field means to the shader.
 *
 * Every number is held to the schema's own range here, because the schema's
 * answer to an out-of-range value is to drop the whole side on load — which
 * would read as the effect silently vanishing, with no field saying why.
 */

type Dissolve = NonNullable<Transition["dissolve"]>;

const DEFAULT_DURATION_MS = 700;
const DURATION_STEP_MS = 50;
const DEFAULT_EDGE_WIDTH = 0.15;
const EDGE_WIDTH_STEP = 0.05;
/** Half-cell steps, so a sweep can start from an edge as well as a corner. */
const SWEEP_ORIGIN_STEP = 0.5;
const DEFAULT_SWEEP_FROM = { x: -1, y: -1 };

/**
 * A cold edge coming in and an ember going out — the pair the arcane flame was
 * authored with, and a starting point that already reads as a direction.
 */
const DEFAULT_EDGE_COLOR: Record<TransitionSide, string> = {
  appear: "#8ce6ff",
  disappear: "#ff9e40",
};

const PATTERNS: Array<{ value: Dissolve["pattern"]; label: string }> = [
  { value: "noise", label: "Noise" },
  { value: "sweep", label: "Sweep" },
  { value: "dither", label: "Dither" },
];

const SIDES: Array<{ side: TransitionSide; title: string; info: string }> = [
  {
    side: "appear",
    title: "Appear",
    info: "Played when this tile arrives for a reason the world names: a conjure, or a decay that turns something into it. Placing it in the editor, dropping it or respawning it plays nothing.",
  },
  {
    side: "disappear",
    title: "Disappear",
    info: "Played when this tile decays away. Picking it up or moving it plays nothing. Its light fades with it.",
  },
];

function defaultDissolve(side: TransitionSide): Dissolve {
  return {
    pattern: "noise",
    clumpPx: DEFAULT_CLUMP_PX,
    edgeColor: DEFAULT_EDGE_COLOR[side],
    edgeWidth: DEFAULT_EDGE_WIDTH,
  };
}

const DEFAULT_DROP_LEVELS = 2;

/** How many particles a burst spends over the whole transition. */
function burstCost(burst: ParticleEmitterDef, durationMs: number): number {
  return burstParticleCount(burst.ratePerSecond, durationMs);
}

/**
 * The default plume as a burst, slowed if need be to fit the budget over this
 * duration — so switching one on never authors a side the schema would drop.
 */
function defaultBurst(durationMs: number): ParticleEmitterDef {
  // What one particle a second costs over this duration, into the budget.
  const affordable = Math.floor(
    MAX_BURST_PARTICLES / burstParticleCount(1, durationMs),
  );
  return {
    ...DEFAULT_PARTICLES,
    ramp: [...DEFAULT_PARTICLES.ramp],
    ratePerSecond: Math.min(DEFAULT_PARTICLES.ratePerSecond, affordable),
  };
}

function defaultTransition(side: TransitionSide): Transition {
  return { durationMs: DEFAULT_DURATION_MS, dissolve: defaultDissolve(side) };
}

type Props = {
  draft: TileDef;
  onChange: (next: TileDef) => void;
  tilesets: TilesetDef[];
  /** The dialog's steady copy of the draft's art. @see TileEditorDialog */
  previewSubject: TileDef;
  /** The tile's own plume, so a flame is previewed smoking as it does in play. */
  previewVfx: StatusVfx;
};

export function EffectsTab({
  draft,
  onChange,
  tilesets,
  previewSubject,
  previewVfx,
}: Props) {
  const [play, setPlay] = useState<TransitionPlay | null>(null);

  const setSide = (side: TransitionSide, next: Transition | undefined) => {
    const transitions: TileTransitions = { ...draft.transitions };
    if (next) transitions[side] = next;
    else delete transitions[side];
    onChange({
      ...draft,
      transitions:
        transitions.appear || transitions.disappear ? transitions : undefined,
    });
  };

  return (
    <div className="flex flex-wrap items-start gap-4">
      <VfxPreview
        vfx={previewVfx}
        tilesets={tilesets}
        subject={previewSubject}
        transitionPlay={play}
      />
      <div className="flex min-w-0 flex-1 basis-80 flex-col gap-4">
        {SIDES.map(({ side, title, info }) => (
          <TransitionSection
            key={side}
            side={side}
            title={title}
            info={info}
            transition={draft.transitions?.[side]}
            onChange={(next) => setSide(side, next)}
            onPlay={(transition) =>
              setPlay((last) => ({
                transition,
                side,
                token: (last?.token ?? 0) + 1,
              }))
            }
          />
        ))}
      </div>
    </div>
  );
}

function TransitionSection({
  side,
  title,
  info,
  transition,
  onChange,
  onPlay,
}: {
  side: TransitionSide;
  title: string;
  info: string;
  transition: Transition | undefined;
  onChange: (next: Transition | undefined) => void;
  onPlay: (transition: Transition) => void;
}) {
  const patch = (fields: Partial<Transition>) => {
    if (transition) onChange({ ...transition, ...fields });
  };
  const doesNothing =
    transition &&
    !transition.dissolve &&
    !transition.scale &&
    !transition.drop &&
    !transition.particles;
  const overBudget =
    transition?.particles !== undefined &&
    burstCost(transition.particles, transition.durationMs) > MAX_BURST_PARTICLES;

  return (
    <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
      <div className="flex items-center justify-between gap-2">
        <SwitchField
          checked={Boolean(transition)}
          onCheckedChange={(on) =>
            onChange(on ? defaultTransition(side) : undefined)
          }
          label={title}
          info={info}
          size="section"
        />
        {transition ? (
          <Button onClick={() => onPlay(transition)} aria-label={`Play ${title}`}>
            Play
          </Button>
        ) : null}
      </div>

      {transition ? (
        <div className="flex flex-col gap-3 border-t-2 border-border pt-3 text-xs">
          <Row>
            <NumberField
              label="Duration (ms)"
              info="How long the whole effect takes. Every effect below runs over the same time."
              value={transition.durationMs}
              min={MIN_TRANSITION_MS}
              max={MAX_TRANSITION_MS}
              step={DURATION_STEP_MS}
              onChange={(durationMs) => patch({ durationMs })}
            />
          </Row>

          <DissolveFields
            side={side}
            title={title}
            dissolve={transition.dissolve}
            onChange={(dissolve) => patch({ dissolve })}
          />

          <div className="flex items-center gap-2">
            <FieldLabel info="Grows out of the middle of the cell it stands on as it arrives, and shrinks back into it as it goes — whole art pixels at a time, never smaller ones.">
              Scale
            </FieldLabel>
            <Switch
              checked={Boolean(transition.scale)}
              onCheckedChange={(on) => patch({ scale: on ? {} : undefined })}
              ariaLabel={`Scale on ${title}`}
            />
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <FieldLabel info="Falls in from whole storeys above its cell as it arrives, or rises out as it goes. It is drawn and sorted as something above its own cell the whole way, so it passes in front of what it should.">
                Drop
              </FieldLabel>
              <Switch
                checked={Boolean(transition.drop)}
                onCheckedChange={(on) =>
                  patch({ drop: on ? { levels: DEFAULT_DROP_LEVELS } : undefined })
                }
                ariaLabel={`Drop on ${title}`}
              />
            </div>
            {transition.drop ? (
              <Row>
                <NumberField
                  label="From (storeys up)"
                  value={transition.drop.levels}
                  min={1}
                  max={MAX_DROP_LEVELS}
                  step={1}
                  onChange={(levels) => patch({ drop: { levels } })}
                />
              </Row>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <FieldLabel info="Particles given off from the tile's cell for as long as the transition runs, after every other plume on screen — so a crowded screen thins a burst before it thins a fire.">
                Burst
              </FieldLabel>
              <Switch
                checked={Boolean(transition.particles)}
                onCheckedChange={(on) =>
                  patch({
                    particles: on ? defaultBurst(transition.durationMs) : undefined,
                  })
                }
                ariaLabel={`Burst on ${title}`}
              />
            </div>
            {transition.particles ? (
              <>
                <ParticleFields
                  particles={transition.particles}
                  onChange={(particles) => patch({ particles })}
                />
                <p className="text-[11px] text-muted">
                  {overBudget
                    ? `Spends ${Math.round(burstCost(transition.particles, transition.durationMs))} particles, over the ${MAX_BURST_PARTICLES} one burst may: lower the rate or the duration, or this side is dropped when the tile loads.`
                    : `Spends ${Math.round(burstCost(transition.particles, transition.durationMs))} of the ${MAX_BURST_PARTICLES} particles one burst may.`}
                </p>
              </>
            ) : null}
          </div>

          {doesNothing ? (
            <p className="text-[11px] text-muted">
              Nothing plays: turn on at least one effect, or this side is
              dropped when the tile loads.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function DissolveFields({
  side,
  title,
  dissolve,
  onChange,
}: {
  side: TransitionSide;
  /** The side's heading, so every switch in it is named the same way. */
  title: string;
  dissolve: Dissolve | undefined;
  onChange: (next: Dissolve | undefined) => void;
}) {
  const from = dissolve?.from ?? DEFAULT_SWEEP_FROM;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <FieldLabel info="Pixels come in, or go, one at a time. Noise takes them in clumps, a sweep takes them outward from a point, and dither takes them in an even pattern that reads as a fade.">
          Dissolve
        </FieldLabel>
        <Switch
          checked={Boolean(dissolve)}
          onCheckedChange={(on) => onChange(on ? defaultDissolve(side) : undefined)}
          ariaLabel={`Dissolve on ${title}`}
        />
      </div>

      {dissolve ? (
        <>
          <Segmented
            size="sm"
            ariaLabel="Dissolve pattern"
            value={dissolve.pattern}
            options={PATTERNS}
            onChange={(pattern) =>
              onChange({
                ...dissolve,
                pattern,
                // A sweep cannot be saved without somewhere to start, so one is
                // filled in the moment it is picked rather than left to fail.
                from: pattern === "sweep" ? from : dissolve.from,
              })
            }
          />
          <Row>
            {dissolve.pattern === "sweep" ? (
              <>
                <NumberField
                  label="From x (cells)"
                  info="Where the front starts, measured from the middle of the sprite. Negative is west."
                  value={from.x}
                  min={-MAX_SWEEP_ORIGIN_CELLS}
                  max={MAX_SWEEP_ORIGIN_CELLS}
                  step={SWEEP_ORIGIN_STEP}
                  onChange={(x) => onChange({ ...dissolve, from: { ...from, x } })}
                />
                <NumberField
                  label="From y (cells)"
                  info="Where the front starts, measured from the middle of the sprite. Negative is north."
                  value={from.y}
                  min={-MAX_SWEEP_ORIGIN_CELLS}
                  max={MAX_SWEEP_ORIGIN_CELLS}
                  step={SWEEP_ORIGIN_STEP}
                  onChange={(y) => onChange({ ...dissolve, from: { ...from, y } })}
                />
              </>
            ) : null}
            {dissolve.pattern === "noise" ? (
              <NumberField
                label="Clump (px)"
                info="How big the patches that go together are, in art pixels. 1 is single pixels."
                value={dissolve.clumpPx}
                min={MIN_CLUMP_PX}
                max={MAX_CLUMP_PX}
                step={1}
                onChange={(clumpPx) => onChange({ ...dissolve, clumpPx })}
              />
            ) : null}
          </Row>
          <Row>
            <ColorField
              label="Edge colour"
              value={dissolve.edgeColor}
              onChange={(edgeColor) => onChange({ ...dissolve, edgeColor })}
            />
            <NumberField
              label="Edge width"
              info="How thick the glowing band at the front is. 0 is no band."
              value={dissolve.edgeWidth}
              min={0}
              max={MAX_EDGE_WIDTH}
              step={EDGE_WIDTH_STEP}
              onChange={(edgeWidth) => onChange({ ...dissolve, edgeWidth })}
            />
          </Row>
        </>
      ) : null}
    </div>
  );
}
