import { FRAME_PHASES, type FrameStats } from "../render/frameProfile";

/**
 * Frame budget at 120Hz. Phases are coloured against it so a spike reads at a
 * glance rather than needing the numbers compared.
 */
const BUDGET_MS = 1000 / 120;

/** Phases whose time is already counted inside `view` — indented, not summed. */
const NESTED_PHASES = new Set(["sync", "map", "light", "motion"]);

function tone(ms: number): string {
  if (ms > BUDGET_MS) return "text-red-400";
  if (ms > BUDGET_MS / 2) return "text-amber-300";
  return "text-paper/60";
}

/**
 * Fixed widths for the two numbers, wide enough for their longest ordinary
 * reading (`120`, `▲99.9ms`). Tabular figures stop the digits jittering but not
 * the count of them changing, and a reading that grows by a character pushes
 * everything laid out after it.
 */
const FPS_WIDTH_CLASS = "inline-block min-w-[3ch] text-center";
const WORST_WIDTH_CLASS = "inline-block min-w-[7ch] text-right";

function ms(value: number): string {
  return value.toFixed(1);
}

export function FrameStatsReadout({ stats }: { stats: FrameStats | null }) {
  if (!stats) {
    return (
      <span className="border-2 border-paper/40 px-1.5 py-0.5 text-xs tabular-nums text-paper">
        <span className={FPS_WIDTH_CLASS}>—</span>
      </span>
    );
  }

  return (
    <details className="group relative">
      <summary className="flex cursor-pointer list-none items-center gap-2">
        <span
          className="border-2 border-paper/40 px-1.5 py-0.5 text-xs tabular-nums text-paper"
          aria-live="polite"
          aria-label="Frames per second"
        >
          <span className={FPS_WIDTH_CLASS}>{stats.fps}</span>
        </span>
        <span
          className={`text-xs tabular-nums ${WORST_WIDTH_CLASS} ${tone(stats.frame.worst)}`}
          aria-label="Worst frame in the last window, milliseconds"
        >
          ▲{ms(stats.frame.worst)}ms
        </span>
      </summary>

      <div className="absolute right-0 z-50 mt-2 w-64 border-2 border-paper/40 bg-ink/95 p-2 text-xs tabular-nums text-paper">
        <div className="mb-1 flex justify-between text-paper/60">
          <span>phase</span>
          <span>p50 / worst</span>
        </div>
        <Row label="frame" timing={stats.frame} />
        <hr className="my-1 border-paper/20" />
        {FRAME_PHASES.map((phase) => (
          <Row
            key={phase}
            label={phase}
            timing={stats.phases[phase]}
            nested={NESTED_PHASES.has(phase)}
          />
        ))}
        <p className="mt-2 text-[10px] leading-tight text-paper/50">
          Indented phases are inside <code>view</code>. <code>draw</code> is CPU submit only — GPU
          time lands after it returns.
        </p>
      </div>
    </details>
  );
}

function Row({
  label,
  timing,
  nested,
}: {
  label: string;
  timing: { p50: number; worst: number };
  nested?: boolean;
}) {
  return (
    <div className={`flex justify-between ${nested ? "pl-3" : ""}`}>
      <span className="text-paper/70">{label}</span>
      <span>
        <span className="text-paper/50">{ms(timing.p50)}</span>
        <span className="text-paper/30"> / </span>
        <span className={tone(timing.worst)}>{ms(timing.worst)}</span>
      </span>
    </div>
  );
}
