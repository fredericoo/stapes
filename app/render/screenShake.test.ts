import { describe, expect, it } from "vitest";
import {
  FULL_SHAKE_SHARE,
  MAX_SHAKE_PX,
  ScreenShake,
  SHAKE_DURATION_MS,
  shakeAmplitude,
  shakeEnvelope,
} from "./screenShake";

function peak(shake: ScreenShake, fromMs: number): number {
  let most = 0;
  for (let t = fromMs; t < fromMs + SHAKE_DURATION_MS; t += 16) {
    const { x, y } = shake.offset(t);
    most = Math.max(most, Math.abs(x), Math.abs(y));
  }
  return most;
}

describe("how hard a blow shakes", () => {
  it("scales with the share of health it took, not the figure", () => {
    expect(shakeAmplitude(5, 200)).toBeLessThan(shakeAmplitude(5, 20));
    expect(shakeAmplitude(10, 100)).toBeCloseTo(shakeAmplitude(3, 30));
  });

  it("is linear in the share up to the cap", () => {
    expect(shakeAmplitude(25, 100)).toBeCloseTo(shakeAmplitude(50, 100) / 2);
    expect(shakeAmplitude(10, 100)).toBeCloseTo(shakeAmplitude(20, 100) / 2);
  });

  it("reaches the most it ever shakes at the full share, and stays there", () => {
    expect(shakeAmplitude(FULL_SHAKE_SHARE * 100, 100)).toBe(MAX_SHAKE_PX);
    expect(shakeAmplitude(100, 100)).toBe(MAX_SHAKE_PX);
    expect(shakeAmplitude(500, 100)).toBe(MAX_SHAKE_PX);
  });

  it("is nothing for a blow that took nothing, or a body with no health", () => {
    expect(shakeAmplitude(0, 100)).toBe(0);
    expect(shakeAmplitude(5, null)).toBe(0);
    expect(shakeAmplitude(5, 0)).toBe(0);
  });
});

describe("how a shake settles", () => {
  it("starts full and ends at rest", () => {
    expect(shakeEnvelope(0)).toBe(1);
    expect(shakeEnvelope(SHAKE_DURATION_MS)).toBe(0);
    expect(shakeEnvelope(SHAKE_DURATION_MS * 2)).toBe(0);
  });

  it("spends most of its strength early", () => {
    expect(shakeEnvelope(SHAKE_DURATION_MS / 2)).toBeLessThan(0.5);
  });
});

describe("a shake in progress", () => {
  it("does nothing until something hits", () => {
    expect(new ScreenShake().offset(1000)).toEqual({ x: 0, y: 0 });
  });

  it("moves the view on the first frame after a blow", () => {
    const shake = new ScreenShake();
    shake.hit(MAX_SHAKE_PX, 1000);
    const { x, y } = shake.offset(1000);
    expect(Math.hypot(x, y)).toBeGreaterThan(0);
  });

  it("shakes harder for a bigger share", () => {
    const small = new ScreenShake();
    small.hit(shakeAmplitude(15, 100), 0);
    const big = new ScreenShake();
    big.hit(shakeAmplitude(50, 100), 0);
    expect(peak(big, 0)).toBeGreaterThan(peak(small, 0));
  });

  it("never passes the largest offset, however many blows land", () => {
    const shake = new ScreenShake();
    for (let t = 0; t < 100; t += 10) shake.hit(MAX_SHAKE_PX, t);
    expect(peak(shake, 100)).toBeLessThanOrEqual(MAX_SHAKE_PX);
  });

  it("lets a second blow add to what is left of the first", () => {
    const once = new ScreenShake();
    once.hit(2, 0);
    const twice = new ScreenShake();
    twice.hit(2, 0);
    twice.hit(2, 20);
    expect(peak(twice, 20)).toBeGreaterThan(peak(once, 20));
  });

  it("is back at rest once it has settled", () => {
    const shake = new ScreenShake();
    shake.hit(MAX_SHAKE_PX, 0);
    expect(shake.offset(SHAKE_DURATION_MS)).toEqual({ x: 0, y: 0 });
    expect(shake.offset(SHAKE_DURATION_MS + 5000)).toEqual({ x: 0, y: 0 });
  });

  it("lands on whole pixels", () => {
    const shake = new ScreenShake();
    shake.hit(MAX_SHAKE_PX * 0.7, 0);
    for (let t = 0; t < SHAKE_DURATION_MS; t += 7) {
      const { x, y } = shake.offset(t);
      expect(Number.isInteger(x)).toBe(true);
      expect(Number.isInteger(y)).toBe(true);
    }
  });
});
