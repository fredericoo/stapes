import { useCallback, useEffect, useRef, useState } from "react";
import type { SlotRef } from "../game/itemMoves";
import type { ItemInstance } from "../lib/itemInstance";
import { countOf } from "../lib/piles";

const DRAG_THRESHOLD_PX = 6;

/** `count` is how many of the pile are carried; absent carries all of it. */
export type HeldItem = { instance: ItemInstance; from: SlotRef; count?: number };

export function carriedCount(held: HeldItem): number {
  return held.count ?? countOf(held.instance);
}

/** Shift carries one off a pile and Alt carries half, rounded down so as many stay as go. */
export function countForModifiers(
  instance: ItemInstance,
  keys: { shiftKey: boolean; altKey: boolean },
): number | undefined {
  const whole = countOf(instance);
  if (whole <= 1) return undefined;
  if (keys.shiftKey) return 1;
  if (keys.altKey) return Math.floor(whole / 2);
  return undefined;
}

export type DropTarget =
  | SlotRef
  | ((held: HeldItem, lands: (to: SlotRef) => boolean) => SlotRef | null);

export type Release = { kind: "slot"; to: SlotRef } | { kind: "world" } | { kind: "nothing" };

/** Where a pile can be dropped to be split in its own container; `accepts` says whether it takes this one. */
export type SplitZone = { accepts: (held: HeldItem) => boolean; onDrop: (held: HeldItem) => void };

export function releaseTo(
  target: SlotRef | null,
  under: SlotRef | null,
  point: { x: number; y: number } | null,
): Release {
  const to = target ?? under;
  if (to) return { kind: "slot", to };
  return point ? { kind: "world" } : { kind: "nothing" };
}

export type ItemDrag = {
  held: HeldItem | null;
  targets: ReadonlySet<string>;
  over: string | null;
  register: (key: string, target: DropTarget, el: HTMLElement | null) => void;
  registerSplit: (key: string, zone: SplitZone, el: HTMLElement | null) => void;
  splitting: ReadonlySet<string>;
  startDrag: (event: React.PointerEvent, slot: SlotRef, instance: ItemInstance) => void;
  tap: (slot: SlotRef, instance: ItemInstance | null) => void;
  cancel: () => void;
  layerRef: React.RefObject<HTMLDivElement | null>;
};

