/** A colour cycle's ramp written as runs: each colour repeated for its number of steps, in order along the current. */
export function cycleRamp(runs: ReadonlyArray<readonly [string, number]>): string[] {
  return runs.flatMap(([color, steps]) => Array.from({ length: steps }, () => color));
}
