import { DAMAGE_NUMBER_LIFETIME_MS } from "../game/constants";
import type { SwingOutcome } from "../game/GameSession";
import { labelScreenPosition } from "./textLabels";

const RISE_PX = 22;

const START_LIFT_PX = 6;

export type DamageNumberView = {
  id: string;
  x: number;
  y: number;
  outcome: SwingOutcome;
  amount: number;
  own: boolean;
  elapsedMs: number;
};

type Entry = {
  element: HTMLDivElement;
  text: string;
  className: string;
};

export class DamageNumberLayer {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly container: HTMLElement) {}

  set(numbers: DamageNumberView[], camera: { x: number; y: number }, cssScale: number) {
    const live = new Set<string>();

    for (const number of numbers) {
      live.add(number.id);
      const entry = this.entry(number);
      const anchor = labelScreenPosition(number.x, number.y, camera, cssScale);
      const progress = Math.min(1, Math.max(0, number.elapsedMs / DAMAGE_NUMBER_LIFETIME_MS));
      const top = Math.round(anchor.top - START_LIFT_PX - RISE_PX * progress);
      entry.element.style.setProperty("--label-x", `${anchor.left}px`);
      entry.element.style.setProperty("--label-y", `${top}px`);
    }

    for (const [id, entry] of this.entries) {
      if (live.has(id)) continue;
      entry.element.remove();
      this.entries.delete(id);
    }
  }

  private entry(number: DamageNumberView): Entry {
    const text = textFor(number);
    const className = classFor(number);

    const existing = this.entries.get(number.id);
    if (existing) {
      if (existing.text !== text) {
        existing.element.textContent = text;
        existing.text = text;
      }
      if (existing.className !== className) {
        existing.element.className = className;
        existing.className = className;
      }
      return existing;
    }

    const element = document.createElement("div");
    element.className = className;
    element.textContent = text;
    this.container.appendChild(element);

    const entry: Entry = { element, text, className };
    this.entries.set(number.id, entry);
    return entry;
  }

  dispose() {
    for (const entry of this.entries.values()) entry.element.remove();
    this.entries.clear();
  }
}

const NOTHING_HAPPENED: Record<"miss", string> = {
  miss: "miss",
};

const MEND_SIGN = "+";

const BLOCKED = "blocked";

export function textFor(number: DamageNumberView): string {
  if (number.outcome === "heal") return `${MEND_SIGN}${number.amount}`;
  if (number.outcome !== "hit") return NOTHING_HAPPENED[number.outcome];
  return number.amount > 0 ? String(number.amount) : BLOCKED;
}

export function classFor(number: DamageNumberView): string {
  if (number.outcome === "heal") {
    return "damage-number damage-number--mend";
  }
  if (number.outcome !== "hit" || number.amount <= 0) {
    return "damage-number damage-number--nothing";
  }
  return `damage-number${number.own ? " damage-number--own" : ""}`;
}
