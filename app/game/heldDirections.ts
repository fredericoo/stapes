import type { GameInput } from "./GameSession";
import type { Direction } from "../lib/types";

/**
 * What the player is currently asking for, from whatever they are pressing it
 * with.
 *
 * One list behind every input device. Keys and the on-screen pad both press and
 * release the same directions, so multi-touch, a held key and a finger sliding
 * off a button all resolve by the same rule rather than by three copies of it —
 * the copies being what the two routes had before this existed.
 *
 * Latest press wins, which is why this is an ordered list and not a set: a
 * player holding right and then pressing up expects to go up, and to go back to
 * right when they let go of up.
 */
export class HeldDirections {
  private readonly held: Direction[] = [];
  private faceOnly = false;
  private preferDescend = false;

  constructor(private readonly apply: (input: GameInput) => void) {}

  /** Idempotent: a repeat press moves the direction to the front, once. */
  press(direction: Direction) {
    this.remove(direction);
    this.held.push(direction);
    this.sync();
  }

  release(direction: Direction) {
    if (!this.remove(direction)) return;
    this.sync();
  }

  setModifiers(modifiers: { faceOnly: boolean; preferDescend: boolean }) {
    if (
      modifiers.faceOnly === this.faceOnly &&
      modifiers.preferDescend === this.preferDescend
    ) {
      return;
    }
    this.faceOnly = modifiers.faceOnly;
    this.preferDescend = modifiers.preferDescend;
    this.sync();
  }

  /**
   * Drop everything. Losing the window drops every key, and without this a held
   * direction sticks and the avatar walks off on its own.
   */
  clear() {
    if (this.held.length === 0 && !this.faceOnly && !this.preferDescend) return;
    this.held.length = 0;
    this.faceOnly = false;
    this.preferDescend = false;
    this.sync();
  }

  /**
   * Push the current state again, unchanged.
   *
   * For a reconnect: the keys are still down, but the session behind `apply` is
   * a new one that has never been told so.
   */
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
      directions: [...this.held],
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

/**
 * Is this keystroke somebody typing rather than somebody playing?
 *
 * The bindings live on `window`, so without this every `w`, `a`, `s` and `d`
 * typed into the chat field would also walk the avatar — and `preventDefault`
 * would stop the letter reaching the field at all. Asking the event where it
 * landed is the robust version: any field added later is covered by having been
 * focused, with nothing to remember to update.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Hold shift to look. Returns the unbind.
 *
 * Lives beside the direction bindings rather than in the renderer because it
 * shares their two hard-won rules — {@link isTypingTarget}, so a capital letter
 * typed into the chat bar does not flick the mode on and off mid-sentence, and
 * window blur, so a modifier released outside the tab does not stick. A second
 * copy of that discipline is exactly what this module exists to avoid.
 *
 * Shift already means "turn on the spot, do not walk" for a held direction. The
 * two do not collide: one is about the keys, the other about the pointer, and
 * shift reads as the careful, deliberate modifier in both.
 *
 * **Only the press is gated by focus.** A release always counts, wherever it
 * lands: press shift over the world, click into the chat field, let go — gating
 * that keyup would leave the mode stuck on with no way to turn it off.
 *
 * Reports whether shift is *down*, which is only half of whether the player is
 * looking: the button latches the same mode on, and the caller ORs the two. Told
 * the whole answer instead, this would turn a stray tap of shift into a way of
 * silently cancelling a mode the player had clicked on.
 */
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

/** The key that flips attack mode. */
const ATTACK_MODE_CODE = "KeyE";

/**
 * Press E to fight, press it again to stop. Returns the unbind.
 *
 * A latch rather than a modifier, which is the opposite of {@link bindLookKey}
 * and deliberately so: looking is something you do for a second while your hand
 * is already on the keys, and fighting is a stance you are in for the length of
 * a fight. Nobody is going to hold a key down for that, and a mode that ended
 * whenever a hand moved would end mid-swing.
 *
 * Gated on {@link isTypingTarget} for the same reason the directions are: an "e"
 * typed into the chat bar is a letter, not a decision to start swinging.
 *
 * Deliberately reports the press rather than a state, leaving the caller to hold
 * what the mode is: the button in the UI toggles the same thing, and two
 * booleans for one mode is how they drift apart.
 */
export function bindAttackKey(onToggle: () => void): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code !== ATTACK_MODE_CODE) return;
    if (e.repeat) return;
    if (isTypingTarget(e.target)) return;
    onToggle();
  };

  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}

/** Drive `input` from the keyboard. Returns the unbind. */
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
    // A held key repeats; the press has already landed.
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
