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
 *
 * A clicked walk is one more thing that presses a direction, and it presses it
 * here — see {@link HeldDirections.setAuto} and `./walkTo`. Arbitrating it
 * anywhere else is a second copy of the rule this module exists to hold once,
 * and the copy loses the things the list already knows: which keys are down
 * under the click, and which modifiers are being held with them.
 */
export class HeldDirections {
  private readonly held: Direction[] = [];
  /**
   * The direction a clicked walk is asking for, or null when none is.
   *
   * Outranks the keys while it is set, on the same "latest wins" rule they
   * order themselves by: clicking somewhere is a later decision than a key that
   * was already down. It is not *in* the list because it is not a key and
   * nobody will let go of it — {@link setAuto} is both its press and its
   * release, and the walk that set it is the only thing that can say either.
   */
  private auto: Direction | null = null;
  private faceOnly = false;
  private preferDescend = false;

  constructor(private readonly apply: (input: GameInput) => void) {}

  /** Idempotent: a repeat press moves the direction to the front, once. */
  press(direction: Direction) {
    // Taking the keys back is a decision to walk yourself, so a clicked walk
    // ends here rather than fighting this list for the input. The walk sees it
    // and stops asking. @see auto, ./walkTo
    this.auto = null;
    this.remove(direction);
    this.held.push(direction);
    this.sync();
  }

  /**
   * Walk this direction until something else is asked for, or hand the input
   * back to whatever keys are down.
   *
   * `null` is the release, and it is why nothing outside needs to remember
   * whether a click is what filled the input: the keys are still in the list
   * underneath, so handing back is putting them into force rather than emptying
   * anything. A player who held right through a clicked walk carries on walking
   * right when it ends, which is what their hand is asking for.
   *
   * @see auto for who outranks whom, and {@link autoPressed} for how a walk
   * finds out it lost.
   */
  setAuto(direction: Direction | null) {
    if (direction === this.auto) return;
    this.auto = direction;
    this.sync();
  }

  /**
   * Is a clicked direction still the one in force?
   *
   * The one thing `./walkTo` reads rather than is told, and it is read rather
   * than pushed because there is nothing to push: {@link press} and
   * {@link clear} drop the auto direction as a consequence of what they already
   * mean, and a callback out to whoever set it would be this class knowing what
   * a walk is. False having set one is how a walk learns it has been taken over
   * — a key, or the window going away — and it costs a comparison a frame.
   */
  get autoPressed(): boolean {
    return this.auto !== null;
  }

  /**
   * Is a direction being held by hand?
   *
   * The other half of {@link autoPressed}, and it exists because a follow can
   * be *standing still* — caught up, beside the body it is walking after, with
   * nothing pressed. `autoPressed` is false there and false again when a key
   * takes the input away, so a walk that never ends cannot tell the two apart
   * from that alone. This is the fact that separates them: somebody's hand is
   * on the controls, so the follow yields the frame rather than fighting them
   * for it, and takes the input back when they let go. @see ./walkTo
   */
  get pressed(): boolean {
    return this.held.length > 0;
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
   *
   * A clicked walk goes with them, for the same reason and one more: nobody is
   * going to release it, and a body left walking itself across town while the
   * tab is not even in front of the player is the same fault as a stuck key.
   * The walk reads {@link autoPressed} on its next frame and gives up.
   */
  clear() {
    if (
      this.held.length === 0 &&
      this.auto === null &&
      !this.faceOnly &&
      !this.preferDescend
    ) {
      return;
    }
    this.held.length = 0;
    this.auto = null;
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

  /**
   * Say what is being asked for now.
   *
   * The clicked direction stands in for the whole list rather than joining it:
   * a walk is one direction at a time by construction, and the keys under it
   * are held rather than pressed — they come back the moment it is handed back.
   *
   * The modifiers ride along either way, which is the point of arbitrating here
   * rather than beside this class: shift means "turn, do not walk" and alt
   * means "take the lower surface" whoever chose the direction, and a click
   * that wrote the input itself silently dropped both.
   */
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

/**
 * The keys that press a stone, in the order the buttons appear in.
 *
 * The digit row rather than letters, because casting is a *list* and a list
 * wants an index — one, two, three is the one keyboard idiom that says "the
 * first of these" without anybody having to be told. Three of them and no more,
 * because three is the whole of a caster's loadout: two hands and a charm. See
 * `./casting`'s `CAST_SQUARES`.
 *
 * `Digit1`–`Digit3` rather than the characters, on the terms the direction keys
 * are bound by code: a French keyboard types `&` where a British one types `1`,
 * and what a player is reaching for is the key in that position.
 */
const CAST_CODES = ["Digit1", "Digit2", "Digit3"] as const;

/**
 * Press a number to cast the stone in that position. Returns the unbind.
 *
 * **Reports the position, not the square**, and that is what keeps the keyboard
 * and the buttons the same control: which stones a body has is a question with a
 * moving answer — a player carrying one stone has one button and one key — and a
 * key bound to a *square* would leave `2` doing nothing while the only spell in
 * the game sat under `1`. The caller holds the list, so the two cannot disagree
 * about what "the second one" is.
 *
 * Gated on {@link isTypingTarget} for the reason every other binding here is: a
 * "1" typed into the chat bar is a digit, not a decision to set somebody on
 * fire. Repeats are dropped, because a held key is one press — the cooldown is
 * what decides how often a stone answers, and a keyboard that could ask faster
 * would be asking for permission it is going to be refused.
 */
export function bindCastKeys(onCast: (index: number) => void): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const index = CAST_CODES.indexOf(e.code as (typeof CAST_CODES)[number]);
    if (index < 0) return;
    if (e.repeat) return;
    if (isTypingTarget(e.target)) return;
    e.preventDefault();
    onCast(index);
  };

  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}

/**
 * What a stone's key is called, for a tooltip and for anything read aloud.
 *
 * Here rather than in the component, so the label and the binding are one list:
 * a fourth key added above would be a fourth label without anybody remembering.
 * Empty past the end, which is a position with no key rather than a bug — a body
 * cannot carry a fourth stone, and the row would simply not draw one.
 */
export function castKeyLabel(index: number): string {
  return index < CAST_CODES.length ? String(index + 1) : "";
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
