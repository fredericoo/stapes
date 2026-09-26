import { IconEye, IconEyeOff } from "@tabler/icons-react";
import { Toggle, Tooltip } from "../ui";

export function InvisibleToggle({
  hidden,
  onChange,
}: {
  hidden: boolean;
  onChange: (hidden: boolean) => void;
}) {
  return (
    <Tooltip
      content={
        hidden
          ? "Invisible — other players cannot see you, hear you or count you"
          : "Visible — turn on to disappear from other players as if you were offline"
      }
    >
      <Toggle pressed={hidden} onPressedChange={onChange} ariaLabel="Invisible">
        {hidden ? (
          <IconEyeOff size={16} stroke={2} aria-hidden="true" />
        ) : (
          <IconEye size={16} stroke={2} aria-hidden="true" />
        )}
      </Toggle>
    </Tooltip>
  );
}
