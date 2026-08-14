import { IconBulb, IconBulbOff } from "@tabler/icons-react";
import { Switch, Tooltip } from "../ui";

/**
 * Turn the world's lighting off.
 *
 * Off is not a dimmer or a fullbright ambient: the renderer stops baking,
 * stitching and uploading light entirely and draws the art as authored. It
 * exists for the two moments where light is in the way — judging a sprite
 * against its neighbours in the editor, and measuring anything else on the
 * frame while the most expensive phase is out of the picture.
 *
 * Shared by `/play`, `/online` and `/map` so the control means the same thing
 * and sits in the same place in all three, even though each keeps the flag
 * somewhere different.
 */
export function LightingToggle({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <Tooltip
      content={
        enabled
          ? "Lighting on — turn off to draw unlit and skip the bake"
          : "Lighting off — nothing is baked or uploaded"
      }
    >
      <Switch
        checked={enabled}
        onCheckedChange={onChange}
        ariaLabel="Lighting"
        thumb={
          enabled ? (
            <IconBulb size={16} stroke={2.5} aria-hidden="true" />
          ) : (
            <IconBulbOff size={16} stroke={2.5} aria-hidden="true" />
          )
        }
      />
    </Tooltip>
  );
}
