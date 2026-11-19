import { useCallback, useEffect, useMemo, useState } from "react";
import { containerOfSlot, type ContainerRef, type SlotRef } from "../game/itemMoves";
import type { ItemInstance } from "../lib/itemInstance";
import { countOf } from "../lib/piles";
import type { HeldItem, ItemDrag, SplitZone } from "./useItemDrag";

export function containerKey(container: ContainerRef): string {
  if (container.kind === "bag") return "bag";
  if (container.kind === "hand") return `hand:${container.hand}`;
  const { x, y, z, stackIndex } = container.ref;
  return `${container.kind}:${x},${y},${z},${stackIndex}`;
}

type Picking = { slot: SlotRef; instance: ItemInstance; count: number };

/**
 * Where a pile dragged out of this container is dropped to be split, and the
 * picker that asks how many to split off once it has been. The zone stays
 * mounted, hidden, so the drag can find it when it starts.
 */
export function PileSplitter({
  location,
  contents,
  name,
  drag,
  canSplit,
  onSplit,
}: {
  location: ContainerRef;
  contents: readonly ItemInstance[];
  name: (instance: ItemInstance) => string;
  drag: ItemDrag;
  canSplit: (slot: SlotRef, count: number) => boolean;
  onSplit: (slot: SlotRef, count: number) => void;
}) {
  const key = `split:${containerKey(location)}`;
  const [picking, setPicking] = useState<Picking | null>(null);

  const zone = useMemo<SplitZone>(
    () => ({
      accepts: (held: HeldItem) => {
        const from = containerOfSlot(held.from);
        return (
          from !== null &&
          containerKey(from) === containerKey(location) &&
          countOf(held.instance) > 1 &&
          canSplit(held.from, 1)
        );
      },
      onDrop: (held: HeldItem) => {
        const whole = countOf(held.instance);
        const count = held.count ?? Math.floor(whole / 2);
        setPicking({ slot: held.from, instance: held.instance, count: Math.min(count, whole - 1) });
      },
    }),
    [location, canSplit],
  );
  const attach = useCallback(
    (el: HTMLElement | null) => drag.registerSplit(key, zone, el),
    [drag.registerSplit, key, zone],
  );

  const still = picking && "index" in picking.slot ? contents[picking.slot.index] : undefined;
  const stale = picking !== null && still?.id !== picking.instance.id;
  useEffect(() => {
    if (stale) setPicking(null);
  }, [stale]);

  const offered = drag.splitting.has(key);
  const over = drag.over === key;

  if (picking && still && !stale) {
    const most = countOf(still) - 1;
    const count = Math.min(picking.count, most);
    const set = (next: number) =>
      setPicking({ ...picking, count: Math.max(1, Math.min(most, next)) });
    return (
      <div
        role="group"
        aria-label={`Split ${name(still)}`}
        className="flex flex-wrap items-center gap-1 text-xs"
      >
        <span className="text-paper/80">Split off</span>
        <button
          type="button"
          className="hud-button h-6 w-6 pointer-coarse:h-9 pointer-coarse:w-9 disabled:opacity-40"
          aria-label="One fewer"
          disabled={count <= 1}
          onClick={() => set(count - 1)}
        >
          −
        </button>
        <output aria-live="polite" className="min-w-6 text-center tabular-nums text-paper">
          {count}
        </output>
        <button
          type="button"
          className="hud-button h-6 w-6 pointer-coarse:h-9 pointer-coarse:w-9 disabled:opacity-40"
          aria-label="One more"
          disabled={count >= most}
          onClick={() => set(count + 1)}
        >
          +
        </button>
        <span className="text-paper/60 tabular-nums">of {countOf(still)}</span>
        <button
          type="button"
          className="hud-button px-2 py-1 uppercase"
          onClick={() => set(Math.floor(countOf(still) / 2))}
        >
          Half
        </button>
        <span className="flex-1" />
        <button
          type="button"
          className="hud-button px-2 py-1 uppercase disabled:opacity-40"
          disabled={!canSplit(picking.slot, count)}
          onClick={() => {
            onSplit(picking.slot, count);
            setPicking(null);
          }}
        >
          Split
        </button>
        <button
          type="button"
          className="hud-button px-2 py-1 uppercase"
          onClick={() => setPicking(null)}
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div
      ref={attach}
      aria-hidden={!offered}
      className={[
        "grid h-10 place-items-center border border-dashed text-xs uppercase tracking-wide transition-colors",
        offered ? "" : "hidden",
        over
          ? "border-accent bg-accent/30 text-paper"
          : "border-accent/60 bg-accent/10 text-paper/80",
      ].join(" ")}
    >
      Drop here to split
    </div>
  );
}
