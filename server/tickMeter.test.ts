import { describe, expect, it } from "bun:test";
import { TickMeter } from "./tickMeter";

function meterOnClock() {
  let now = 0;
  const meter = new TickMeter(() => now);
  return {
    meter,
    tick(phases: { sim: number; collect: number; broadcast: number; flush: number }, lateMs = 0) {
      meter.begin(lateMs);
      for (const phase of ["sim", "collect", "broadcast", "flush"] as const) {
        now += phases[phase];
        meter.lap(phase);
      }
      meter.end({ failed: false });
    },
  };
}

describe("a tick meter", () => {
  it("reports a tick as the sum of its phases, and the slowest tick as the max", () => {
    const { meter, tick } = meterOnClock();
    for (let i = 0; i < 99; i++) tick({ sim: 2, collect: 1, broadcast: 1, flush: 0 });
    tick({ sim: 40, collect: 1, broadcast: 9, flush: 0 }, 12);

    const window = meter.drain()!;

    expect(window.ticks).toBe(100);
    expect(window.tick).toEqual({ p50: 4, p95: 4, p99: 50, max: 50 });
    expect(window.phases.sim.max).toBe(40);
    expect(window.phases.broadcast.max).toBe(9);
    expect(window.late.max).toBe(12);
  });

  it("starts each window empty, and has none for a span without a tick", () => {
    const { meter, tick } = meterOnClock();
    tick({ sim: 5, collect: 0, broadcast: 0, flush: 0 });
    meter.skip(3);

    expect(meter.drain()).toMatchObject({ ticks: 1, skipped: 3 });
    expect(meter.drain()).toBeNull();
  });

  it("counts a tick that threw, with the time it took", () => {
    let now = 0;
    const meter = new TickMeter(() => now);
    meter.begin(0);
    now += 7;
    meter.end({ failed: true });

    expect(meter.drain()).toMatchObject({ ticks: 1, failures: 1, tick: { max: 7 } });
  });
});
