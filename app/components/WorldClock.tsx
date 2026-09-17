import { formatClock, type MinutesOfDay } from "../lib/clock";

/**
 * The hour. It says whether the dark you are looking at is night or a roof,
 * so it is on screen on every device: beside the statuses on a desktop and in
 * the corner under the arrows on a phone.
 *
 * No box around it: drawn as an outlined chip among buttons, people press it.
 * Tabular figures so the minutes do not jitter the line as they tick.
 */
export function WorldClock({ minutesOfDay }: { minutesOfDay: MinutesOfDay }) {
  return (
    <span
      className="shrink-0 text-xs tabular-nums text-paper/70"
      // Named rather than announced: the hour changes every second, so a live
      // region here would talk over everything else.
      aria-label={`Time of day, ${formatClock(minutesOfDay)}`}
    >
      {formatClock(minutesOfDay)}
    </span>
  );
}
