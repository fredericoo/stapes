import { IconBackpack, IconHeartbeat, IconShirt } from "@tabler/icons-react";
import { useCallback, useRef } from "react";
import type { Equipment } from "../game/equipment";
import { equipDestination } from "../game/itemMoves";
import { resolveContainer } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import type { TileDef, TilesetDef } from "../lib/types";
import { Tooltip } from "../ui/Tooltip";
import { ACTION_BUTTON_SIZE_CLASS, type ActionButtonSize } from "./ModeSwitch";
import type { ItemDrag } from "./useItemDrag";
import { useTap } from "./useTap";

/**
 * The buttons that open what you are carrying, and what you are.
 *
 * Drawn in the same row and at the same size as the mode toggles, and
 * deliberately *not* coloured like them. A mode toggle wears the colour of the
 * outline it puts in the world, which is a promise these cannot keep: opening a
 * panel changes nothing out there. So on is plain paper — clearly a state, and
 * clearly not one of the two modes.
 */

function toggleClass(on: boolean, size: ActionButtonSize): string {
  return [
    "flex items-center justify-center border-2 shadow-hard",
    ACTION_BUTTON_SIZE_CLASS[size],
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
    on
      ? "border-paper bg-paper text-ink"
      : "border-paper/40 bg-transparent text-paper",
  ].join(" ");
}

/** Show or hide what you can take and what you are good at. */
export function StatsToggle({
  open,
  onChange,
  size = "touch",
}: {
  open: boolean;
  onChange: (open: boolean) => void;
  size?: ActionButtonSize;
}) {
  // Pointer-driven rather than click-driven, so the row still answers a thumb
  // that is holding the d-pad down. See `./useTap`.
  const tap = useTap(() => onChange(!open));

  return (
    <Tooltip content="Stats">
      <button
        type="button"
        aria-pressed={open}
        aria-label="Stats"
        {...tap}
        className={toggleClass(open, size)}
      >
        <IconHeartbeat
          size={size === "touch" ? 24 : 18}
          stroke={2}
          aria-hidden="true"
        />
      </button>
    </Tooltip>
  );
}

/**
 * The registry key the equipment button holds a drop target under.
 *
 * Its own key rather than a square's, for the reason the bag button has one:
 * the square a drop resolves to may already be on screen in the open panel, and
 * two elements cannot share one entry. See {@link BAG_BUTTON_TARGET_KEY}.
 */
const EQUIPMENT_BUTTON_TARGET_KEY = "equipment-button";

/**
 * Show or hide what you are wearing, and equip what is dropped on it.
 *
 * **A drop here names no square.** Everywhere else a drag says exactly where a
 * thing goes; this button says only "wear this", and where that is comes from
 * `../game/itemMoves`' `equipDestination` — the square the thing belongs in, or
 * the other hand when the first is full. That is the same answer a tap on the
 * item gives, so the two gestures cannot send one sword to two places.
 *
 * It exists because the panel is a detour. Wearing something out of your bag
 * meant opening the equipment panel to have a square to aim at — and on a phone
 * that panel replaces the bag you are dragging out of, so the two squares were
 * never on screen together. The button is on screen whether the panel is open
 * or not.
 */
export function EquipmentToggle({
  open,
  onChange,
  equipment,
  tilesById,
  drag,
  size = "touch",
}: {
  open: boolean;
  onChange: (open: boolean) => void;
  /** What is already worn, which is half of where a dropped thing can go. */
  equipment: Equipment;
  tilesById: Record<string, TileDef>;
  /** The one move in progress, page-wide. See `./useItemDrag`. */
  drag: ItemDrag;
  size?: ActionButtonSize;
}) {
  const { register } = drag;
  // The kit is read through a ref rather than closed over, so the resolver
  // keeps one identity for the life of the button: it is handed to `register`
  // by a ref callback, and one that changed whenever a snapshot arrived would
  // tear this target down and rebuild it on every frame the game drew.
  const latest = useRef({ equipment, tilesById });
  latest.current = { equipment, tilesById };
  const destination = useCallback(
    (instance: ItemInstance) =>
      equipDestination(
        latest.current.equipment,
        latest.current.tilesById,
        instance,
      ),
    [],
  );
  const attach = useCallback(
    (el: HTMLElement | null) =>
      register(EQUIPMENT_BUTTON_TARGET_KEY, destination, el),
    [register, destination],
  );

  const wouldTake = drag.targets.has(EQUIPMENT_BUTTON_TARGET_KEY);
  const isOver = drag.over === EQUIPMENT_BUTTON_TARGET_KEY;

  // Pointer-driven rather than click-driven, so the row still answers a thumb
  // that is holding the d-pad down. See `./useTap`.
  const tap = useTap(() => onChange(!open));

  return (
    <Tooltip content="Equipment">
      <button
        type="button"
        ref={attach}
        aria-pressed={open}
        aria-label="Equipment"
        {...tap}
        className={[
          toggleClass(open, size),
          isOver
            ? "border-accent bg-accent/30"
            : wouldTake
              ? "border-accent/60"
              : "",
        ].join(" ")}
        // Without this a finger dragging over the button scrolls the page
        // instead, and the moves stop arriving — the same reason a slot sets it.
        style={{ touchAction: "none" }}
      >
        <IconShirt
          size={size === "touch" ? 24 : 18}
          stroke={2}
          aria-hidden="true"
        />
      </button>
    </Tooltip>
  );
}

