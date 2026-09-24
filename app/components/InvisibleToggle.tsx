import { IconEye, IconEyeOff } from "@tabler/icons-react";
import { Toggle, Tooltip } from "../ui";

/**
 * Hide this character from other players. Administrators only.
 *
 * Drawn from what the server last said rather than from the press: what it
 * controls is what *other* people are sent, so it shows on only once the server
 * has stopped sending them this body. @see RemoteSession.setHidden
 *
 * The menu renders it only for an administrator's account, and the server
 * ignores the message from anybody else, so the button is a convenience and
 * not the control.
 */
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
