import { Popover } from "@base-ui/react/popover";
import { IconMessage } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_CHAT_LENGTH } from "../net/chat";
import { isTypingTarget } from "../game/heldDirections";
import { Tooltip } from "../ui/Tooltip";
import { ACTION_BUTTON_SIZE_CLASS } from "./ModeSwitch";

/**
 * Where you type what you say, in the two shapes it needs to be.
 *
 * On a desktop it is a bar under the game area: there is room for it, a keyboard
 * can reach it without aiming, and Enter puts the cursor in it from anywhere.
 *
 * On a phone it is a button that opens the field, because the bar was costing
 * the game a permanent row to hold a field that is empty almost all the time —
 * and a phone is where that row is worth the most. The button sits with the two
 * mode toggles, which is the honest place for it: talking is a third thing a tap
 * can mean, and it belongs beside looking and fighting rather than above them.
 */

/**
 * The field itself, and the button that sends it.
 *
 * Shared by both shapes rather than written twice — the trimming, the cap, and
 * the two ways out of the field are the behaviour, and two copies of it would be
 * two things to keep in step.
 */
function ChatComposer({
  onSay,
  onTypingChange,
  onSent,
  focusOnEnter = false,
  autoFocus = false,
}: {
  onSay: (text: string) => void;
  onTypingChange: (typing: boolean) => void;
  /** Called once something has actually been said, so a popup can close itself. */
  onSent?: () => void;
  /** Bind Enter anywhere on the page to reach for this field. Desktop only. */
  focusOnEnter?: boolean;
  autoFocus?: boolean;
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
    onSent?.();
    return true;
  }, [onSay, onSent, text]);

  /**
   * Enter from anywhere reaches for the field.
   *
   * Ignored when anything else already holds focus, so it cannot steal the key
   * from a button being activated, or from the field itself — once you are in
   * the field, Enter means send, and that is handled there.
   */
  useEffect(() => {
    if (!focusOnEnter) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.repeat) return;
      if (isTypingTarget(event.target)) return;
      if (document.activeElement !== document.body) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusOnEnter]);

  // Unmounting while focused would leave the caller believing you are still
  // typing, and the keys held for good. Which is not a hypothetical here: the
  // phone's field lives in a popup and unmounts every time it closes.
  useEffect(() => () => onTypingChange(false), [onTypingChange]);

  return (
    <>
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
        autoFocus={autoFocus}
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
    </>
  );
}

/**
 * The field, always out. Chrome stays chrome: it takes its space from the game
 * square below the canvas rather than covering it.
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
  return (
    <div className="flex w-full shrink-0 items-center gap-2 px-3 py-2">
      <ChatComposer
        onSay={onSay}
        onTypingChange={onTypingChange}
        focusOnEnter
      />
    </div>
  );
}

/**
 * The field, behind a button.
 *
 * Opened rather than always there because on a phone the row it occupied was
 * permanent and its usefulness was not. Focused on open, so the one tap that
 * asked for it is the only tap it costs, and closed on send — saying something
 * is a detour out of playing, exactly as Enter treats it on a keyboard.
 */
export function ChatButton({
  onSay,
  onTypingChange,
}: {
  onSay: (text: string) => void;
  onTypingChange: (typing: boolean) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip content="Say something">
        <Popover.Trigger
          aria-label="Say something"
          className={[
            "flex items-center justify-center border-2 shadow-hard",
            ACTION_BUTTON_SIZE_CLASS.touch,
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            // Lit while the field is open, on the same terms the mode toggles
            // are lit: something is claiming your taps and the screen says so.
            "border-paper/40 bg-transparent text-paper data-[popup-open]:border-paper data-[popup-open]:bg-paper data-[popup-open]:text-ink",
          ].join(" ")}
        >
          <IconMessage size={24} stroke={2} aria-hidden="true" />
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="start">
          {/* As wide as the screen allows: a field you have opened on purpose
              should not also be a small target to type into. */}
          <Popover.Popup className="z-50 flex w-80 max-w-[calc(100vw-1.5rem)] items-center gap-2 border-2 border-border bg-ink p-2 text-paper shadow-hard">
            <ChatComposer
              onSay={onSay}
              onTypingChange={onTypingChange}
              onSent={() => setOpen(false)}
              autoFocus
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
