import { useCallback, useEffect, useRef, useState } from "react";
import type { SlotRef } from "../game/itemMoves";
import type { ItemInstance } from "../lib/itemInstance";

const DRAG_THRESHOLD_PX = 6;

export type HeldItem = { instance: ItemInstance; from: SlotRef };

export type DropTarget =
  | SlotRef
  | ((held: HeldItem, lands: (to: SlotRef) => boolean) => SlotRef | null);

export type Release = { kind: "slot"; to: SlotRef } | { kind: "world" } | { kind: "nothing" };

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
  canMove: (from: SlotRef, to: SlotRef) => boolean;
  onMove: (from: SlotRef, to: SlotRef) => void;
  onUse: (slot: SlotRef, instance: ItemInstance) => void;
  world?: {
    over: (drag: { held: HeldItem; point: { x: number; y: number } } | null) => void;
    drop: (held: HeldItem, point: { x: number; y: number }) => void;
  };
}): ItemDrag {
  const [held, setHeld] = useState<HeldItem | null>(null);
  const [targets, setTargets] = useState<ReadonlySet<string>>(new Set());
  const [over, setOver] = useState<string | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);

  const slots = useRef(new Map<string, { target: DropTarget; el: HTMLElement }>());
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

  const resolveTarget = useCallback(
    (target: DropTarget, held: HeldItem): SlotRef | null =>
      typeof target === "function"
        ? target(held, (to) => canMoveRef.current(held.from, to))
        : target,
    [],
  );

  const register = useCallback((key: string, target: DropTarget, el: HTMLElement | null) => {
    if (el) slots.current.set(key, { target, el });
    else slots.current.delete(key);
  }, []);

  const findTargets = useCallback(
    (held: HeldItem): Set<string> => {
      const out = new Set<string>();
      for (const [key, { target }] of slots.current) {
        const slot = resolveTarget(target, held);
        if (slot && canMove(held.from, slot)) out.add(key);
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
    pointRef.current = null;
    worldRef.current?.over(null);
    setHeld(null);
    setTargets(new Set());
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

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const pending = armed.current;
      if (pending) {
        const travelled = Math.abs(event.clientX - pending.x) + Math.abs(event.clientY - pending.y);
        if (travelled < DRAG_THRESHOLD_PX) return;
        armed.current = null;
        const accepting = findTargets(pending.held);
        const point = { x: event.clientX, y: event.clientY };
        heldRef.current = pending.held;
        acceptingRef.current = accepting;
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
      const held = heldRef.current;
      if (held) worldRef.current?.over(next ? null : { held, point });
    };

    const onPointerUp = () => {
      armed.current = null;
      const inHand = heldRef.current;
      if (!inHand) return;
      const landing = overRef.current;
      const entry = landing ? slots.current.get(landing) : null;
      const target = entry ? resolveTarget(entry.target, inHand) : null;
      const point = pointRef.current;
      const release = releaseTo(target, point ? slotAt(point.x, point.y, inHand) : null, point);
      if (release.kind === "slot") onMove(inHand.from, release.to);
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
  }, [clear, findTargets, moveLayerTo, onMove, resolveTarget, slotAt, targetAt]);

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
