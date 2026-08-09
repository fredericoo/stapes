import { useCallback, useSyncExternalStore } from "react";
import type { Direction } from "../lib/types";
import { DirectionPad } from "./DirectionPad";

/**
 * The game as a fixed square, letterboxed into whatever space it is given.
 *
 * Everyone sees the same amount of world (see `../render/viewport`), so the
 * pane only decides how big it is drawn: on a phone the square sits at the top
 * with the arrows beneath it, on a desktop it grows until it hits the shorter
 * edge and the rest is ink.
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
  hint,
  onDirectionPress,
  onDirectionRelease,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Keyboard help. Shown only where there is a keyboard to help. */
  hint?: React.ReactNode;
  onDirectionPress: (direction: Direction) => void;
  onDirectionRelease: (direction: Direction) => void;
}) {
  const coarse = useCoarsePointer();
  const press = useCallback(onDirectionPress, [onDirectionPress]);
  const release = useCallback(onDirectionRelease, [onDirectionRelease]);

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
          {!coarse && hint ? (
            <div className="pointer-events-none absolute bottom-2 left-2 right-2 text-xs text-paper/70">
              {hint}
            </div>
          ) : null}
        </div>
      </div>

      {coarse ? (
        <div className="flex shrink-0 items-center justify-center py-4">
          <DirectionPad onPress={press} onRelease={release} />
        </div>
      ) : null}
    </div>
  );
}
