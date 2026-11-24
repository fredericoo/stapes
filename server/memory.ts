import { readFileSync } from "node:fs";

export type MemoryReading = { rssMb: number; peakMb: number | null };

/**
 * The peak (`VmHWM`) is what a container's memory limit has to cover; Linux
 * reports it in `/proc`, and elsewhere only the current RSS is known.
 */
export function memoryReading(): MemoryReading {
  const mb = (kb: string) => Math.round(Number(kb) / 1024);
  try {
    const status = readFileSync("/proc/self/status", "utf8");
    const field = (name: string) => status.match(new RegExp(`^${name}:\\s+(\\d+) kB`, "m"))?.[1];
    const rss = field("VmRSS");
    const peak = field("VmHWM");
    if (rss !== undefined) return { rssMb: mb(rss), peakMb: peak === undefined ? null : mb(peak) };
  } catch {}
  return { rssMb: Math.round(process.memoryUsage().rss / 1048576), peakMb: null };
}
