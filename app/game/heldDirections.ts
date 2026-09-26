import type { GameInput } from "./GameSession";
import type { Direction } from "../lib/types";

export class HeldDirections {
  private readonly held: Direction[] = [];
  private auto: Direction | null = null;
  private faceOnly = false;
  private preferDescend = false;

  constructor(private readonly apply: (input: GameInput) => void) {}

  press(direction: Direction) {
    this.auto = null;
    this.remove(direction);
    this.held.push(direction);
    this.sync();
  }

  setAuto(direction: Direction | null) {
    if (direction === this.auto) return;
    this.auto = direction;
    this.sync();
  }

  get autoPressed(): boolean {
    return this.auto !== null;
  }

  get pressed(): boolean {
    return this.held.length > 0;
  }

  release(direction: Direction) {
    if (!this.remove(direction)) return;
    this.sync();
  }

  setModifiers(modifiers: { faceOnly: boolean; preferDescend: boolean }) {
    if (modifiers.faceOnly === this.faceOnly && modifiers.preferDescend === this.preferDescend) {
      return;
    }
    this.faceOnly = modifiers.faceOnly;
    this.preferDescend = modifiers.preferDescend;
    this.sync();
  }

  clear() {
    if (this.held.length === 0 && this.auto === null && !this.faceOnly && !this.preferDescend) {
      return;
    }
    this.held.length = 0;
    this.auto = null;
    this.faceOnly = false;
    this.preferDescend = false;
    this.sync();
  }

  resend() {
    this.sync();
  }

  private remove(direction: Direction): boolean {
    const at = this.held.indexOf(direction);
    if (at < 0) return false;
    this.held.splice(at, 1);
    return true;
  }

  private sync() {
    this.apply({
      directions: this.auto ? [this.auto] : [...this.held],
      faceOnly: this.faceOnly,
      preferDescend: this.preferDescend,
    });
  }
}

const KEY_TO_DIRECTION: Record<string, Direction> = {
  ArrowUp: "n",
  ArrowDown: "s",
  ArrowLeft: "w",
  ArrowRight: "e",
  KeyW: "n",
  KeyS: "s",
  KeyA: "w",
  KeyD: "e",
};

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function bindLookKey(onChange: (looking: boolean) => void): () => void {
  let looking = false;
  const set = (next: boolean) => {
    if (next === looking) return;
    looking = next;
    onChange(next);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target)) return;
    if (e.key === "Shift") set(true);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === "Shift") set(false);
  };
  const onBlur = () => set(false);

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
  };
}

const ATTACK_MODE_CODE = "Space";

function withCommandModifier(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey || e.altKey;
}

function inDialog(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest('[role="dialog"], [role="alertdialog"]') !== null
  );
}

export function bindAttackKey(onToggle: () => void): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code !== ATTACK_MODE_CODE) return;
    if (isTypingTarget(e.target) || inDialog(e.target)) return;
    if (withCommandModifier(e)) return;
    e.preventDefault();
    if (e.repeat) return;
    onToggle();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code !== ATTACK_MODE_CODE) return;
    if (isTypingTarget(e.target) || inDialog(e.target)) return;
    e.preventDefault();
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
  };
}

const CAST_CODES = ["KeyQ", "KeyE", "KeyF"] as const;

const CAST_LABELS = ["Q", "E", "F"] as const;

export function bindCastKeys(onCast: (index: number) => void): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const index = CAST_CODES.indexOf(e.code as (typeof CAST_CODES)[number]);
    if (index < 0) return;
    if (isTypingTarget(e.target)) return;
    if (withCommandModifier(e)) return;
    e.preventDefault();
    if (e.repeat) return;
    onCast(index);
  };

  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}

export function castKeyLabel(index: number): string {
  return CAST_LABELS[index] ?? "";
}

const NUMBER_CODES = [
  "Digit1",
  "Digit2",
  "Digit3",
  "Digit4",
  "Digit5",
  "Digit6",
  "Digit7",
  "Digit8",
  "Digit9",
] as const;

export function bindNumberKeys(onNumber: (index: number) => void): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const index = NUMBER_CODES.indexOf(e.code as (typeof NUMBER_CODES)[number]);
    if (index < 0) return;
    if (isTypingTarget(e.target)) return;
    if (withCommandModifier(e)) return;
    e.preventDefault();
    if (e.repeat) return;
    onNumber(index);
  };

  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}

export function numberKeyLabel(index: number): string {
  return index < NUMBER_CODES.length ? String(index + 1) : "";
}

const STEP_UP_CODES = new Set(["Equal", "NumpadAdd"]);
const STEP_DOWN_CODES = new Set(["Minus", "NumpadSubtract"]);

export function bindStepKeys(onStep: (delta: 1 | -1) => void): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const delta = STEP_UP_CODES.has(e.code) ? 1 : STEP_DOWN_CODES.has(e.code) ? -1 : 0;
    if (delta === 0) return;
    if (isTypingTarget(e.target)) return;
    if (withCommandModifier(e)) return;
    e.preventDefault();
    onStep(delta);
  };

  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}

export function bindKeyboard(input: HeldDirections): () => void {
  const modifiers = (e: KeyboardEvent) => {
    input.setModifiers({ faceOnly: e.shiftKey, preferDescend: e.altKey });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target)) return;
    modifiers(e);
    const direction = KEY_TO_DIRECTION[e.code];
    if (!direction) return;
    e.preventDefault();
    if (e.repeat) return;
    input.press(direction);
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target)) return;
    modifiers(e);
    const direction = KEY_TO_DIRECTION[e.code];
    if (!direction) return;
    e.preventDefault();
    input.release(direction);
  };

  const onBlur = () => input.clear();

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
  };
}
