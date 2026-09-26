import { formatClock, type MinutesOfDay } from "../lib/clock";

export function WorldClock({ minutesOfDay }: { minutesOfDay: MinutesOfDay }) {
  return (
    <span
      className="inline-block min-w-[5ch] shrink-0 text-xs tabular-nums text-paper/70"
      aria-label={`Time of day, ${formatClock(minutesOfDay)}`}
    >
      {formatClock(minutesOfDay)}
    </span>
  );
}
