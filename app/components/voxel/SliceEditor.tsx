import { useEffect, useRef } from "react";
import { CELL_SIZE } from "../../lib/types";
import {
  EMPTY_VOXEL,
  parseHexColor,
  voxelDims,
  voxelIndex,
  type VoxelSize,
} from "../../lib/voxel";

const VOXEL_PX = 22;
const CHECKER_LIGHT = "#e8e4da";
const CHECKER_DARK = "#dcd7ca";
const GHOST_ALPHA = 0.25;
const GRID_LINE = "rgba(0,0,0,0.08)";
const CELL_LINE = "rgba(0,0,0,0.35)";

export type SliceTool = "paint" | "erase" | "fill" | "pick";

export function SliceEditor({
  voxels,
  size,
  sliceZ,
  palette,
  selectedColor,
  tool,
  onPaint,
  onPick,
}: {
  voxels: number[];
  size: VoxelSize;
  sliceZ: number;
  palette: string[];
  selectedColor: number;
  tool: SliceTool;
  /** Batch of voxel writes within the current slice. */
  onPaint: (writes: { x: number; y: number; value: number }[]) => void;
  onPick: (paletteIndex: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paintingRef = useRef<{ erase: boolean } | null>(null);
  const dims = voxelDims(size);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    drawSlice(ctx, voxels, size, sliceZ, palette);
  }, [voxels, size, sliceZ, palette]);

  const voxelAtPointer = (
    e: React.PointerEvent,
  ): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * dims.vx);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * dims.vy);
    if (x < 0 || y < 0 || x >= dims.vx || y >= dims.vy) return null;
    return { x, y };
  };

  const applyAt = (pos: { x: number; y: number }, erase: boolean) => {
    if (tool === "pick") {
      onPick(voxels[voxelIndex(dims, pos.x, pos.y, sliceZ)]!);
      return;
    }
    if (tool === "fill") {
      onPaint(
        floodFillWrites(
          voxels,
          size,
          sliceZ,
          pos,
          erase ? EMPTY_VOXEL : selectedColor,
        ),
      );
      return;
    }
    const value = erase || tool === "erase" ? EMPTY_VOXEL : selectedColor;
    onPaint([{ ...pos, value }]);
  };

  const handleDown = (e: React.PointerEvent) => {
    const pos = voxelAtPointer(e);
    if (!pos) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const erase = e.button === 2;
    paintingRef.current =
      tool === "paint" || tool === "erase" ? { erase } : null;
    applyAt(pos, erase);
  };

  const handleMove = (e: React.PointerEvent) => {
    const painting = paintingRef.current;
    if (!painting) return;
    const pos = voxelAtPointer(e);
    if (!pos) return;
    applyAt(pos, painting.erase);
  };

  return (
    <canvas
      ref={canvasRef}
      width={dims.vx * VOXEL_PX}
      height={dims.vy * VOXEL_PX}
      className="max-h-full max-w-full touch-none border-2 border-border shadow-hard [image-rendering:pixelated]"
      style={{ aspectRatio: `${dims.vx} / ${dims.vy}` }}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={() => {
        paintingRef.current = null;
      }}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}

function drawSlice(
  ctx: CanvasRenderingContext2D,
  voxels: number[],
  size: VoxelSize,
  sliceZ: number,
  palette: string[],
) {
  const dims = voxelDims(size);
  ctx.clearRect(0, 0, dims.vx * VOXEL_PX, dims.vy * VOXEL_PX);

  for (let y = 0; y < dims.vy; y++) {
    for (let x = 0; x < dims.vx; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? CHECKER_LIGHT : CHECKER_DARK;
      ctx.fillRect(x * VOXEL_PX, y * VOXEL_PX, VOXEL_PX, VOXEL_PX);
      paintVoxel(ctx, voxels, dims, palette, x, y, sliceZ);
    }
  }

  drawGridLines(ctx, dims);
}

function paintVoxel(
  ctx: CanvasRenderingContext2D,
  voxels: number[],
  dims: ReturnType<typeof voxelDims>,
  palette: string[],
  x: number,
  y: number,
  sliceZ: number,
) {
  const below =
    sliceZ > 0 ? voxels[voxelIndex(dims, x, y, sliceZ - 1)]! : EMPTY_VOXEL;
  const current = voxels[voxelIndex(dims, x, y, sliceZ)]!;

  if (below !== EMPTY_VOXEL && current === EMPTY_VOXEL) {
    const [r, g, b] = parseHexColor(palette[below] ?? "#ff00ff");
    ctx.fillStyle = `rgba(${r},${g},${b},${GHOST_ALPHA})`;
    ctx.fillRect(x * VOXEL_PX, y * VOXEL_PX, VOXEL_PX, VOXEL_PX);
  }
  if (current !== EMPTY_VOXEL) {
    ctx.fillStyle = palette[current] ?? "#ff00ff";
    ctx.fillRect(x * VOXEL_PX, y * VOXEL_PX, VOXEL_PX, VOXEL_PX);
  }
}

function drawGridLines(
  ctx: CanvasRenderingContext2D,
  dims: ReturnType<typeof voxelDims>,
) {
  for (let x = 1; x < dims.vx; x++) {
    ctx.fillStyle = x % CELL_SIZE === 0 ? CELL_LINE : GRID_LINE;
    ctx.fillRect(x * VOXEL_PX, 0, 1, dims.vy * VOXEL_PX);
  }
  for (let y = 1; y < dims.vy; y++) {
    ctx.fillStyle = y % CELL_SIZE === 0 ? CELL_LINE : GRID_LINE;
    ctx.fillRect(0, y * VOXEL_PX, dims.vx * VOXEL_PX, 1);
  }
}

function floodFillWrites(
  voxels: number[],
  size: VoxelSize,
  sliceZ: number,
  start: { x: number; y: number },
  value: number,
): { x: number; y: number; value: number }[] {
  const dims = voxelDims(size);
  const target = voxels[voxelIndex(dims, start.x, start.y, sliceZ)];
  if (target === value) return [];
  const writes: { x: number; y: number; value: number }[] = [];
  const seen = new Set<number>();
  const queue = [start];
  while (queue.length > 0) {
    const pos = queue.pop();
    if (!pos) break;
    const flat = pos.y * dims.vx + pos.x;
    if (seen.has(flat)) continue;
    seen.add(flat);
    if (voxels[voxelIndex(dims, pos.x, pos.y, sliceZ)] !== target) continue;
    writes.push({ ...pos, value });
    if (pos.x > 0) queue.push({ x: pos.x - 1, y: pos.y });
    if (pos.x < dims.vx - 1) queue.push({ x: pos.x + 1, y: pos.y });
    if (pos.y > 0) queue.push({ x: pos.x, y: pos.y - 1 });
    if (pos.y < dims.vy - 1) queue.push({ x: pos.x, y: pos.y + 1 });
  }
  return writes;
}
