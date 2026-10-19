import type { StatusDef } from "../lib/status";
import { FieldLabel, Toggle } from "../ui";

const CURES_INFO =
  "Taken off whoever it landed on, after the health moves and before any status above is rolled. A body the cast killed keeps nothing to cure.";

export function StatusCures({
  cures,
  statusDefs,
  onChange,
  info = CURES_INFO,
}: {
  cures: string[];
  statusDefs: Record<string, StatusDef>;
  onChange: (cures: string[]) => void;
  info?: string;
}) {
  const catalogue = Object.values(statusDefs);
  const toggle = (id: string, on: boolean) =>
    onChange(
      catalogue
        .map((def) => def.id)
        .filter((candidate) => (candidate === id ? on : cures.includes(candidate))),
    );

  return (
    <div className="flex flex-col gap-1.5 border-t-2 border-border pt-3">
      <FieldLabel info={info}>Cures</FieldLabel>
      <div className="flex flex-wrap gap-2">
        {catalogue.map((def) => (
          <Toggle
            key={def.id}
            size="sm"
            variant="secondary"
            pressed={cures.includes(def.id)}
            onPressedChange={(on) => toggle(def.id, on)}
            ariaLabel={`Cures ${def.name}`}
          >
            {def.name}
          </Toggle>
        ))}
      </div>
    </div>
  );
}