/**
 * The registry key the bag button holds a drop target under.
 *
 * Its own key rather than the slot's, because the bag's *first slot* may already
 * be on screen in the open panel and two elements cannot share one entry. The
 * slot they resolve to is the same either way; what differs is where your finger
 * has to be.
 */
const BAG_BUTTON_TARGET_KEY = "bag-button";

/**
 * Where a thing dropped on the button goes.
 *
 * Index zero and not "wherever there is room", because a container destination
 * appends: slots fill in order, so the index at the far end of a move is ignored
 * and any of them names the same operation. See `../game/itemMoves`.
 */
const BAG_BUTTON_SLOT = { kind: "contents", index: 0 } as const;

/**
 * Open the bag on your back.
 *
 * **A plain glyph, not the bag's own sprite.** It was the literal tile for a
 * while, on the grounds that bags differ from each other and a button that
 * looked the same whichever you wore would hide the only fact about it you can
 * see at a glance. The equipment panel's bag slot carries that now — the tile is
 * on screen either way — so this went back to matching the shirt beside it and
 * reads as *a button that opens a thing* rather than as a small picture of your
 * luggage.
 *
 * What it does keep is the count, which the slot does not show, and being a
 * place to *put* things. A bag you have to open before you can stash anything in
 * it is two gestures for one intention, and on a phone the open panel covers the
 * game — so the shortest path from a chest on the floor to your back should not
 * go through a panel that hides the floor. Dropping here appends, exactly as
 * dropping on an empty slot does.
 *
 * Rendered disabled when there is no bag. Absent would be tidier and would also
 * make the row jump by a button's width the moment somebody drops their pack, in
 * a strip whose other buttons a thumb has learned the position of.
 */
export function BagButton({
  bag,
  open,
  onChange,
  tilesById,
  drag,
  size = "touch",
}: {
  bag: ItemInstance | null;
  open: boolean;
  onChange: (open: boolean) => void;
  tilesById: Record<string, TileDef>;
  /** The one move in progress, page-wide. See `./useItemDrag`. */
  drag: ItemDrag;
  size?: ActionButtonSize;
}) {
  const tile = bag ? (tilesById[bag.tileId] ?? null) : null;
  const name = tile?.name ?? "Bag";
  const held = bag?.contents?.length ?? 0;
  const capacity = tile ? (resolveContainer(tile)?.size ?? 0) : 0;

  const { register } = drag;
  const attach = useCallback(
    (el: HTMLElement | null) =>
      register(BAG_BUTTON_TARGET_KEY, BAG_BUTTON_SLOT, el),
    [register],
  );

  const wouldTake = drag.targets.has(BAG_BUTTON_TARGET_KEY);
  const isOver = drag.over === BAG_BUTTON_TARGET_KEY;
  const fullness = bag ? `${held} of ${capacity} full` : null;

  // Pointer-driven rather than click-driven, so the row still answers a thumb
  // that is holding the d-pad down. See `./useTap`.
  const tap = useTap(() => onChange(!open));

  return (
    <Tooltip content={bag ? `${name} — ${held}/${capacity}` : "No bag"}>
      <button
        type="button"
        ref={attach}
        aria-pressed={open}
        aria-label={bag ? `${name}, ${fullness}` : "No bag"}
        disabled={!bag}
        {...tap}
        className={[
          "relative",
          toggleClass(open, size),
          bag ? "" : "opacity-40",
          isOver
            ? "border-accent bg-accent/30"
            : wouldTake
              ? "border-accent/60"
              : "",
        ].join(" ")}
        // Without this a finger dragging over the button scrolls the page
        // instead, and the moves stop arriving — the same reason a slot sets it.
        style={{ touchAction: "none" }}
      >
        <IconBackpack
          size={size === "touch" ? 24 : 18}
          stroke={2}
          aria-hidden="true"
        />
        {/* How full it is, in the corner rather than beside it: the strip is a
            row of equal squares and a button that grew a caption would break
            that rank. Hidden from the reader, who has it in the label above,
            since a bare "2/4" read aloud after a name says nothing. */}
        {bag ? (
          <span
            aria-hidden="true"
            className={[
              "pointer-events-none absolute -bottom-1 -right-1 border px-0.5 text-[9px] font-bold leading-tight tabular-nums",
              // Full is the state worth noticing, because it is the one that
              // stops the next pickup — and it is read at a glance, off the
              // colour, rather than by comparing two numbers.
              held >= capacity
                ? "border-paper bg-paper text-ink"
                : "border-paper/40 bg-ink text-paper/80",
            ].join(" ")}
          >
            {held}/{capacity}
          </span>
        ) : null}
      </button>
    </Tooltip>
  );
}
