import type { ReactNode } from "react";
import {
  MAX_PERCENT_STAT,
  MIN_PERCENT_STAT,
  type StatusGrant,
} from "../lib/item";
import type { StatusDef } from "../lib/status";
import { Button, NumberInput, Select, Switch } from "../ui";

/**
 * Which statuses a thing hands over, and how long each is worth.
 *
 * **The list belongs to whatever causes the condition, not to the condition
 * itself** — bread and a berry both leave you Fed, and only the food knows which
 * of them is a meal. That is also the whole argument for the duration override:
 * without it the difference between a snack and a loaf could only be a *second
 * status*, and then two identical conditions would sit in the panel side by
 * side refusing to stack with each other, for a difference that is only ever a
 * number.
 *
 * One table for both granters, because a consumable's list and a weapon's are
 * the same list — see `../lib/item`'s `StatusGrant`. What differs is what an
 * entry carries beyond the id, and that goes in {@link Props.extra} rather than
 * being sniffed out of the entry at runtime.
 */
type Props<Grant extends StatusGrant> = {
  statuses: Grant[];
  statusDefs: Record<string, StatusDef>;
  onChange: (next: Grant[]) => void;
  /** What this list means for whoever owns it, in the owner's own words. */
  blurb: ReactNode;
  /** A fresh entry on the chosen status. The owner decides what else is on one. */
  blank: (id: string) => Grant;
  /** Columns this granter has and the other does not — a weapon's chance. */
  extra?: (entry: Grant, patch: (fields: Partial<Grant>) => void) => ReactNode;
};

export function StatusGrants<Grant extends StatusGrant>({
  statuses,
  statusDefs,
  onChange,
  blurb,
  blank,
  extra,
}: Props<Grant>) {
  const catalogue = Object.values(statusDefs);
  const options = catalogue.map((def) => ({ value: def.id, label: def.name }));

  const patchAt = (index: number, fields: Partial<Grant>) =>
    onChange(
      statuses.map((entry, i) => (i === index ? { ...entry, ...fields } : entry)),
    );

  return (
    <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
      <span className="text-xs font-bold uppercase text-muted">Statuses</span>
      <p className="max-w-lg text-[11px] leading-snug text-muted">{blurb}</p>

      {catalogue.length === 0 ? (
        <p className="text-[11px] text-muted">
          Nothing authored yet — statuses live on the Statuses page.
        </p>
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
              <span className="font-bold uppercase text-muted">Status</span>
              <Select
                value={entry.id || null}
                onValueChange={(id) =>
                  id && patchAt(index, { id } as Partial<Grant>)
                }
                options={options}
              />
            </label>

            {extra?.(entry, (fields) => patchAt(index, fields))}

            <label className="flex flex-col gap-0.5 text-xs">
              <span className="font-bold uppercase text-muted">Own length</span>
              {/* Both ends move together, because half an override would have to
                  be ordered against a number from somewhere else — see
                  `StatusGrant`. */}
              <Switch
                checked={overriding}
                ariaLabel="Give this its own duration"
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
                  <span className="font-bold uppercase text-muted">From (ms)</span>
                  <NumberInput
                    className="w-28"
                    min={0}
                    step={1}
                    value={entry.fromMs ?? 0}
                    // Kept ordered here so nothing authored through this
                    // screen can land on the inverted range the schema
                    // refuses.
                    onChange={(fromMs) =>
                      patchAt(index, {
                        fromMs,
                        toMs: Math.max(fromMs, entry.toMs ?? fromMs),
                      } as Partial<Grant>)
                    }
                  />
                </label>
                <label className="flex flex-col gap-0.5 text-xs">
                  <span className="font-bold uppercase text-muted">To (ms)</span>
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
                  ? `${(def.fromMs / 1000).toFixed(0)}–${(def.toMs / 1000).toFixed(0)}s, as the status says.`
                  : "Unknown status — it will be skipped."}
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

/**
 * The percentage column, for a grant list whose entries carry one.
 *
 * Here rather than in either caller because both of them want exactly this and
 * neither can have the other's: a weapon's brand and a stone's are the same
 * authored field, and two copies of the clamp would be two places for the ends
 * to drift apart. Passed as {@link Props.extra}, which is what that escape hatch
 * is for — a consumable's grants have no chance, so this cannot move into the
 * list itself.
 *
 * Shaped like the two duration columns beside it rather than as a `StatField`:
 * that component carries a sentence under every box, and one field in a row of
 * plain ones knocks the whole row out of line for a hint the section's own prose
 * already gives.
 */
export function StatusChanceField<Grant extends StatusGrant & { chance: number }>(
  entry: Grant,
  patch: (fields: Partial<Grant>) => void,
) {
  return (
    <label className="flex flex-col gap-0.5 text-xs">
      <span className="font-bold uppercase text-muted">Chance (%)</span>
      <NumberInput
        className="w-20"
        min={MIN_PERCENT_STAT}
        max={MAX_PERCENT_STAT}
        step={1}
        value={entry.chance}
        onChange={(chance) => patch({ chance } as Partial<Grant>)}
      />
    </label>
  );
}
