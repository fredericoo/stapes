export const FULL_SHAKE_SHARE = 0.5;

export const MAX_SHAKE_PX = 6;

export const SHAKE_DURATION_MS = 320;

const FREQ_X = 0.071;
const FREQ_Y = 0.053;

export function shakeAmplitude(amount: number, maxHp: number | null): number {
  if (maxHp === null || maxHp <= 0 || amount <= 0) return 0;
  const share = Math.min(1, amount / maxHp / FULL_SHAKE_SHARE);
  return share * MAX_SHAKE_PX;
}

export function shakeEnvelope(elapsedMs: number): number {
  const t = Math.min(1, Math.max(0, elapsedMs / SHAKE_DURATION_MS));
  return (1 - t) * (1 - t);
}

export class ScreenShake {
  private amplitude = 0;
  private startedMs = 0;

  hit(amplitude: number, nowMs: number) {
    if (amplitude <= 0) return;
    const left = this.amplitude * shakeEnvelope(nowMs - this.startedMs);
    this.amplitude = Math.min(MAX_SHAKE_PX, left + amplitude);
    this.startedMs = nowMs;
  }

  offset(nowMs: number): { x: number; y: number } {
    if (this.amplitude === 0) return { x: 0, y: 0 };
    const elapsed = nowMs - this.startedMs;
    if (elapsed >= SHAKE_DURATION_MS) {
      this.amplitude = 0;
      return { x: 0, y: 0 };
    }
    const reach = this.amplitude * shakeEnvelope(elapsed);
    return {
      x: Math.round(reach * Math.sin(elapsed * FREQ_X)) + 0,
      y: Math.round(reach * Math.cos(elapsed * FREQ_Y)) + 0,
    };
  }
}
