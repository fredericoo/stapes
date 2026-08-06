import { useLayoutEffect, useRef } from "react";
import {
  IconBucket,
  IconCircle,
  IconEraser,
  IconPointer,
  IconPencil,
  IconSquare,
  type TablerIcon,
} from "@tabler/icons-react";
import { Button, ScrollArea, Tooltip } from "../../ui";
import { panCameraByWheel } from "../camera";
import { useEditorStore, type ToolId } from "../store";

const TOOLS: Array<{
  id: ToolId;
  label: string;
  key: string;
  Icon: TablerIcon;
}> = [
  { id: "select", label: "Select", key: "V", Icon: IconPointer },
  { id: "erase", label: "Erase", key: "E", Icon: IconEraser },
  { id: "pencil", label: "Pencil", key: "B", Icon: IconPencil },
  { id: "rect", label: "Rect", key: "R", Icon: IconSquare },
  { id: "circle", label: "Circle", key: "C", Icon: IconCircle },
  { id: "bucket", label: "Bucket", key: "G", Icon: IconBucket },
];

/** Floating vertical tool strip — scrolls when the chrome column is short. */
export function MapToolbar() {
  const tool = useEditorStore((s) => s.tool);
  const viewportRef = useRef<HTMLDivElement>(null);

  // Chain wheel to the map whenever the strip can't absorb it (no overflow,
  // or already at the edge). Keeps toolbar hover from trapping map pan.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      const atTop = el.scrollTop <= 0;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
      const canAbsorb = (dy < 0 && !atTop) || (dy > 0 && !atBottom);

      if (canAbsorb) return;

      e.preventDefault();
      panCameraByWheel(e);
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <ScrollArea className="h-full max-h-full" viewportRef={viewportRef}>
      <div className="flex w-fit flex-col gap-1 border-2 border-border bg-paper/90 p-1 shadow-hard">
        {TOOLS.map(({ id, label, key, Icon }) => (
          <Tooltip key={id} content={`${label} (${key})`} side="left">
            <Button
              size="icon"
              variant="ghost"
              active={tool === id}
              aria-label={`${label} (${key})`}
              aria-pressed={tool === id}
              onClick={() => useEditorStore.getState().setTool(id)}
            >
              <Icon size={18} aria-hidden="true" />
            </Button>
          </Tooltip>
        ))}
      </div>
    </ScrollArea>
  );
}
