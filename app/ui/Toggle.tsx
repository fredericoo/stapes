import { Toggle as BaseToggle } from "@base-ui/react/toggle";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "./Button";

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
