import { useState } from "react";
import { IconArrowDown, IconArrowUp, IconTrash } from "@tabler/icons-react";
import { saveWeatherAreas } from "../../lib/api";
import type { WeatherArea } from "../../lib/weatherAreas";
import { Button, ScrollArea, SwitchField, Tooltip, useToast } from "../../ui";
import { useEditorStore } from "../store";

function sizeOf(area: WeatherArea): string {
  return `${area.x1 - area.x0 + 1}×${area.y1 - area.y0 + 1} at ${area.x0},${area.y0}`;
}

/** Shown over the canvas while the weather tool is held: the areas in the order they decide, last one winning. */
export function WeatherAreasPanel() {
  const areas = useEditorStore((s) => s.weatherAreas);
  const selected = useEditorStore((s) => s.selectedWeatherArea);
  const dirty = useEditorStore((s) => s.weatherAreasDirty);
  const [saving, setSaving] = useState(false);
  const { show: showToast } = useToast();

  const save = async () => {
    setSaving(true);
    try {
      await saveWeatherAreas(useEditorStore.getState().weatherAreas);
      useEditorStore.getState().markWeatherAreasSaved();
      showToast("Weather areas saved");
    } catch (err) {
      showToast("Weather areas not saved", err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      aria-label="Weather areas"
      className="pointer-events-auto flex max-h-[60%] w-64 flex-col gap-2 border-2 border-border bg-paper/95 p-2 text-xs shadow-hard"
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="font-bold tracking-wide uppercase">Weather areas</h2>
        <Button size="sm" variant="primary" onClick={save} disabled={saving || !dirty}>
          Save{dirty ? " *" : ""}
        </Button>
      </header>
      <p className="text-muted">
        Drag on the map to add a rectangle, then choose what reaches it. Where rectangles overlap
        the lower one in this list decides. Anywhere outside every rectangle gets rain and fog.
      </p>
      {areas.length === 0 ? (
        <p className="text-muted">No areas yet, so rain and fog reach the whole map.</p>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ol className="flex flex-col gap-1">
            {areas.map((area, index) => (
              <li
                key={index}
                className={[
                  "flex flex-col gap-1 border-2 p-1",
                  index === selected ? "border-accent" : "border-border",
                ].join(" ")}
              >
                <div className="flex items-center justify-between gap-1">
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left font-mono"
                    aria-pressed={index === selected}
                    onClick={() => useEditorStore.getState().selectWeatherArea(index)}
                  >
                    {index + 1}. {sizeOf(area)}
                  </button>
                  <Tooltip content="Decide earlier">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Move area ${index + 1} up`}
                      disabled={index === 0}
                      onClick={() => useEditorStore.getState().moveWeatherArea(index, -1)}
                    >
                      <IconArrowUp size={14} aria-hidden="true" />
                    </Button>
                  </Tooltip>
                  <Tooltip content="Decide later">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Move area ${index + 1} down`}
                      disabled={index === areas.length - 1}
                      onClick={() => useEditorStore.getState().moveWeatherArea(index, 1)}
                    >
                      <IconArrowDown size={14} aria-hidden="true" />
                    </Button>
                  </Tooltip>
                  <Tooltip content="Delete area">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Delete area ${index + 1}`}
                      onClick={() => useEditorStore.getState().removeWeatherArea(index)}
                    >
                      <IconTrash size={14} aria-hidden="true" />
                    </Button>
                  </Tooltip>
                </div>
                <div className="flex gap-3">
                  <SwitchField
                    label="Rain"
                    checked={area.rain}
                    onCheckedChange={(rain) =>
                      useEditorStore.getState().updateWeatherArea(index, { rain })
                    }
                  />
                  <SwitchField
                    label="Fog"
                    checked={area.fog}
                    onCheckedChange={(fog) =>
                      useEditorStore.getState().updateWeatherArea(index, { fog })
                    }
                  />
                </div>
              </li>
            ))}
          </ol>
        </ScrollArea>
      )}
    </section>
  );
}
