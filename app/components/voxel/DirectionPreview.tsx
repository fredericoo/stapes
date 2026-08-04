import { useEffect, useMemo, useRef, useState } from "react";
import type { Direction } from "../../lib/types";
import {
  DEFAULT_FRAME_DURATION_MS,
  gridFacing,
  renderGrid,
  type ShadeMode,
  type VoxelProject,
} from "../../lib/voxel";

/**
 * Animated preview of one direction, rendered in the game projection.
 * Frames advance on each frame's own durationMs, like in-game playback.
 */
export function DirectionPreview({
  project,
  direction,
  shadeMode,
  zoom,
  label,
}: {
  project: VoxelProject;
  direction: Direction;
  shadeMode: ShadeMode;
  zoom: number;
  label?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frameIdx, setFrameIdx] = useState(0);

  const rendered = useMemo(
    () =>
      project.frames.map((frame) => {
        const faced = gridFacing(
          Uint8Array.from(frame.voxels),
          project.size,
          direction,
        );
        return renderGrid(faced.grid, faced.size, project.palette, shadeMode);
      }),
    [project, direction, shadeMode],
  );

  const safeIdx = Math.min(frameIdx, rendered.length - 1);

  useEffect(() => {
    if (project.frames.length <= 1) return;
    const duration =
      project.frames[safeIdx]?.durationMs ?? DEFAULT_FRAME_DURATION_MS;
    const timer = setTimeout(() => {
      setFrameIdx((i) => (i + 1) % project.frames.length);
    }, duration);
    return () => clearTimeout(timer);
  }, [project.frames, safeIdx]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const sprite = rendered[safeIdx];
    if (!canvas || !ctx || !sprite) return;
    canvas.width = sprite.widthPx;
    canvas.height = sprite.heightPx;
    ctx.putImageData(
      new ImageData(sprite.rgba, sprite.widthPx, sprite.heightPx),
      0,
      0,
    );
  }, [rendered, safeIdx]);

  const sprite = rendered[safeIdx];

  return (
    <div className="flex flex-col items-center gap-1">
      <canvas
        ref={canvasRef}
        className="border border-border bg-[repeating-conic-gradient(#e8e4da_0%_25%,#dcd7ca_0%_50%)] bg-[length:8px_8px] [image-rendering:pixelated]"
        style={{
          width: sprite ? sprite.widthPx * zoom : 0,
          height: sprite ? sprite.heightPx * zoom : 0,
        }}
      />
      {label ? (
        <span className="text-[10px] font-bold uppercase text-muted">
          {label}
        </span>
      ) : null}
    </div>
  );
}
