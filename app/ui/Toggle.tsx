import { Toggle as BaseToggle } from "@base-ui/react/toggle";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "./Button";

/**
 * A button that stays down.
 *
 * The same shape and pressed treatment as every other button, because that is
 * what it is — the only difference from an action is that the state it sets is
 * its own. Reach for it over {@link Switch} wherever the control is an icon in
 * a bar: a switch spends the width of a whole word on a track, and what it buys
 * with it is a sliding thumb that halves the room the icon has to say what the
 * control is about.
 *
 * A switch is still right in a settings row, where a label already names the
 * thing and the track sits at the end of the line saying which way it is set.
 */
export function Toggle({
  pressed,
  onPressedChange,
  ariaLabel,
  children,
  variant = "ghost-inverse",
  size = "icon",
  ...props
}: {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  ariaLabel: string;
  /** Usually an icon. */
  children: ReactNode;
  variant?: ComponentProps<typeof Button>["variant"];
  size?: ComponentProps<typeof Button>["size"];
} & Omit<
  ComponentProps<typeof BaseToggle>,
  "pressed" | "onPressedChange" | "render" | "children" | "value"
>) {
  return (
    <BaseToggle
      pressed={pressed}
      onPressedChange={onPressedChange}
      aria-label={ariaLabel}
      render={<Button variant={variant} size={size} active={pressed} />}
      {...props}
    >
      {children}
    </BaseToggle>
  );
}
