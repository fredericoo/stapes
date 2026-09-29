import { IconBulb, IconBulbOff } from "@tabler/icons-react";
import { Toggle, Tooltip } from "../ui";

export function LightingToggle({
  enabled,
  onChange,
  shortcut,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  shortcut?: string;
}) {
  const key = shortcut ? ` (${shortcut})` : "";
  return (
    <Tooltip
      content={
        enabled
          ? `Lighting on${key} — turn it off to draw the art unlit and skip the bake`
          : `Lighting off${key} — the art is drawn as authored, nothing is baked`
      }
    >
      <Toggle pressed={enabled} onPressedChange={onChange} ariaLabel="Lighting">
        {enabled ? (
          <IconBulb size={16} stroke={2} aria-hidden="true" />
        ) : (
          <IconBulbOff size={16} stroke={2} aria-hidden="true" />
        )}
      </Toggle>
    </Tooltip>
  );
}
