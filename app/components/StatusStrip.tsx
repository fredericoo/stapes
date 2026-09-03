import { useEffect, useRef, useState } from "react";
import type { ActiveStatus } from "../lib/status";
import type { TilesetDef } from "../lib/types";
import { Tooltip } from "../ui";
import { TITLE_SPRITE_SIZE_PX } from "./ContainerPanel";
import { SpritePreview } from "./TilePreview";

/**
 * What you are under, at a glance.
 *
 * The strip is the glance and `./StatsPanel` is the answer, and that split is
 * what lets this carry no text at all: an icon nobody can name is useless on its
 * own and perfectly good as a reminder that there is something to go and read.
 *
 * **Nothing here is a control.** Not a button, not focusable, and nothing a tap
 * does anything to. What it does have is a tooltip carrying the description, and
 * that is not a contradiction — see {@link StatusStrip} on why hover and the
 * direction pad never coexist.
 */

/**
 * The sprite itself, sized to the thumbnail beside a container's name.
 *
 * **Not the item slot**, which is what this was first built at and was far too
 * big: a 44px cell holding a 32px sprite made a lane of five statuses as heavy as
 * the bag under it, and it competed with the game rather than annotating it. A
 * status is a mark beside a name — the same job the chest sprite does in a
 * container heading — and that is the size it wants.
 */
export const STATUS_ICON_SIZE_PX = TITLE_SPRITE_SIZE_PX;

/**
 * The cell the sprite sits in.
 *
 * A few pixels of margin rather than the sprite's own box, so that art of wildly
 * different weight lands on one rhythm. Measured on the placeholders, the ink in
 * a status sprite ranges over 14× — a 1×1 torch against a 2×2 potion — and
 * without a common footprint a lane of them reads as scattered debris rather
 * than a row.
 */
export const STATUS_CELL_SIZE_PX = 24;

/** The gap between cells, in the same units the capacity arithmetic counts in. */
export const STATUS_ICON_GAP_PX = 4;

/** How tall the countdown bar under each icon is. */
export const STATUS_BAR_HEIGHT_PX = 3;

/** Gap between the sprite and its bar, so the two read as one cell. */
const STATUS_BAR_GAP_PX = 1;

/**
 * How many cells fit in a lane this long.
 *
 * Arithmetic rather than layout, and that is the whole reason it is a function
 * here instead of CSS in the component: every cell is the same fixed size, so
 * unlike a label there is nothing to measure per item. One length in, one count
 * out, and it can be asserted without a browser.
 */
export function statusStripCapacity(availablePx: number): number {
  if (availablePx <= 0) return 0;
  const stride = STATUS_CELL_SIZE_PX + STATUS_ICON_GAP_PX;
  return Math.max(0, Math.floor((availablePx + STATUS_ICON_GAP_PX) / stride));
}

/**
 * Harmful first, then longest-remaining, then whatever order they arrived in.
 *
 * The last two terms are `./StatsPanel`'s existing discipline: two equal rows
 * must not swap places between renders for no reason a player could see, and a
 * countdown makes ties constant.
 *
 * **The first term is the whole point of a bounded strip.** When something has to
 * be dropped into a `+N`, the thing that gets dropped must not be the poison.
 */
export function compareStatuses(a: ActiveStatus, b: ActiveStatus): number {
  if (a.tone !== b.tone) return a.tone === "bad" ? -1 : 1;
  return b.remainingMs - a.remainingMs;
}

/**
 * What is drawn, and how many did not fit.
 *
 * **The `+N` claims the last cell** rather than appearing beside a full row, so
 * four statuses in three cells is two icons and `+2` — never three icons and a
 * silently hidden fourth. A strip that truncated quietly would be a strip that
 * lies, and saying "there is something to go and look at" is the only job it has.
 */
export function splitForCapacity(
  statuses: ActiveStatus[],
  capacity: number,
): { shown: ActiveStatus[]; overflow: number } {
  if (capacity <= 0) return { shown: [], overflow: 0 };
  if (statuses.length <= capacity) return { shown: statuses, overflow: 0 };
  const shown = statuses.slice(0, capacity - 1);
  return { shown, overflow: statuses.length - shown.length };
}

/**
 * How full a status's bar is, as a fraction of 1.
 *
 * **A figure was tried here first and could not be read.** Three glyphs over an
 * 18px sprite buried the picture and still made you stop and parse a number, for
 * something you only ever want to know approximately — a bar answers "nearly
 * gone" or "plenty left" without being read at all.
 *
 * Safe against a zero or missing ceiling, which a hand-authored file can produce:
 * an empty bar is the honest answer when nothing says how long full is.
 */
export function statusFraction(status: ActiveStatus): number {
  if (!(status.fullDurationMs > 0)) return 0;
  return Math.max(0, Math.min(1, status.remainingMs / status.fullDurationMs));
}

/**
 * The always-present icon lane.
 *
 * **It occupies its space whether or not anything is in it.** A strip that
 * appeared on the first berry would push the modes row down on a desktop and
 * slide the direction pad sideways on a phone — a control moving under the thumb
 * that is using it, caused by something happening elsewhere in the game. A lane
 * of empty chrome is strictly the cheaper of the two.
 *
 * **A finger's lane takes no pointer events; a cursor's does.** On a phone the
 * lane sits directly above `./DirectionPad`, which reads pointer *geometry* off
 * its own element rather than which button was hit. A thumb that started its
 * stroke on the lane would have the `pointerdown` swallowed by a decoration and
 * simply not walk, so on a coarse pointer everything passes straight through.
 *
 * That is also why the tooltip is gated on the same flag rather than on anything
 * of its own: hover is what a cursor has and a thumb does not, so the one
 * condition answers both questions at once. On a phone the icon and its badge are
 * the whole of what the lane says, and the panel carries the sentence.
 */