export function useItemDrag({
  canMove,
  onMove,
  onUse,
  world,
}: {
  canMove: (from: SlotRef, to: SlotRef, count?: number) => boolean;
  onMove: (from: SlotRef, to: SlotRef, count?: number) => void;
  onUse: (slot: SlotRef, instance: ItemInstance) => void;
  world?: {
    over: (drag: { held: HeldItem; point: { x: number; y: number } } | null) => void;
    drop: (held: HeldItem, point: { x: number; y: number }) => void;
  };
}): ItemDrag {
  const [held, setHeld] = useState<HeldItem | null>(null);
  const [targets, setTargets] = useState<ReadonlySet<string>>(new Set());
  const [over, setOver] = useState<string | null>(null);
  const [splitting, setSplitting] = useState<ReadonlySet<string>>(new Set());
  const layerRef = useRef<HTMLDivElement | null>(null);

  const slots = useRef(new Map<string, { target: DropTarget; el: HTMLElement }>());
  const splitZones = useRef(new Map<string, { zone: SplitZone; el: HTMLElement }>());
  const splittingRef = useRef<ReadonlySet<string>>(splitting);
  const armed = useRef<{ held: HeldItem; x: number; y: number } | null>(null);
  const heldRef = useRef<HeldItem | null>(null);
  const overRef = useRef<string | null>(null);
  const acceptingRef = useRef<ReadonlySet<string>>(targets);
  const pointRef = useRef<{ x: number; y: number } | null>(null);
  const worldRef = useRef(world);
  worldRef.current = world;
  const canMoveRef = useRef(canMove);
  canMoveRef.current = canMove;
  const swallowClick = useRef(false);

  heldRef.current = held;
  overRef.current = over;
  acceptingRef.current = targets;
  splittingRef.current = splitting;

  const resolveTarget = useCallback(
    (target: DropTarget, held: HeldItem): SlotRef | null =>
      typeof target === "function"
        ? target(held, (to) => canMoveRef.current(held.from, to, held.count))
        : target,
    [],
  );

  const register = useCallback((key: string, target: DropTarget, el: HTMLElement | null) => {
    if (el) slots.current.set(key, { target, el });
    else slots.current.delete(key);
  }, []);

  const registerSplit = useCallback((key: string, zone: SplitZone, el: HTMLElement | null) => {
    if (el) splitZones.current.set(key, { zone, el });
    else splitZones.current.delete(key);
  }, []);

  const findTargets = useCallback(
    (held: HeldItem): Set<string> => {
      const out = new Set<string>();
      for (const [key, { target }] of slots.current) {
        const slot = resolveTarget(target, held);
        if (slot && canMove(held.from, slot, held.count)) out.add(key);
      }
      return out;
    },
    [canMove, resolveTarget],
  );

  const clear = useCallback(() => {
    armed.current = null;
    heldRef.current = null;
    overRef.current = null;
    acceptingRef.current = new Set();
    splittingRef.current = new Set();
    pointRef.current = null;
    worldRef.current?.over(null);
    setHeld(null);
    setTargets(new Set());
    setSplitting(new Set());
    setOver(null);
  }, []);

  const cancel = useCallback(() => clear(), [clear]);

  const slotAt = useCallback(
    (x: number, y: number, held: HeldItem): SlotRef | null => {
      for (const { target, el } of slots.current.values()) {
        const box = el.getBoundingClientRect();
        if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
          const slot = resolveTarget(target, held);
          if (slot) return slot;
        }
      }
      return null;
    },
    [resolveTarget],
  );

  const targetAt = useCallback(
    (x: number, y: number, accepting: ReadonlySet<string>): string | null => {
      for (const [key, { el }] of [...slots.current, ...splitZones.current]) {
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

  const findSplitZones = useCallback((held: HeldItem): Set<string> => {
    const out = new Set<string>();
    for (const [key, { zone }] of splitZones.current) if (zone.accepts(held)) out.add(key);
    return out;
  }, []);

  const moveLayerTo = useCallback((x: number, y: number) => {
    const layer = layerRef.current;
    if (layer) layer.style.transform = `translate(${x}px, ${y}px)`;
  }, []);

  const startDrag = useCallback(
    (event: React.PointerEvent, slot: SlotRef, instance: ItemInstance) => {
      if (event.button !== 0) return;
      armed.current = {
        held: { instance, from: slot, count: countForModifiers(instance, event) },
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

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const pending = armed.current;
      if (pending) {
        const travelled = Math.abs(event.clientX - pending.x) + Math.abs(event.clientY - pending.y);
        if (travelled < DRAG_THRESHOLD_PX) return;
        armed.current = null;
        const splits = findSplitZones(pending.held);
        const accepting = new Set([...findTargets(pending.held), ...splits]);
        const point = { x: event.clientX, y: event.clientY };
        heldRef.current = pending.held;
        acceptingRef.current = accepting;
        splittingRef.current = splits;
        pointRef.current = point;
        overRef.current = targetAt(point.x, point.y, accepting);
        moveLayerTo(point.x, point.y);
        setHeld(pending.held);
        setTargets(accepting);
        setSplitting(splits);
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
      const held = heldRef.current;
      if (held) worldRef.current?.over(next ? null : { held, point });
    };

    const onPointerUp = () => {
      armed.current = null;
      const inHand = heldRef.current;
      if (!inHand) return;
      const landing = overRef.current;
      const split =
        landing && splittingRef.current.has(landing) ? splitZones.current.get(landing) : null;
      if (split) {
        split.zone.onDrop(inHand);
        swallowClick.current = true;
        clear();
        return;
      }
      const entry = landing ? slots.current.get(landing) : null;
      const target = entry ? resolveTarget(entry.target, inHand) : null;
      const point = pointRef.current;
      const release = releaseTo(target, point ? slotAt(point.x, point.y, inHand) : null, point);
      if (release.kind === "slot") onMove(inHand.from, release.to, inHand.count);
      else if (release.kind === "world" && point) {
        worldRef.current?.drop(inHand, point);
      }
      swallowClick.current = true;
      clear();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!heldRef.current && !armed.current) return;
      clear();
    };

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
  }, [clear, findSplitZones, findTargets, moveLayerTo, onMove, resolveTarget, slotAt, targetAt]);

  return {
    held,
    targets,
    over,
    register,
    registerSplit,
    splitting,
    startDrag,
    tap,
    cancel,
    layerRef,
  };
}
