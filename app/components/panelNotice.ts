import { useEffect, useRef, useState } from "react";
import type { Equipment } from "../game/equipment";
import type { ItemInstance } from "../lib/itemInstance";
import { levelForXp, type Mastery, type MasteryXp } from "../lib/mastery";
import type { ActiveStatus, StatusTone } from "../lib/status";

export type NoticeTone = "neutral" | StatusTone;

export type PanelNotice = { seq: number; tone: NoticeTone };

const PULSE_DURATION_MS = 420;

const FLASH_DURATION_MS = 600;

const FLASH_PEAK_OPACITY = 0.7;

const PULSE_KEYFRAMES: Keyframe[] = [
  { transform: "scale(1)" },
  { transform: "scale(0.6)", offset: 0.35 },
  { transform: "scale(1.2)", offset: 0.7 },
  { transform: "scale(1)" },
];

const FLASH_KEYFRAMES: Keyframe[] = [
  { opacity: 0 },
  { opacity: FLASH_PEAK_OPACITY, offset: 0.2 },
  { opacity: 0 },
];

export const NOTICE_FLASH_CLASS: Record<NoticeTone, string> = {
  neutral: "bg-label",
  good: "bg-mend",
  bad: "bg-danger-on-ink",
};

function stackCounts(bag: ItemInstance | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of bag?.contents ?? []) counts.set(item.id, item.count ?? 1);
  return counts;
}

/**
 * Only a bag that stayed the same bag can gain something: swapping bags is an
 * equip, which the equipment button reports.
 */
export function bagGained(prev: ItemInstance | null, next: ItemInstance | null): boolean {
  if (!prev || !next || prev.id !== next.id) return false;
  const before = stackCounts(prev);
  for (const [id, count] of stackCounts(next)) {
    if (count > (before.get(id) ?? 0)) return true;
  }
  return false;
}

export function newlyEquipped(prev: Equipment, next: Equipment): boolean {
  return (Object.keys(next) as (keyof Equipment)[]).some((slot) => {
    const item = next[slot];
    return item != null && item.id !== prev[slot]?.id;
  });
}

function masteryLevelledUp(prev: MasteryXp, next: MasteryXp): boolean {
  return (Object.keys(next) as Mastery[]).some(
    (mastery) => levelForXp(next[mastery] ?? 0) > levelForXp(prev[mastery] ?? 0),
  );
}

/** A bad status outranks good news arriving in the same update. */
export function statsMood(
  prev: { statuses: readonly ActiveStatus[]; masteryXp: MasteryXp },
  next: { statuses: readonly ActiveStatus[]; masteryXp: MasteryXp },
): StatusTone | null {
  const had = new Set(prev.statuses.map((status) => status.defId));
  const gained = next.statuses.filter((status) => !had.has(status.defId));
  if (gained.some((status) => status.tone === "bad")) return "bad";
  if (gained.length > 0 || masteryLevelledUp(prev.masteryXp, next.masteryXp)) return "good";
  return null;
}

/**
 * Reports a tone each time `detect` finds news between two consecutive
 * renders, but never across the render where `live` turns true: that one is the
 * first snapshot replacing the empty placeholders, not something the player
 * just received.
 */
export function useNotice<T>(
  value: T,
  live: boolean,
  detect: (prev: T, next: T) => NoticeTone | null,
): PanelNotice | null {
  const [notice, setNotice] = useState<PanelNotice | null>(null);
  const previous = useRef({ value, live });
  const detectRef = useRef(detect);
  detectRef.current = detect;

  useEffect(() => {
    const prev = previous.current;
    previous.current = { value, live };
    if (!prev.live || !live || prev.value === value) return;
    const tone = detectRef.current(prev.value, value);
    if (tone) setNotice((last) => ({ seq: (last?.seq ?? 0) + 1, tone }));
  }, [value, live]);

  return notice;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Plays the pulse on `icon` and the flash on `flash` whenever a new notice
 * arrives. The Web Animations API rather than a CSS class, so a second notice
 * landing mid-animation restarts it instead of being swallowed by a class that
 * is already applied. Reduced motion keeps the flash, which does not move.
 */
export function useNoticeAnimation(
  notice: PanelNotice | null,
  icon: React.RefObject<HTMLElement | null>,
  flash: React.RefObject<HTMLElement | null>,
) {
  const seq = notice?.seq ?? 0;
  useEffect(() => {
    if (seq === 0) return;
    flash.current?.animate(FLASH_KEYFRAMES, { duration: FLASH_DURATION_MS, easing: "ease-out" });
    if (prefersReducedMotion()) return;
    icon.current?.animate(PULSE_KEYFRAMES, { duration: PULSE_DURATION_MS, easing: "ease-out" });
  }, [seq, icon, flash]);
}
