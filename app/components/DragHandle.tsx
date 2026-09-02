import type { useSortable } from "@dnd-kit/react/sortable";

/**
 * The grip that drags a row. A dedicated handle rather than the whole row, so a
 * click on a dropdown or a number field stays a click — the same choice the
 * tile-stack list makes.
 */
export function DragHandle({
  handleRef,
  label,
}: {
  handleRef: ReturnType<typeof useSortable>["handleRef"];
  label: string;
}) {
  return (
    <button
      type="button"
      ref={handleRef}
      aria-label={label}
      className="cursor-grab px-1 text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:cursor-grabbing"
    >
      <span aria-hidden="true">⋮⋮</span>
    </button>
  );
}
