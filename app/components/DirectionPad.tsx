import type { Direction } from "../lib/types";

/**
 * On-screen arrows, for playing without a keyboard.
 *
 * Press and release rather than click: walking is a held state, and a control
 * that only fires on click could not express "keep going". Each button tracks
 * the pointer that pressed it, so two thumbs work and a finger that slides off
 * releases rather than sticking — the same failure the keyboard's blur handler
 * exists to prevent.
 */

const LAYOUT: { direction: Direction; label: string; glyph: string; cell: string }[] = [
  { direction: "n", label: "Walk north", glyph: "▲", cell: "col-start-2 row-start-1" },
  { direction: "w", label: "Walk west", glyph: "◀", cell: "col-start-1 row-start-2" },
  { direction: "e", label: "Walk east", glyph: "▶", cell: "col-start-3 row-start-2" },
  { direction: "s", label: "Walk south", glyph: "▼", cell: "col-start-2 row-start-3" },
];

export function DirectionPad({
  onPress,
  onRelease,
}: {
  onPress: (direction: Direction) => void;
  onRelease: (direction: Direction) => void;
}) {
  return (
    <div
      className="grid grid-cols-3 grid-rows-3 gap-2 select-none"
      // The pad is a control surface, not a document: without this a drag
      // across it scrolls the page or triggers pull-to-refresh mid-walk.
      style={{ touchAction: "none" }}
    >
      {LAYOUT.map(({ direction, label, glyph, cell }) => (
        <button
          key={direction}
          type="button"
          aria-label={label}
          // `touch-none` on each button as well as the grid: touch-action is
          // not inherited, so without it a drag that starts on a button still
          // scrolls the page out from under the game.
          className={`${cell} flex h-14 w-14 touch-none items-center justify-center border-2 border-paper/40 bg-ink text-lg text-paper select-none active:bg-paper active:text-ink`}
          onPointerDown={(e) => {
            e.preventDefault();
            onPress(direction);
            // Capture so the release lands here even if the finger wanders off
            // the button before lifting. Best-effort, and after the press: a
            // pointer that is already gone cannot be captured, and that must
            // not cost us the walk we just started.
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              // No live pointer to capture — the release will find us anyway.
            }
          }}
          onPointerUp={() => onRelease(direction)}
          onPointerCancel={() => onRelease(direction)}
          // Enter and Space are how a button is pressed without a pointer, and
          // they hold like a key rather than firing once.
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            if (e.repeat) return;
            onPress(direction);
          }}
          onKeyUp={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            onRelease(direction);
          }}
          onBlur={() => onRelease(direction)}
        >
          <span aria-hidden="true">{glyph}</span>
        </button>
      ))}
    </div>
  );
}
