import type { RespawnInteraction, TileInteractions } from "../lib/interactions";
import { DEFAULT_RESPAWN, hasAnyInteraction } from "../lib/interactions";
import type { TileDef } from "../lib/types";
import { FieldLabel, NumberInput, SwitchField } from "../ui";

const MS_PER_SECOND = 1000;

/**
 * Authored in seconds and stored in milliseconds, like decay — but with a far
 * higher ceiling, because the two clocks cost differently: a decay keeps the
 * world ticking for its whole lifetime, while a respawn sleeps on a Durable
 * Object alarm and costs nothing until it fires. A day is room enough for
 * "the dragon comes back tomorrow".
 */
const MAX_RESPAWN_SECONDS = 86_400;

type Props = {
  draft: TileDef;
  onChange: (next: TileDef) => void;
};

/** Whether — and how soon — a placement of this tile grows back once gone. */
export function RespawnTab({ draft, onChange }: Props) {
  const respawn = draft.interactions?.respawn;

  const setRespawn = (next: RespawnInteraction | undefined) => {
    const merged: TileInteractions = { ...draft.interactions };
    if (next == null) delete merged.respawn;
    else merged.respawn = next;
    onChange({
      ...draft,
      interactions: hasAnyInteraction(merged) ? merged : undefined,
    });
  };

  /**
   * Move one end of the wait range, carrying the other with it rather than
   * letting it be crossed — the same guard the decay editor keeps, for the
   * same reason: an inverted range parses as "does not respawn", which would
   * be invisible with both numbers still sitting there.
   */
  const patchBound = (end: "fromMs" | "toMs", seconds: number) => {
    if (!respawn) return;
    const ms = Math.round(
      Math.min(MAX_RESPAWN_SECONDS, Math.max(1, seconds)) * MS_PER_SECOND,
    );
    setRespawn(
      end === "fromMs"
        ? { fromMs: ms, toMs: Math.max(ms, respawn.toMs) }
        : { toMs: ms, fromMs: Math.min(ms, respawn.fromMs) },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <SwitchField
          checked={Boolean(respawn)}
          onCheckedChange={(on) =>
            setRespawn(on ? { ...DEFAULT_RESPAWN } : undefined)
          }
          label="Respawn"
          info="Once a placement is gone — killed, picked up, decayed — it regrows at its authored cell after the wait. Each placement has its own clock. A creature counts as alive wherever it wandered; an object only in its own cell, so a carried-off sword regrows."
          size="section"
        />

        {respawn ? (
          <div className="flex flex-col gap-1 border-t-2 border-border pt-3 text-xs">
            <FieldLabel info="Drawn once per respawn, on the wall clock — it keeps counting while nobody is playing. Equal ends for an exact wait.">
              Wait (s)
            </FieldLabel>
            <span className="flex items-center gap-2">
              <NumberInput
                min={1}
                max={MAX_RESPAWN_SECONDS}
                step={1}
                value={respawn.fromMs / MS_PER_SECOND}
                onChange={(seconds) => patchBound("fromMs", seconds)}
                className="w-20"
                aria-label="Shortest wait in seconds"
              />
              <span className="text-muted">to</span>
              <NumberInput
                min={1}
                max={MAX_RESPAWN_SECONDS}
                step={1}
                value={respawn.toMs / MS_PER_SECOND}
                onChange={(seconds) => patchBound("toMs", seconds)}
                className="w-20"
                aria-label="Longest wait in seconds"
              />
            </span>
          </div>
        ) : null}
      </section>
    </div>
  );
}
