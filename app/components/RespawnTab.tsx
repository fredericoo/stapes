import type { RespawnInteraction, TileInteractions } from "../lib/interactions";
import { DEFAULT_RESPAWN, hasAnyInteraction } from "../lib/interactions";
import type { TileDef } from "../lib/types";
import { Input, Switch } from "../ui";

const MS_PER_SECOND = 1000;

/**
 * Authored in seconds and stored in milliseconds, like decay — but with a far
 * higher ceiling, because the two clocks cost differently: a decay keeps the
 * world ticking for its whole lifetime, while a respawn sleeps on a Durable
 * Object alarm and costs nothing until it fires. A day is room enough for
 * "the dragon comes back tomorrow".
 */
const MAX_RESPAWN_SECONDS = 86_400;

/** A cleared number field reads as the shortest legal wait, not as NaN. */
function secondsFromInput(raw: string): number {
  const parsed = Number.parseFloat(raw);
  return Number.isNaN(parsed) ? 1 : parsed;
}

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
        <label className="flex items-center gap-2 text-sm font-bold">
          <Switch
            checked={Boolean(respawn)}
            onCheckedChange={(on) =>
              setRespawn(on ? { ...DEFAULT_RESPAWN } : undefined)
            }
            ariaLabel="Respawns when gone"
          />
          Respawn
        </label>
        <p className="text-[11px] leading-snug text-muted">
          When a placement of this tile is gone — killed, picked up, decayed —
          it grows back where the map put it, after a wait drawn from the range
          below. Every spot you place it is its own spawn point with its own
          clock: clearing one of five rats starts one clock, not five. A
          creature counts as alive wherever it has wandered to; an object counts
          only in its authored cell, so a sword carried off grows a new one —
          that is the loop, not a leak.
        </p>

        {respawn ? (
          <div className="flex flex-col gap-3 border-t-2 border-border pt-3">
            <div className="flex flex-col gap-1 text-xs">
              <span className="font-bold uppercase text-muted">Wait</span>
              <span className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={MAX_RESPAWN_SECONDS}
                  step={1}
                  value={respawn.fromMs / MS_PER_SECOND}
                  onChange={(e) =>
                    patchBound("fromMs", secondsFromInput(e.target.value))
                  }
                  className="w-20"
                  aria-label="Shortest wait in seconds"
                />
                <span className="font-normal text-muted">to</span>
                <Input
                  type="number"
                  min={1}
                  max={MAX_RESPAWN_SECONDS}
                  step={1}
                  value={respawn.toMs / MS_PER_SECOND}
                  onChange={(e) =>
                    patchBound("toMs", secondsFromInput(e.target.value))
                  }
                  className="w-20"
                  aria-label="Longest wait in seconds"
                />
                <span className="font-normal text-muted">seconds</span>
              </span>
              <span className="text-[11px] font-normal leading-snug text-muted">
                Counted on the wall clock, unlike decay: the wait keeps running
                while nobody is playing, so a world left alone for an hour is
                found repopulated rather than owing an hour. A spread stops a
                camp cleared in one fight from reappearing all on the same
                second — set both ends the same for an exact wait.
              </span>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
