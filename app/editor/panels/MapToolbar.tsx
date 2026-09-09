import { useLayoutEffect, useRef, useState } from "react";
import {
  IconBucket,
  IconCircle,
  IconEraser,
  IconHome,
  IconMountain,
  IconPointer,
  IconPencil,
  IconSquare,
  type TablerIcon,
} from "@tabler/icons-react";
import { Button, ScrollArea, Tooltip } from "../../ui";
import { panCameraByWheel } from "../camera";
import { useEditorStore, type ToolId } from "../store";
import { GENERATORS, type GeneratorId, type ProceduralSettings } from "../procedural";
import { ProceduralDialog } from "./ProceduralDialog";

/**
 * The face each generator wears on the tool button, which changes with the
 * armed one — the strip has room for a single procedural button, so the icon
 * is the only place the armed generator can be read off the toolbar.
 */
const GENERATOR_ICONS: Record<GeneratorId, TablerIcon> = {
  house: IconHome,
  cave: IconMountain,
};

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
  const settings = useEditorStore((s) => s.proceduralSettings);
  const [dialogOpen, setDialogOpen] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);

  // Placing arms the tool with the settings just chosen and hands the map back
  // ready to drag. The selected cell goes with it: the shape tools stamp the
  // selection when there is one, and a generator ignores it, so leaving it set
  // would leave the tile picker claiming a brush the next drag will not use.
  const place = (next: ProceduralSettings) => {
    const store = useEditorStore.getState();
    store.setProceduralSettings(next);
    store.setSelected(null);
    store.setTool("procedural");
    setDialogOpen(false);
  };

  const activeGenerator =
    GENERATORS.find((g) => g.id === settings.active) ?? GENERATORS[0]!;
  const ActiveIcon = GENERATOR_ICONS[activeGenerator.id];

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
        <Tooltip content={`Procedural — ${activeGenerator.hint.toLowerCase()}`} side="left">
          <Button
            size="icon"
            variant="ghost"
            active={tool === "procedural"}
            aria-label={`Procedural: ${activeGenerator.label}`}
            aria-haspopup="dialog"
            onClick={() => setDialogOpen(true)}
          >
            <ActiveIcon size={18} aria-hidden="true" />
          </Button>
        </Tooltip>
      </div>
      <ProceduralDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        settings={settings}
        onPlace={place}
      />
    </ScrollArea>
  );
}
