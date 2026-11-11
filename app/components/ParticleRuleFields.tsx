import { MAX_HOUR_OF_DAY } from "../lib/clock";
import { MAX_PARTICLE_ONE_IN, type TileParticleRule } from "../lib/particleRule";
import { FieldLabel, Switch } from "../ui";
import { NumberField, Row } from "./ParticleFields";

const DEFAULT_RULE: TileParticleRule = { oneIn: 6 };
const DEFAULT_HOURS = { from: 20, to: 5 };

export function ParticleRuleFields({
  rule,
  onChange,
}: {
  rule: TileParticleRule | undefined;
  onChange: (next: TileParticleRule | undefined) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <FieldLabel info="For a tile laid by the hundred, such as a tree or a swamp plant: only some placements on the board give off the particles, and only at some hours. Without this, every placement emits all day, and a screen full of them uses up the particle budget.">
          Only some placements, some hours
        </FieldLabel>
        <Switch
          checked={rule != null}
          onCheckedChange={(on) => onChange(on ? { ...DEFAULT_RULE } : undefined)}
          ariaLabel="Only some placements, some hours"
        />
      </div>
      {rule ? (
        <>
          <Row>
            <NumberField
              label="One placement in"
              info="6 means about one placement in six emits. Which ones is fixed by where they stand, so it is the same for every player."
              value={rule.oneIn}
              min={1}
              max={MAX_PARTICLE_ONE_IN}
              step={1}
              onChange={(oneIn) => onChange({ ...rule, oneIn })}
            />
          </Row>
          <div className="flex items-center gap-2">
            <FieldLabel info="The hours of the game's day it emits in. A start after the end runs through midnight: 20 to 5 is the night.">
              Only between hours
            </FieldLabel>
            <Switch
              checked={rule.hours != null}
              onCheckedChange={(on) =>
                onChange({ ...rule, hours: on ? { ...DEFAULT_HOURS } : undefined })
              }
              ariaLabel="Only between hours"
            />
          </div>
          {rule.hours ? (
            <Row>
              <NumberField
                label="From hour"
                value={rule.hours.from}
                min={0}
                max={MAX_HOUR_OF_DAY}
                step={1}
                onChange={(from) => onChange({ ...rule, hours: { ...rule.hours!, from } })}
              />
              <NumberField
                label="To hour"
                value={rule.hours.to}
                min={0}
                max={MAX_HOUR_OF_DAY}
                step={1}
                onChange={(to) => onChange({ ...rule, hours: { ...rule.hours!, to } })}
              />
            </Row>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
