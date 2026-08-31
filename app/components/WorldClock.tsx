import { formatClock, type MinutesOfDay } from "../lib/clock";

/**
 * The hour, which is about the world rather than about working on it.
 *
 * It says whether the dark you are looking at is night or a roof, and a reading
 * you have to open a menu to take is not a reading — so it is on screen on every
 * device. Where it sits is the part that moved: it used to ride in the header,
 * and on a phone there is no longer a header to ride in. Now it is beside the
 * statuses on a desktop and in the corner under the arrows on a phone, which on
 * both is the same place — with the other things the world is telling you.
 *
 * **No box around it.** It wore the same outlined chip every button in the
 * header wore, sat among things that were buttons, and people pressed it. A
 * reading is text; drawing it as a control is the thing that made it look like
 * one. Tabular figures so the minutes do not jitter the line as they tick.
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
