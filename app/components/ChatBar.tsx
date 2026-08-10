import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_CHAT_LENGTH } from "../net/chat";
import { isTypingTarget } from "../game/heldDirections";

/**
 * Where you type what you say.
 *
 * One bar, under the game area, on every device — not an overlay and not a
 * phone-only affordance. Chrome stays chrome: the canvas draws the world and
 * nothing else, and as more UI arrives it takes its space from the square rather
 * than covering it.
 *
 * The button and the Enter key are the same control seen twice. A thumb needs
 * something to hit; a keyboard needs never to reach for the mouse mid-game.
 */

export function ChatBar({
  onSay,
  onTypingChange,
}: {
  onSay: (text: string) => void;
  /**
   * Called when the field takes or loses focus.
   *
   * The caller has to drop whatever direction is held: `bindKeyboard` ignores
   * keys aimed at a text field, so a key held at the moment you focus one never
   * sees its keyup and would stick — the avatar walking off on its own while you
   * type. Window blur covers losing the tab; focusing a field in the same
   * document fires no such event, which is why this has to be said out loud.
   */
  onTypingChange: (typing: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");

  const send = useCallback(() => {
    const trimmed = text.trim();
    // Nothing to say is not an error, it is just nothing. The empty Enter has a
    // job of its own — see the keydown below.
    if (trimmed.length === 0) return false;
    onSay(trimmed);
    setText("");
    return true;
  }, [onSay, text]);

  /**
   * Enter from anywhere reaches for the field.
   *
   * Ignored when anything else already holds focus, so it cannot steal the key
   * from a button being activated, or from the field itself — once you are in
   * the field, Enter means send, and that is handled there.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.repeat) return;
      if (isTypingTarget(event.target)) return;
      if (document.activeElement !== document.body) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Unmounting while focused would leave the caller believing you are still
  // typing, and the keys held for good.
  useEffect(() => () => onTypingChange(false), [onTypingChange]);

  return (
    <div className="flex w-full shrink-0 items-center gap-2 px-3 py-2">
      <input
        ref={inputRef}
        type="text"
        value={text}
        // The server applies this again. The attribute is a courtesy that keeps
        // the field from looking like it accepts more than it does, not the
        // enforcement — that cannot live in a browser.
        maxLength={MAX_CHAT_LENGTH}
        placeholder="Say something"
        aria-label="Say something"
        autoComplete="off"
        className="min-w-0 flex-1 border-2 border-paper/40 bg-ink px-2 py-1 text-sm text-paper placeholder:text-paper/40 focus:border-paper focus:outline-none"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.currentTarget.blur();
            return;
          }
          if (e.key !== "Enter") return;
          e.preventDefault();
          // Either way the keys go back to the game. Saying something is a
          // detour out of playing, not a mode you stay in: Enter, type, Enter
          // leaves you walking again, and Enter on an empty field is the way out
          // when you change your mind. Another Enter is all it costs to come
          // back, which is cheaper than being stuck typing.
          send();
          e.currentTarget.blur();
        }}
        onFocus={() => onTypingChange(true)}
        onBlur={() => onTypingChange(false)}
      />
      <button
        type="button"
        className="shrink-0 border-2 border-paper/40 px-3 py-1 text-xs uppercase text-paper hover:border-paper disabled:opacity-40"
        disabled={text.trim().length === 0}
        // The click already blurred the field on its way here, which is where we
        // want to end up — same rule as Enter: sending puts you back in the game.
        onClick={() => send()}
      >
        Say
      </button>
    </div>
  );
}
