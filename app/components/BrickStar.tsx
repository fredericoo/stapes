import { filledCells, outlineCells } from "../render/brickIcon";

/**
 * One character per brick of the label font, so the star stays on the same
 * grid as the text beside it: `#` gold, `+` highlight, `o` shade.
 */
const STAR_PIXELS = [
  ".......#.......",
  "......###......",
  "......#+#......",
  ".....##+#o.....",
  ".....##+#o.....",
  "##############o",
  ".#+++#######oo.",
  "..##########o..",
  "...#########...",
  "....#######....",
  "....#######....",
  "...####.###o...",
  "...###...##o...",
  "..###.....##o..",
  "..#.........o..",
];

const TONES: Record<string, string> = {
  "#": "var(--color-label)",
  "+": "#fffbe0",
  o: "#d9822b",
};

const CELLS = filledCells(STAR_PIXELS, (pixel) => pixel in TONES).map((cell) => ({
  ...cell,
  fill: TONES[STAR_PIXELS[cell.y]![cell.x]!]!,
}));

const OUTLINE = outlineCells(CELLS);

export const BRICK_STAR_SIZE = STAR_PIXELS.length;

/** The outline bricks sit outside the viewBox; the stylesheet lets the svg overflow by one brick. */
export function BrickStar({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox={`0 0 ${BRICK_STAR_SIZE} ${BRICK_STAR_SIZE}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {OUTLINE.map((cell) => (
        <rect key={`o${cell.x},${cell.y}`} x={cell.x} y={cell.y} width={1} height={1} fill="#000" />
      ))}
      {CELLS.map((cell) => (
        <rect
          key={`${cell.x},${cell.y}`}
          x={cell.x}
          y={cell.y}
          width={1}
          height={1}
          fill={cell.fill}
        />
      ))}
    </svg>
  );
}
