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

  return (
    <ScrollArea className="h-full max-h-full">
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
