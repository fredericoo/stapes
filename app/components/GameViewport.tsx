import { useCallback, useSyncExternalStore } from "react";
import type { Direction } from "../lib/types";
import { ChatBar } from "./ChatBar";
import { DirectionPad } from "./DirectionPad";

/**
 * The game as a fixed square, letterboxed into whatever space it is given.
 *
 * Everyone sees the same amount of world (see `../render/viewport`), so the
 * pane only decides how big it is drawn: on a phone the square sits at the top
 * with the arrows beneath it, on a desktop it grows until it hits the shorter
 * edge and the rest is ink.
 *
 * Chrome added below the square takes its height from the game rather than
 * covering it, and needs no sizing work to do so: the canvas is `100cqmin` of a
 * `flex-1` container, so anything in the flow underneath simply leaves it less
 * to be the smaller edge of. That is the lever to keep pulling as more UI
 * arrives.
 */

const COARSE_POINTER = "(pointer: coarse)";

function subscribeToPointerKind(onChange: () => void): () => void {
  const query = window.matchMedia(COARSE_POINTER);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * Is the primary input a finger?
 *
 * Drives whether the on-screen arrows are there at all. Deliberately about the
 * input device and not the window's shape — a desktop window dragged narrow is
 * still played with a keyboard, and growing a d-pad nobody will tap would just
 * take space away from the game.
 *
 * Server-rendered as false: the server cannot know, and a keyboard layout that
 * gains a pad on hydration is a smaller lie than a pad that vanishes.
 */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribeToPointerKind,
    () => window.matchMedia(COARSE_POINTER).matches,
    () => false,
  );
}

export function GameViewport({
  canvasRef,
  labelRef,
  onDirectionPress,
  onDirectionRelease,
  onSay,
  onTypingChange,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /**
   * Where in-world text is drawn — names and speech, over the canvas but not in
   * it. See `../render/textLabels` for why that text is DOM rather than pixels
   * in the drawing buffer.
   */
  labelRef?: React.RefObject<HTMLDivElement | null>;
  onDirectionPress: (direction: Direction) => void;
  onDirectionRelease: (direction: Direction) => void;
  /** Given only by a route with somebody to talk to; the bar is absent without it. */
  onSay?: (text: string) => void;
  onTypingChange?: (typing: boolean) => void;
}) {
  const coarse = useCoarsePointer();
  const press = useCallback(onDirectionPress, [onDirectionPress]);
  const release = useCallback(onDirectionRelease, [onDirectionRelease]);
  const noteTyping = useCallback(
    (typing: boolean) => onTypingChange?.(typing),
    [onTypingChange],
  );

  return (
    <div
      className="flex h-full w-full touch-manipulation flex-col items-center bg-ink select-none"
      style={{
        // A double-tap on a control is a double-tap-to-select gesture as far as
        // the browser is concerned, and dragging from it extends the selection.
        // With nothing selectable under the finger it reaches for the nearest
        // text that is — the chrome above — so the whole surface has to opt out,
        // not just the buttons: the gaps between them are where a fast thumb
        // actually lands. `touch-manipulation` drops the double-tap zoom that
        // rides along with it, while leaving pinch zoom alone.
        WebkitTouchCallout: "none",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <div
        // Top-aligned, not centred: where the pane is taller than the square —
        // a phone — the game belongs against the chrome with the controls
        // under it, rather than floating in the middle of two letterboxes.
        // Where the square is the taller way round it fills the pane and this
        // makes no difference.
        className="flex min-h-0 w-full flex-1 items-start justify-center overflow-hidden"
        // Sized container so the square below can be stated in terms of the
        // pane's shorter edge. `aspect-square` cannot do this on its own: a
        // definite height wins over the ratio, so clamping the width just
        // stretches the canvas instead of shrinking the box.
        style={{ containerType: "size" }}
      >
        <div
          className="relative"
          style={{ width: "100cqmin", height: "100cqmin" }}
        >
          <canvas
            ref={canvasRef}
            className="block h-full w-full touch-none"
            style={{ imageRendering: "pixelated" }}
          />
          {/* Sized and positioned by app.css; the render loop writes into it. */}
          <div ref={labelRef} className="world-label-layer" />
        </div>
      </div>

      {onSay ? <ChatBar onSay={onSay} onTypingChange={noteTyping} /> : null}

      {coarse ? (
        <div className="flex shrink-0 items-center justify-center py-4">
          <DirectionPad onPress={press} onRelease={release} />
        </div>
      ) : null}
    </div>
  );
}
