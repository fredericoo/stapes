import { useCallback, useEffect, useRef, useState } from "react";
import type { SlotRef } from "../game/itemMoves";
import type { ItemInstance } from "../lib/itemInstance";

/**
 * Which gesture a press on a slot turned out to be: a drag, or a tap.
 *
 * ## Moving is dragging, and only dragging
 *
 * There was a two-step here for a while — press a slot to lift what is in it,
 * press another to put it down — and it is gone. A tap that means "pick this up
 * a bit" is a lie about the most obvious gesture on the screen: everywhere else
 * in every game, tapping a thing you are carrying *uses* it. So a tap uses it
 * here too (see `../game/itemUse`), and a move is a drag on both a mouse and a
 * thumb.
 *
 * The cost is real and is written down rather than papered over: **moving an
 * item is now unreachable from a keyboard.** Lift-and-place was the accessible
 * path, and taking it away leaves a gap that the accessibility pass owns — using
 * an item still works from the keyboard, because a tap is a button's click.
 *
 * ## Pointer events, not the HTML5 drag API
 *
 * `dragstart` never fires on a touchscreen, and half of this feature is a thumb
 * moving a sprite across a phone. Pointer events are the one input model that
 * covers a mouse, a finger and a stylus without three code paths — so the drag
 * is built out of `pointerdown` on the source and window-level `pointermove`,
 * which keeps working when the pointer leaves the element it started on.
 *
 * ## Nothing here knows the rules
 *
 * Whether a move is legal is `../game/itemMoves` and what a tap does is
 * `../game/itemUse`, both asked through the page, so a slot lights up only where
 * the thing would actually land. This hook decides *when* to ask.
 */

/**
 * How far a pointer travels before a press becomes a drag.
 *
 * Below it the gesture is a tap, which is what lets one press mean either "use
 * this" or "start dragging this" without the player choosing in advance. A thumb
 * never lands perfectly still, so zero would turn every tap into a one-pixel
 * drag and nothing would ever be used.
 */
const DRAG_THRESHOLD_PX = 6;

/** Something under the pointer, on its way from one slot to another. */
export type HeldItem = { instance: ItemInstance; from: SlotRef };

export type ItemDrag = {
  /** What the pointer is carrying right now, or null. */
  held: HeldItem | null;
  /** Slots that would take what is in hand, by {@link slotKey}. */
  targets: ReadonlySet<string>;
  /** The slot under the pointer, when it is one that would take the thing. */
  over: string | null;
  /** Attach to a slot's element so the drag can find it under the pointer. */
  register: (key: string, slot: SlotRef, el: HTMLElement | null) => void;
  /** A press landed on a slot holding something. */
  startDrag: (
    event: React.PointerEvent,
    slot: SlotRef,
    instance: ItemInstance,
  ) => void;
  /**
   * A slot was clicked, tapped, or activated from the keyboard.
   *
   * Routed through here rather than straight from the button so that one place
   * decides what a press *was*: the click at the end of a drag is the tail of
   * that gesture, and a slot answering it would use the thing it just finished
   * moving.
   */
  tap: (slot: SlotRef, instance: ItemInstance | null) => void;
  /** Abandon a drag in progress, changing nothing. */
  cancel: () => void;
  /**
   * The element the dragged sprite lives in.
   *
   * Positioned by writing to this node rather than through React state: the
   * pointer moves every few milliseconds, and re-rendering the page around the
   * game for each of those would be paying a frame's work to move one sprite.
   */
  layerRef: React.RefObject<HTMLDivElement | null>;
};

