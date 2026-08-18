import { useEffect, useRef, useState } from "react";
import type { ActiveStatus } from "../lib/status";
import type { TileDef, TilesetDef } from "../lib/types";
import { secondsLeft } from "../game/statuses";
import { Tooltip } from "../ui";
import { TITLE_SPRITE_SIZE_PX } from "./ContainerPanel";
import { TilePreview } from "./TilePreview";

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

/**
 * The longest countdown a corner badge will print, in seconds.
 *
 * Past this the badge is dropped rather than widened or abbreviated, and the
 * dropping is the feature. Three glyphs is what fits over an 18px sprite without
 * burying it, and a status with minutes left is one whose exact remainder nobody
 * is watching — the interesting number is on a poison about to run out, not on an
 * hour of being fed. The panel still has the figure for anything that wants it.
 */
export const MAX_BADGED_SECONDS = 99;

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
 * Whole seconds left, or null where the countdown is too long to print.
 *
 * The seconds themselves come from `../game/statuses`, which is the same reading
 * the formulas are evaluated against — a badge that rounded on its own would show
 * `31s` on a thirty-second status about half the time.
 */
export function badgeSeconds(remainingMs: number): number | null {
  const seconds = secondsLeft(remainingMs);
  return seconds > MAX_BADGED_SECONDS ? null : seconds;
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
  tilesById,
  tilesets,
  className = "",
}: {
  statuses: ActiveStatus[];
  /**
   * Whether this lane may be pointed at — true on a cursor, false on a thumb.
   * Decides both the tooltip and whether events reach it at all.
   */
  interactive: boolean;
  tilesById: Record<string, TileDef>;
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
      className={["flex w-full shrink-0 items-center gap-1 overflow-hidden", className]
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
          {/* Still, because an icon in a lane is an *identifier* rather than a
              subject: a row of independently animating thumbnails competes for
              the frame budget of the game drawn beside them. */}
          <TilePreview
            tile={tilesById[status.iconTileId] ?? null}
            tilesets={tilesets}
            size={STATUS_ICON_SIZE_PX}
            direction="s"
            still
            chrome={false}
            background={null}
          />
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
 * The one thing it does print is the countdown, and only while that is short
 * enough to read in a corner. See {@link MAX_BADGED_SECONDS}.
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
  const seconds = badgeSeconds(status.remainingMs);

  const cell = (
      <li
        role="img"
        aria-label={`${status.name}. ${status.description}`}
        className="relative grid shrink-0 place-items-center"
        style={{ width: STATUS_CELL_SIZE_PX, height: STATUS_CELL_SIZE_PX }}
      >
        {children}
        {/* In the corner rather than beside it, on exactly the terms the bag
            button's fullness is: the lane is a row of equal cells and one that
            grew a caption would break that rank.

            Inside the cell rather than hung off it — `-bottom-1 -right-1` is what
            the bag does, and the lane is `overflow-hidden` at exactly the cell's
            size, so anything outside is clipped away.

            Hidden from the reader, who has the name in the label above. A figure
            that changed every second would have a screen reader narrate the whole
            countdown, which is the thing `MasteryProgress` already refuses to do. */}
        {seconds === null ? null : (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 right-0 bg-ink px-px text-[9px] font-bold leading-none tabular-nums text-paper/80"
          >
            {seconds}s
          </span>
        )}
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
