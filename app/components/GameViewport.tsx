import { useCallback } from "react";
import type { InteractionOption } from "../game/interactionOptions";
import type { Direction, TileDef, TilesetDef } from "../lib/types";
import { useMediaQuery } from "../lib/useMediaQuery";
import { ChatBar } from "./ChatBar";
import { DirectionPad } from "./DirectionPad";
import { InteractionList } from "./InteractionList";
import { LookToggle } from "./LookToggle";

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
 * box that is square by ratio and allowed to shrink, so anything in the flow
 * underneath simply leaves it less to be the smaller edge of. Chrome added
 * *beside* it — the interaction list on a desktop — works the same way round,
 * narrowing the column the square measures itself against. That is the lever to
 * keep pulling as more UI arrives.
 */

/**
 * Room for the interaction list beside the game, on a pointer that has hover.
 *
 * Fixed rather than fluid, and always present even while empty: it comes out of
 * the square's width, so a column that appeared and vanished with its contents
 * would resize the canvas every time the player walked past a crate.
 */
const INTERACTION_PANEL_WIDTH_PX = 224;

const COARSE_POINTER = "(pointer: coarse)";

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
  return useMediaQuery(COARSE_POINTER);
}

export function GameViewport({
  canvasRef,
  labelRef,
  onDirectionPress,
  onDirectionRelease,
  onSay,
  onTypingChange,
  looking = false,
  onLookingChange,
  interactions = [],
  onInteract,
  onHoverInteraction,
  tiles = [],
  tilesets = [],
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
  /**
   * Look mode, for input devices that have no shift key. The button is drawn
   * only where the arrows are — a keyboard already has a better way to do this,
   * and a second control saying the same thing is one more thing on screen.
   */
  looking?: boolean;
  onLookingChange?: (looking: boolean) => void;
  /**
   * What is within reach right now, worked out by whoever owns the session —
   * see `../game/interactionOptions`. Empty by default so a route that has not
   * wired it up shows the panel saying so rather than crashing.
   */
  interactions?: InteractionOption[];
  onInteract?: (option: InteractionOption) => void;
  /**
   * The row being pointed at, so the world can outline its subject. Wired only
   * where there is a pointer that hovers — see the call site.
   */
  onHoverInteraction?: (optionId: string | null) => void;
  /** Catalogue behind the list's sprites. */
  tiles?: TileDef[];
  tilesets?: TilesetDef[];
}) {
  const coarse = useCoarsePointer();
  const press = useCallback(onDirectionPress, [onDirectionPress]);
  const release = useCallback(onDirectionRelease, [onDirectionRelease]);
  const noteTyping = useCallback(
    (typing: boolean) => onTypingChange?.(typing),
    [onTypingChange],
  );

  const list = (
    <InteractionList
      options={interactions}
      tiles={tiles}
      tilesets={tilesets}
      onAct={(option) => onInteract?.(option)}
      // Not on a finger. A touch browser synthesises a mouse-enter on tap and
      // never sends the matching leave, so the outline it lit would stay lit
      // over whatever the player did next.
      onHover={coarse ? undefined : onHoverInteraction}
      className="min-h-0 w-full flex-1"
    />
  );

  return (
    <div className="flex h-full w-full bg-ink">
      <div
        className="flex h-full min-w-0 flex-1 touch-manipulation flex-col items-center select-none"
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
          // Square by ratio and allowed to shrink, rather than taking every
          // pixel of free height. Both halves are what hands the leftover to
          // the controls underneath: on a phone the game is bound by the *width*
          // and everything below the square used to be dead space inside this
          // box, which is precisely the room the interaction list wants. Shrink
          // is what keeps a rotated phone honest — the box gives height back
          // when there is not enough to be square in, and `100cqmin` letterboxes
          // the game inside whatever is left.
          className="flex w-full min-h-0 shrink aspect-square items-center justify-center overflow-hidden"
          // Sized container so the square below can be stated in terms of the
          // box's shorter edge. The ratio alone cannot do this: it is the box
          // that is square, and a shrunk box is not.
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
          // Reading hand on the left, walking thumb on the right. The arrows go
          // to the side most thumbs are, and the two things you *read* before
          // acting — what is in reach, and whether you are looking rather than
          // touching — sit together on the other, where they are out from under
          // the hand that is steering.
          <div className="flex w-full min-h-0 flex-1 items-stretch gap-3 px-3 py-3">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col items-start gap-2">
              {list}
              {onLookingChange ? (
                <LookToggle looking={looking} onChange={onLookingChange} />
              ) : null}
            </div>
            <div className="flex shrink-0 items-center">
              <DirectionPad onPress={press} onRelease={release} />
            </div>
          </div>
        ) : null}
      </div>

      {coarse ? null : (
        <aside
          className="flex h-full shrink-0 flex-col border-l-2 border-paper/20 p-2"
          style={{ width: INTERACTION_PANEL_WIDTH_PX }}
        >
          {list}
        </aside>
      )}
    </div>
  );
}
