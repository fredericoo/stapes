import { Popover } from "@base-ui/react/popover";
import { IconMessage } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_CHAT_LENGTH } from "../net/chat";
import { isTypingTarget } from "../game/heldDirections";
import { Tooltip } from "../ui/Tooltip";
import { ACTION_BUTTON_SIZE_CLASS } from "./actionButton";

function ChatComposer({
  onSay,
  onTypingChange,
  onSent,
  focusOnEnter = false,
  autoFocus = false,
}: {
  onSay: (text: string) => void;
  onTypingChange: (typing: boolean) => void;
  onSent?: () => void;
  focusOnEnter?: boolean;
  autoFocus?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");

  const send = useCallback(() => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return false;
    onSay(trimmed);
    setText("");
    onSent?.();
    return true;
  }, [onSay, onSent, text]);

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

  useEffect(() => () => onTypingChange(false), [onTypingChange]);

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        value={text}
        maxLength={MAX_CHAT_LENGTH}
        placeholder="Say something"
        aria-label="Say something"
        autoComplete="off"
        autoFocus={autoFocus}
        className="min-w-0 flex-1 border-2 border-paper/40 bg-ink px-2 py-1 text-sm text-paper placeholder:text-paper/40 pointer-coarse:text-base focus:border-paper focus:outline-none"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.currentTarget.blur();
            return;
          }
          if (e.key !== "Enter") return;
          e.preventDefault();
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
        onClick={() => send()}
      >
        Say
      </button>
    </>
  );
}

export function ChatBar({
  onSay,
  onTypingChange,
}: {
  onSay: (text: string) => void;
  onTypingChange: (typing: boolean) => void;
}) {
  return (
    <div className="flex w-full shrink-0 items-center gap-2 px-3 py-2">
      <ChatComposer onSay={onSay} onTypingChange={onTypingChange} focusOnEnter />
    </div>
  );
}

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
            "border-paper/40 bg-transparent text-paper data-[popup-open]:border-paper data-[popup-open]:bg-paper data-[popup-open]:text-ink",
          ].join(" ")}
        >
          <IconMessage size={24} stroke={2} aria-hidden="true" />
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="start">
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
