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
    if (modifiers.faceOnly === this.faceOnly && modifiers.preferDescend === this.preferDescend) {
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
    if (this.held.length === 0 && this.auto === null && !this.faceOnly && !this.preferDescend) {
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
 * Hold shift to read the world instead of acting on it. Returns the unbind.
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
 * that keyup would leave the world stuck being read with no way to stop.
 *
 * Reports whether shift is *down*, which is only half of whether the world is
 * being read: a held finger says the same thing on a phone, and the caller ORs
 * the two. See `../render/GameRenderer`'s `applyLooking`.
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

/** The key that starts and stops swinging at whoever is picked. */
const ATTACK_MODE_CODE = "Space";

/**
 * Is a modifier other than shift being held?
 *
 * The letter and digit bindings below give way to it, so ctrl-F still finds
 * text in the page and ctrl-1 still switches tabs. Shift is left out because it
 * already means "read the world" in this module, and a player holding it to look
 * at something should still be able to press a row.
 */
function withCommandModifier(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey || e.altKey;
}

/**
 * Is this keystroke aimed at a dialog standing over the game?
 *
 * Space is how a focused button is pressed from the keyboard, and the rebirth
 * button on the death screen is a focused button. The attack key is bound on the
 * window, so without this it would swallow the press that asks for a body back.
 */
function inDialog(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest('[role="dialog"], [role="alertdialog"]') !== null
  );
}

/**
 * Press space to fight whoever you have picked, press it again to stop. Returns
 * the unbind.
 *
 * A latch rather than a modifier, which is the opposite of {@link bindLookKey}
 * and deliberately so: reading something is what you do for a second while your
 * hand is already on the keys, and fighting lasts as long as the fight. Nobody
 * is going to hold a key down for that, and a stance that ended whenever a hand
 * moved would end mid-swing.
 *
 * Space rather than a letter, because the letters beside the movement keys are
 * the stones now — see {@link CAST_CODES} — and the thumb is the one digit on the
 * left hand that is not on WASD or reaching past it.
 *
 * The default is prevented, because space scrolls the page and presses whichever
 * button has focus — which, after a click on the list, is a row. A key that
 * toggled the fight *and* pressed the row last clicked would be two actions for
 * one press.
 *
 * Gated on {@link isTypingTarget} for the same reason the directions are: a
 * space typed into the chat bar is a gap between words, not a decision to start
 * swinging.
 *
 * Deliberately reports the press rather than a state, leaving the caller to read
 * the stance off the session it belongs to: the rows on a body say the same
 * thing, and two booleans for one stance is how they drift apart.
 */
export function bindAttackKey(onToggle: () => void): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code !== ATTACK_MODE_CODE) return;
    if (isTypingTarget(e.target) || inDialog(e.target)) return;
    if (withCommandModifier(e)) return;
    e.preventDefault();
    if (e.repeat) return;
    onToggle();
  };
  // A focused button fires its click on the release of space, not the press, so
  // the release has to be swallowed as well.
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

/**
 * The keys that press a stone, in the order the buttons appear in.
 *
 * Q, E and F: the three letters the left hand reaches without leaving WASD. The
 * digit row used to be here, and moved to the list of what is in reach — see
 * {@link NUMBER_CODES} — because that list is longer and changes as you
 * walk, and a list that changes wants an index a player reads off the screen.
 * The stones are three at most and stay where they are, which is what a key
 * learnt by position is good for. Three of them, because three is the whole of
 * a caster's *loadout*: two hands and a charm. See `./casting`'s `CAST_SQUARES`.
 *
 * **The row can be longer than this, and that is not a mismatch to fix here.**
 * A body's own spells come after the squares — see `../lib/battler`'s
 * `BattlerDef.spells` — so a creature authored three of them has six buttons.
 * Three is what a hand on WASD can find without looking, and everything past it
 * is pressed the way a phone presses all of them. What a position with no key
 * looks like is {@link castKeyLabel}'s empty string, which the button already
 * draws as nothing rather than as a gap.
 *
 * By code rather than by character, on the terms the direction keys are bound
 * by: on an AZERTY keyboard `KeyQ` is the key labelled A, and what a player is
 * reaching for is the key in that position.
 */
const CAST_CODES = ["KeyQ", "KeyE", "KeyF"] as const;

/** What each of {@link CAST_CODES} is called on the button. */
const CAST_LABELS = ["Q", "E", "F"] as const;

/**
 * Press Q, E or F to cast the stone in that position. Returns the unbind.
 *
 * **Reports the position, not the square**, and that is what keeps the keyboard
 * and the buttons the same control: which stones a body has is a question with a
 * moving answer — a player carrying one stone has one button and one key — and a
 * key bound to a *square* would leave `E` doing nothing while the only spell in
 * the game sat under `Q`. The caller holds the list, so the two cannot disagree
 * about what "the second one" is.
 *
 * Gated on {@link isTypingTarget} for the reason every other binding here is: an
 * "e" typed into the chat bar is a letter, not a decision to set somebody on
 * fire. Repeats are dropped, because a held key is one press — the cooldown is
 * what decides how often a stone answers, and a keyboard that could ask faster
 * would be asking for permission it is going to be refused.
 */
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

/**
 * What a stone's key is called, for the button and for anything read aloud.
 *
 * Here rather than in the component, so the label and the binding are one list:
 * a fourth key added above would be a fourth label without anybody remembering.
 * Empty past the end, which is a position with no key rather than a bug: a body
 * carries three stones at most, and everything after them in the row is a spell
 * it *has* rather than holds. @see CAST_CODES
 */
export function castKeyLabel(index: number): string {
  return CAST_LABELS[index] ?? "";
}

/**
 * The keys that press the Nth thing in whichever list the right-hand column is
 * showing: the lines of what is in reach, or a conversation's choices.
 *
 * The digit row, because both are lists and a list wants an index — one, two,
 * three is the one keyboard idiom that says "the first of these" without
 * anybody having to be told. Nine, because that is how many the row has before
 * zero, and zero reads as "none" rather than "tenth".
 *
 * The two lists never compete for the keys: a conversation takes the column
 * the list of what is in reach was drawn in, so only one of them is mounted and
 * bound at a time. See `../components/GameViewport`.
 */
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

/**
 * Press a number to press that entry of a list. Returns the unbind.
 *
 * Reports the position and nothing else, on {@link bindCastKeys}' terms: the list
 * is the caller's and changes every step, so only the caller can say what "the
 * third one" is at the moment of the press.
 */
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

/**
 * What an entry's key is called, or empty for an entry past the ninth.
 * @see NUMBER_CODES
 */
export function numberKeyLabel(index: number): string {
  return index < NUMBER_CODES.length ? String(index + 1) : "";
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
