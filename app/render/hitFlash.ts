import type { DamageNumber } from "../game/GameSession";
import type { StatusTint } from "../lib/statusVfx";

export const HIT_FLASH_FRAMES = 4;

/** A receipt older than this on first sight arrived with a reconnect or a backgrounded tab, not as a blow just landed. */
export const HIT_FLASH_STALE_MS = 100;

export const HIT_FLASH_TINT: StatusTint = { color: "#ffffff", strength: 1, keepLuma: 0 };

export class HitFlash {
  private readonly framesLeft = new Map<string, { targetId: string; frames: number }>();
  private readonly seen = new Set<string>();

  /** Advances one drawn frame and returns the ids of bodies to draw white in it. */
  frame(damage: readonly DamageNumber[]): ReadonlySet<string> {
    const live = new Set<string>();
    for (const hit of damage) {
      live.add(hit.id);
      if (this.seen.has(hit.id)) continue;
      this.seen.add(hit.id);
      if (hit.outcome !== "hit" || hit.amount <= 0) continue;
      if (hit.elapsedMs >= HIT_FLASH_STALE_MS) continue;
      this.framesLeft.set(hit.id, { targetId: hit.targetId, frames: HIT_FLASH_FRAMES });
    }
    for (const id of this.seen) if (!live.has(id)) this.seen.delete(id);

    const flashing = new Set<string>();
    for (const [id, flash] of this.framesLeft) {
      flashing.add(flash.targetId);
      if (--flash.frames <= 0) this.framesLeft.delete(id);
    }
    return flashing;
  }
}
