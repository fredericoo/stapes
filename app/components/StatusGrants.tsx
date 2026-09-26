import type { ReactNode } from "react";
import { MAX_PERCENT_STAT, MIN_PERCENT_STAT, type StatusGrant } from "../lib/item";
import type { StatusDef } from "../lib/status";
import { Button, FieldLabel, NumberInput, Select, Switch } from "../ui";

const MS_PER_SECOND = 1000;

type Props<Grant extends StatusGrant> = {
  statuses: Grant[];
  statusDefs: Record<string, StatusDef>;
  onChange: (next: Grant[]) => void;
  info: ReactNode;
  blank: (id: string) => Grant;
  certainAllowed?: boolean;
};

export function StatusGrants<Grant extends StatusGrant>({
  statuses,
  statusDefs,
  onChange,
  info,
  blank,
  certainAllowed = false,
}: Props<Grant>) {
  const catalogue = Object.values(statusDefs);
  const options = catalogue.map((def) => ({ value: def.id, label: def.name }));

  const patchAt = (index: number, fields: Partial<Grant>) =>
    onChange(statuses.map((entry, i) => (i === index ? { ...entry, ...fields } : entry)));

  return (
    <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
      <FieldLabel info={info}>Statuses</FieldLabel>

      {catalogue.length === 0 ? (
        <p className="text-[11px] text-muted">None authored — see the Statuses page.</p>
      ) : null}

      {statuses.map((entry, index) => {
        const def = statusDefs[entry.id];
        const overriding = entry.fromMs !== undefined && entry.toMs !== undefined;
        return (
          <div
            key={`${entry.id}-${index}`}
            className="flex flex-wrap items-end gap-2 border-2 border-border p-2"
          >
            <label className="flex flex-col gap-0.5 text-xs">
              <FieldLabel>Status</FieldLabel>
              <Select
                value={entry.id || null}
                onValueChange={(id) => id && patchAt(index, { id } as Partial<Grant>)}
                options={options}
              />
            </label>

            <StatusChance
              entry={entry}
              certainAllowed={certainAllowed}
              patch={(fields) => patchAt(index, fields)}
            />

            <label className="flex flex-col gap-0.5 text-xs">
              <FieldLabel info="Off, the status's own duration applies. On, both ends are this granter's.">
                Override duration
              </FieldLabel>
              <Switch
                checked={overriding}
                ariaLabel="Override duration"
                onCheckedChange={(on) =>
                  patchAt(
                    index,
                    (on
                      ? { fromMs: def?.fromMs ?? 0, toMs: def?.toMs ?? 0 }
                      : { fromMs: undefined, toMs: undefined }) as Partial<Grant>,
                  )
                }
              />
            </label>

            {overriding ? (
              <>
                <label className="flex flex-col gap-0.5 text-xs">
                  <FieldLabel>From (ms)</FieldLabel>
                  <NumberInput
                    className="w-28"
                    min={0}
                    step={1}
                    value={entry.fromMs ?? 0}
                    onChange={(fromMs) =>
                      patchAt(index, {
                        fromMs,
                        toMs: Math.max(fromMs, entry.toMs ?? fromMs),
                      } as Partial<Grant>)
                    }
                  />
                </label>
                <label className="flex flex-col gap-0.5 text-xs">
                  <FieldLabel>To (ms)</FieldLabel>
                  <NumberInput
                    className="w-28"
                    min={0}
                    step={1}
                    value={entry.toMs ?? 0}
                    onChange={(toMs) =>
                      patchAt(index, {
                        toMs,
                        fromMs: Math.min(toMs, entry.fromMs ?? toMs),
                      } as Partial<Grant>)
                    }
                  />
                </label>
              </>
            ) : (
              <span className="text-[11px] text-muted">
                {def
                  ? `${(def.fromMs / MS_PER_SECOND).toFixed(0)}–${(def.toMs / MS_PER_SECOND).toFixed(0)}s (status default)`
                  : "Unknown status — skipped."}
              </span>
            )}

            <Button
              className="ml-auto"
              onClick={() => onChange(statuses.filter((_, i) => i !== index))}
            >
              Remove
            </Button>
          </div>
        );
      })}

      <Button
        className="self-start"
        disabled={catalogue.length === 0}
        onClick={() => onChange([...statuses, blank(catalogue[0]!.id)])}
      >
        Add status
      </Button>
    </div>
  );
}

function StatusChance<Grant extends StatusGrant>({
  entry,
  certainAllowed,
  patch,
}: {
  entry: Grant;
  certainAllowed: boolean;
  patch: (fields: Partial<Grant>) => void;
}) {
  const certain = entry.chance === undefined;

  return (
    <>
      {certainAllowed ? (
        <label className="flex flex-col gap-0.5 text-xs">
          <FieldLabel info="Off, this always lands. On, it lands the stated percentage of the time.">
            Chance
          </FieldLabel>
          <Switch
            checked={!certain}
            ariaLabel="Give this a chance of landing"
            onCheckedChange={(on) =>
              patch({
                chance: on ? MAX_PERCENT_STAT : undefined,
              } as Partial<Grant>)
            }
          />
        </label>
      ) : null}
      {certain ? (
        <span className="text-[11px] text-muted">Always.</span>
      ) : (
        <label className="flex flex-col gap-0.5 text-xs">
          <FieldLabel>Chance (%)</FieldLabel>
          <NumberInput
            className="w-20"
            min={MIN_PERCENT_STAT}
            max={MAX_PERCENT_STAT}
            step={1}
            value={entry.chance ?? MAX_PERCENT_STAT}
            onChange={(chance) => patch({ chance } as Partial<Grant>)}
          />
        </label>
      )}
    </>
  );
}
