import {
  E,
  N,
  NE,
  NW,
  S,
  SE,
  SW,
  W,
  sliceRepresentativeMask,
} from "../lib/autotile";
import type { AutotileSlice } from "../lib/types";

type Props = {
  slice: AutotileSlice;
  /** Outer size in CSS px. */
  size?: number;
  className?: string;
};

type Cell = { bit: number | null; col: number; row: number };

const CELLS: Cell[] = [
  { bit: NW, col: 0, row: 0 },
  { bit: N, col: 1, row: 0 },
  { bit: NE, col: 2, row: 0 },
  { bit: W, col: 0, row: 1 },
  { bit: null, col: 1, row: 1 },
  { bit: E, col: 2, row: 1 },
  { bit: SW, col: 0, row: 2 },
  { bit: S, col: 1, row: 2 },
  { bit: SE, col: 2, row: 2 },
];

/**
 * Mini terrain silhouette for one blob-autotile slice.
 * Reads as a 3×3 neighborhood: green center = this tile, teal = matching
 * neighbors. Empty cells are gaps the autotile must leave open.
 */
export function AutotileSlicePreview({
  slice,
  size = 32,
  className = "",
}: Props) {
  const mask = sliceRepresentativeMask(slice);
  const cell = size / 3;
  const gap = Math.max(0.75, size * 0.04);
  const r = Math.max(1, cell * 0.22);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={["pixelated block", className].join(" ")}
      aria-hidden="true"
    >
      <rect width={size} height={size} fill="#e8e4da" />
      {CELLS.map(({ bit, col, row }) => {
        const on = bit == null || (mask & bit) !== 0;
        if (!on) return null;
        const isCenter = bit == null;
        return (
          <rect
            key={`${col},${row}`}
            x={col * cell + gap}
            y={row * cell + gap}
            width={cell - gap * 2}
            height={cell - gap * 2}
            rx={r}
            ry={r}
            fill={isCenter ? "#1b4332" : "#40916c"}
          />
        );
      })}
    </svg>
  );
}

export function autotileSliceTitle(slice: AutotileSlice): string {
  const mask = sliceRepresentativeMask(slice);
  if (mask === 0) return `Slice ${slice}: isolated (no neighbors)`;
  const parts: string[] = [];
  if (mask & N) parts.push("N");
  if (mask & NE) parts.push("NE");
  if (mask & E) parts.push("E");
  if (mask & SE) parts.push("SE");
  if (mask & S) parts.push("S");
  if (mask & SW) parts.push("SW");
  if (mask & W) parts.push("W");
  if (mask & NW) parts.push("NW");
  return `Slice ${slice}: connects ${parts.join(", ")}`;
}
