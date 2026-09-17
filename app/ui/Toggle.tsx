import { Toggle as BaseToggle } from "@base-ui/react/toggle";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "./Button";

/**
 * A button that stays down.
 *
 * Use it over {@link Switch} wherever the control is an icon in a bar: a
 * switch's track takes the width of a word and halves the room the icon has.
 * A switch is still right in a settings row, where a label names the thing.
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
