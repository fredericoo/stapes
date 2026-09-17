import {
  DEFAULT_PROJECTILE_SPEED,
  MAX_PROJECTILE_SPEED,
  MIN_PROJECTILE_SPEED,
  type ProjectileBlock,
} from "../lib/projectile";
import { DEFAULT_IMPACT } from "../lib/particleVfx";
import type { Transition } from "../lib/tileTransition";
import type { TileDef } from "../lib/types";
import { FieldLabel, Switch } from "../ui";
import { ParticleFields } from "./ParticleFields";
import { StatField } from "./StatField";

/**
 * How a projectile flies, and what it leaves where it connects.
 *
 * **Shown by the kind rather than by the block**, on exactly the terms the
 * Battle and Item tabs are: only `kind: "projectile"` opens it, so no wall or
 * crate grows a speed field it can never use, and a block left behind on a tile
 * that has stopped being a projectile is inert rather than quietly in charge.
 * See `../lib/projectile`'s `resolveProjectile`.
 *
 * ## Two of the three sides are not here, deliberately
 *
 * A flight plays `appear` when it is loosed and, where it stops, either `hit`
 * or `disappear`. The first two are the tile's own transitions and are authored
 * on the **Effects** tab, which every tile already has — `appear` and
 * `disappear` mean there what they mean here, a thing arriving and a thing
 * going, and a flight arrives when it is loosed and goes when it lands.
 *
 * Only `hit` is here, because only `hit` is a claim about the *fight*: it plays
 * where a shot that connected lands, and a miss or a dodge leaves nothing. That
 * is the one thing about a projectile the rest of the editor cannot express.
 */

const SPEED_INFO =
  "Cells per second. A body walks at five, so twenty is four times walking pace and crosses six cells in about a third of a second. Everything that fires this flies it at this speed — that is the point of the projectile being its own tile.";

const HIT_INFO =
  "Thrown where it lands, and only on a blow that connected: a miss and a dodge land nothing, so neither leaves anything behind. Armour eating the damage still counts as a hit. Leave it off and a landing plays the Effects tab's Disappear instead, whatever the blow came to.";

export function ProjectileTab({
  draft,
  onChange,
}: {
  draft: TileDef;
  onChange: (next: TileDef) => void;
}) {
  // Read off the draft rather than through `resolveProjectile`, because the
  // draft is the *authored* block and the resolver gates on a kind the author
  // may be in the middle of choosing. The tab is only open for a projectile
  // anyway — see the dialog's tab list.
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
                // The burst preset rather than the plume one, and its ramp
                // copied rather than shared — the same care every other fresh
                // emitter in the editor is opened with.
                hit: on ? starterHit() : undefined,
              })
            }
            ariaLabel="Hit effect"
          />
        </div>
        {block.hit ? (
          <ParticleFields
            particles={block.hit.particles ?? DEFAULT_IMPACT}
            onChange={(particles) =>
              patch({ hit: { ...block.hit!, particles } })
            }
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * What a fresh hit effect opens on.
 *
 * Long enough to be a burst rather than a frame, and short enough to read as
 * one event: the emitter is handed over for this long and then stops, and the
 * particles already in the air finish their own lifetimes on top of it.
 */
function starterHit(): Transition {
  return {
    durationMs: 140,
    particles: { ...DEFAULT_IMPACT, ramp: [...DEFAULT_IMPACT.ramp] },
  };
}

/** What this speed means in the unit an author can check it against. */
function describeSpeed(cellsPerSecond: number): string {
  const perCell = 1000 / cellsPerSecond;
  return `A cell every ${Math.round(perCell)}ms. A body walks one every 200ms.`;
}
