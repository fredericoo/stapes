import { Button as BaseButton } from "@base-ui/react/button";
import type { ComponentProps } from "react";

/** `ghost-inverse` is the ghost treatment for dark surfaces, e.g. the app header. */
type Variant = "primary" | "secondary" | "danger" | "ghost" | "ghost-inverse";
type Size = "sm" | "md" | "icon";

const variantClass: Record<Variant, string> = {
  primary: "bg-accent text-paper border-border hover:brightness-110",
  secondary: "bg-panel text-ink border-border hover:bg-paper",
  danger: "bg-danger text-paper border-border hover:brightness-110",
  ghost: "bg-transparent text-ink border-transparent hover:bg-panel",
  "ghost-inverse":
    "bg-transparent text-paper border-transparent hover:bg-paper/20",
};

const defaultPressedClass =
  "bg-ink text-paper border-border hover:brightness-125";

const pressedClass: Partial<Record<Variant, string>> = {
  "ghost-inverse": "bg-paper text-ink border-paper",
};

const sizeClass: Record<Size, string> = {
  sm: "px-2 py-1 text-xs",
  md: "px-3 py-1.5 text-sm",
  icon: "p-1.5",
};

type Props = ComponentProps<typeof BaseButton> & {
  variant?: Variant;
  size?: Size;
  active?: boolean;
};

export function Button({
  variant = "secondary",
  size = "md",
  active = false,
  className = "",
  ...props
}: Props) {
  // Conflicting utilities can't be resolved by class order (`.shadow-hard` is
  // authored CSS and always beats `.shadow-none`), so pick one set up front.
  const raised = variant !== "ghost" && variant !== "ghost-inverse";

  return (
    <BaseButton
      className={[
        "inline-flex items-center justify-center gap-1 border-2 font-medium",
        "transition-none select-none",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        "disabled:cursor-not-allowed disabled:opacity-50",
        raised && !active
          ? "shadow-hard active:shadow-none disabled:active:shadow-hard"
          : "",
        raised
          ? "active:translate-x-[2px] active:translate-y-[2px] disabled:active:translate-x-0 disabled:active:translate-y-0"
          : "",
        raised && active ? "translate-x-[2px] translate-y-[2px]" : "",
        active
          ? (pressedClass[variant] ?? defaultPressedClass)
          : variantClass[variant],
        sizeClass[size],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...props}
    />
  );
}