export function useItemDrag({
  canMove,
  onMove,
  onUse,
  world,
}: {
  canMove: (from: SlotRef, to: SlotRef) => boolean;
  onMove: (from: SlotRef, to: SlotRef) => void;
  /**
   * A slot was tapped with something in it.
   *
   * What that *means* is the page's business — opening a bag is panel state and
   * wielding a sword is a move — and this hook only says that a press was a tap
   * rather than the beginning of a drag.
   */
  onUse: (slot: SlotRef, instance: ItemInstance) => void;
  /**
   * The one drop target that is not a slot.
   *
   * Handled apart from the registry because the world is not an element with a
   * rectangle — which cell a point is over is a question about a camera, and the
   * renderer is the only thing that knows the answer. So this hook reports "the
   * pointer is out here, carrying this" and lets the page decide what that
   * means; `over(null)` says the pointer has gone back to a slot, or let go.
   */
  world?: {
    /** Carrying this, out here — or null for "no longer over the world". */
    over: (
      drag: { held: HeldItem; point: { x: number; y: number } } | null,
    ) => void;
    drop: (held: HeldItem, point: { x: number; y: number }) => void;
  };
}): ItemDrag {
  const [held, setHeld] = useState<HeldItem | null>(null);
  const [targets, setTargets] = useState<ReadonlySet<string>>(new Set());
  const [over, setOver] = useState<string | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);

  /** Every slot on screen, so a drop can be resolved from a point. */
  const slots = useRef(new Map<string, { slot: SlotRef; el: HTMLElement }>());
  /** The press that has not yet travelled far enough to be a drag. */
  const armed = useRef<{ held: HeldItem; x: number; y: number } | null>(null);
  /**
   * Live copies for the window listeners.
   *
   * The listeners are bound once and read these, rather than being rebound every
   * time the pointer crosses a slot — a drag would otherwise tear down and
   * rebuild four listeners on every state change it causes.
   */
  const heldRef = useRef<HeldItem | null>(null);
  const overRef = useRef<string | null>(null);
  const acceptingRef = useRef<ReadonlySet<string>>(targets);
  /** Where the pointer was last seen, for a release that lands on the world. */
  const pointRef = useRef<{ x: number; y: number } | null>(null);
  /** Read by the window listeners, which are bound once. */
  const worldRef = useRef(world);
  worldRef.current = world;
  /**
   * A drag ended on this element, so the click it is about to fire is the tail
   * of that drag rather than a tap. Without it, dragging a sword and letting go
   * of it where it started would move it nowhere and then *use* it, which is a
   * fight picked by a gesture that changed its mind.
   */
  const swallowClick = useRef(false);

  heldRef.current = held;
  overRef.current = over;
  acceptingRef.current = targets;

  const register = useCallback(
    (key: string, slot: SlotRef, el: HTMLElement | null) => {
      if (el) slots.current.set(key, { slot, el });
      else slots.current.delete(key);
    },
    [],
  );

  /** Which of the slots on screen would take this thing, asked once per lift. */
  const findTargets = useCallback(
    (from: SlotRef): Set<string> => {
      const out = new Set<string>();
      for (const [key, { slot }] of slots.current) {
        if (canMove(from, slot)) out.add(key);
      }
      return out;
    },
    [canMove],
  );

  /**
   * Put everything down, refs first.
   *
   * The refs are what the window listeners read, and they are cleared here
   * rather than left to the re-render: a second `pointerup` arriving before
   * React has painted would otherwise move the same item twice.
   */
  const clear = useCallback(() => {
    armed.current = null;
    heldRef.current = null;
    overRef.current = null;
    acceptingRef.current = new Set();
    pointRef.current = null;
    worldRef.current?.over(null);
    setHeld(null);
    setTargets(new Set());
    setOver(null);
  }, []);

  const cancel = useCallback(() => clear(), [clear]);

  /** The slot under a point, if it is one that would take what is in hand. */
  const targetAt = useCallback(
    (x: number, y: number, accepting: ReadonlySet<string>): string | null => {
      for (const [key, { el }] of slots.current) {
        if (!accepting.has(key)) continue;
        const box = el.getBoundingClientRect();
        if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
          return key;
        }
      }
      return null;
    },
    [],
  );

  const moveLayerTo = useCallback((x: number, y: number) => {
    const layer = layerRef.current;
    if (layer) layer.style.transform = `translate(${x}px, ${y}px)`;
  }, []);

  const startDrag = useCallback(
    (event: React.PointerEvent, slot: SlotRef, instance: ItemInstance) => {
      // Left button and touches only. A right-click is a context menu, and
      // starting a drag under one leaves the item stuck to a menu nobody asked
      // for.
      if (event.button !== 0) return;
      armed.current = {
        held: { instance, from: slot },
        x: event.clientX,
        y: event.clientY,
      };
    },
    [],
  );

  const tap = useCallback(
    (slot: SlotRef, instance: ItemInstance | null) => {
      if (swallowClick.current) {
        swallowClick.current = false;
        return;
      }
      if (!instance) return;
      onUse(slot, instance);
    },
    [onUse],
  );

  /**
   * The window listeners, live for as long as a press might become a drag.
   *
   * On the window rather than on the slot, because a drag stops being about the
   * element it started on the moment it leaves it — and a pointer released
   * outside the browser has to end the drag rather than leave a sprite stuck to
   * the cursor.
   */
  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const pending = armed.current;
      if (pending) {
        const travelled =
          Math.abs(event.clientX - pending.x) +
          Math.abs(event.clientY - pending.y);
        if (travelled < DRAG_THRESHOLD_PX) return;
        armed.current = null;
        const accepting = findTargets(pending.held.from);
        const point = { x: event.clientX, y: event.clientY };
        heldRef.current = pending.held;
        acceptingRef.current = accepting;
        // Recorded here as well as below, because a flick can be one single
        // event: the press promotes to a drag and is let go of before another
        // move ever arrives, and a release with no position to release *at* used
        // to fall through to nothing.
        pointRef.current = point;
        overRef.current = targetAt(point.x, point.y, accepting);
        moveLayerTo(point.x, point.y);
        setHeld(pending.held);
        setTargets(accepting);
        setOver(overRef.current);
        if (!overRef.current) {
          worldRef.current?.over({ held: pending.held, point });
        }
        return;
      }

      if (!heldRef.current) return;
      const point = { x: event.clientX, y: event.clientY };
      pointRef.current = point;
      moveLayerTo(point.x, point.y);
      const next = targetAt(point.x, point.y, acceptingRef.current);
      if (next !== overRef.current) {
        overRef.current = next;
        setOver(next);
      }
      // A slot wins wherever the two overlap, so the world only ever hears about
      // a pointer that is over none of them. Panels sit above the canvas and a
      // ghost drawn under an open bag would be a promise about a cell nobody can
      // see.
      const held = heldRef.current;
      if (held) worldRef.current?.over(next ? null : { held, point });
    };

    const onPointerUp = () => {
      armed.current = null;
      // Only a drag ends here. A press that never travelled far enough to
      // promote is a tap, and the click behind it is what uses the thing.
      const inHand = heldRef.current;
      if (!inHand) return;
      const landing = overRef.current;
      const target = landing ? slots.current.get(landing)?.slot : null;
      const point = pointRef.current;
      if (target) onMove(inHand.from, target);
      // Nowhere else to land means the world, which decides for itself whether
      // there is anything there — the same question the ghost was answering all
      // the way in.
      else if (point) worldRef.current?.drop(inHand, point);
      // Whether it landed or not, the press is over — a drop into nothing puts
      // the thing back where it came from, which is the gesture's own undo.
      swallowClick.current = true;
      clear();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!heldRef.current && !armed.current) return;
      clear();
    };

    // A drag that ended over a *different* slot fires no click on the one it
    // started from, so the swallow flag would be left armed and eat the next
    // real press. Every fresh gesture clears it: down, up and click all belong
    // to the same gesture, and the next down cannot be part of it.
    const onPointerDown = () => {
      swallowClick.current = false;
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [clear, findTargets, moveLayerTo, onMove, targetAt]);

  return {
    held,
    targets,
    over,
    register,
    startDrag,
    tap,
    cancel,
    layerRef,
  };
}