export function StatusStrip({
  statuses,
  interactive,
  tilesets,
  className = "",
}: {
  statuses: ActiveStatus[];
  /**
   * Whether this lane may be pointed at — true on a cursor, false on a thumb.
   * Decides both the tooltip and whether events reach it at all.
   */
  interactive: boolean;
  tilesets: TilesetDef[];
  className?: string;
}) {
  const laneRef = useRef<HTMLUListElement>(null);
  const [widthPx, setWidthPx] = useState(0);

  useEffect(() => {
    const lane = laneRef.current;
    if (!lane) return;
    const observer = new ResizeObserver(() => setWidthPx(lane.clientWidth));
    observer.observe(lane);
    setWidthPx(lane.clientWidth);
    return () => observer.disconnect();
  }, []);

  const ordered = [...statuses].sort(compareStatuses);
  const { shown, overflow } = splitForCapacity(
    ordered,
    statusStripCapacity(widthPx),
  );

  return (
    <ul
      ref={laneRef}
      // Named as a group, and every child is a `role="img"` rather than a
      // control: a screen reader can find the list and read what is in it
      // without each icon becoming a tab stop. No duration in any label — that
      // is the panel's job, and a label that changed every second would have a
      // screen reader narrate an hour of being fed.
      aria-label="Effects"
      className={[
        "flex w-full shrink-0 items-center gap-1 overflow-hidden",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        // Height is fixed so the lane never grows with its contents, and width is
        // whatever the parent gives it — which is what makes the measured length
        // the *available* space rather than the used space.
        //
        // The **cell**, not the sprite. Sizing it to the art clipped every cell's
        // margin away against `overflow-hidden`, which is invisible until the two
        // constants differ — they were one number when this was written.
        height: STATUS_CELL_SIZE_PX,
        ...(interactive ? null : { pointerEvents: "none" as const }),
      }}
    >
      {shown.map((status) => (
        <StatusCell key={status.defId} status={status} tooltip={interactive}>
          {/* A bare sprite rather than a tile, and so nothing to animate: a
              lane of independently ticking thumbnails would compete for the
              frame budget of the game drawn beside them. */}
          <SpritePreview
            sprite={status.icon}
            tilesets={tilesets}
            size={STATUS_ICON_SIZE_PX}
          />
          <StatusBar status={status} />
        </StatusCell>
      ))}
      {overflow > 0 ? (
        <li
          role="img"
          aria-label={`${overflow} more`}
          className="grid shrink-0 place-items-center text-[10px] font-bold tabular-nums text-paper/60"
          style={{ width: STATUS_CELL_SIZE_PX, height: STATUS_CELL_SIZE_PX }}
        >
          +{overflow}
        </li>
      ) : null}
    </ul>
  );
}

/**
 * One icon, and the tooltip that says what it is.
 *
 * **The tooltip carries the name *and* the line**, where the panel splits them
 * across a row and its own tooltip. Out here there is almost no text at all, so
 * the name is the first thing the tooltip owes and the description the second — a
 * popup saying only "Slowly recovering health." beside an unnamed icon would be an
 * answer to a question nobody could have asked.
 *
 * It prints nothing at all. How long is left is the bar underneath — see
 * {@link StatusBar} — and the exact figure is the panel's.
 */
function StatusCell({
  status,
  tooltip,
  children,
}: {
  status: ActiveStatus;
  tooltip: boolean;
  children: React.ReactNode;
}) {
  const cell = (
    <li
      role="img"
      aria-label={`${status.name}. ${status.description}`}
      className="flex shrink-0 flex-col items-center justify-center"
      style={{
        width: STATUS_CELL_SIZE_PX,
        height: STATUS_CELL_SIZE_PX,
        gap: STATUS_BAR_GAP_PX,
      }}
    >
      {children}
    </li>
  );

  if (!tooltip) return cell;

  return (
    <Tooltip
      content={
        <span className="flex flex-col">
          <span className="font-bold">{status.name}</span>
          <span>{status.description}</span>
        </span>
      }
      side="bottom"
    >
      {cell}
    </Tooltip>
  );
}

/**
 * How much of a status is left, drawn rather than printed.
 *
 * Full width of the cell so a row of them lines up as a row, and stepped in
 * whole pixels for the same reason the health bar over a head is: this is pixel
 * art, and a fill that slid by fractions would be the one soft edge on screen.
 *
 * Tone rather than a colour of its own, so the bar, the panel row's name and the
 * order the lane is sorted in are all saying the same thing about the same
 * status.
 */
function StatusBar({ status }: { status: ActiveStatus }) {
  const fraction = statusFraction(status);
  // **Anything still running keeps a pixel**, the same rounding
  // `healthBarFillBricks` does and for the same reason: an empty bar says the
  // status is over, and it is not. It matters far more here than it does there —
  // a status measured against a ceiling it is nowhere near rounds to nothing for
  // most of its life. See {@link fullDurationMs}.
  const filled =
    fraction > 0 ? Math.max(1, Math.round(fraction * STATUS_CELL_SIZE_PX)) : 0;

  return (
    <span
      aria-hidden="true"
      className="block shrink-0 bg-paper/20"
      style={{ width: STATUS_CELL_SIZE_PX, height: STATUS_BAR_HEIGHT_PX }}
    >
      <span
        className={`block h-full ${status.tone === "bad" ? "bg-danger" : "bg-paper/70"}`}
        style={{ width: filled }}
      />
    </span>
  );
}
