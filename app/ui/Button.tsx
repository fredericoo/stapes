import { Button as BaseButton } from "@base-ui/react/button";
import type { ComponentProps } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";
type Size = "sm" | "md";

const variantClass: Record<Variant, string> = {
  primary:
    "bg-accent text-paper border-border hover:brightness-110 disabled:opacity-50",
  secondary:
    "bg-panel text-ink border-border hover:bg-paper disabled:opacity-50",
  danger:
    "bg-danger text-paper border-border hover:brightness-110 disabled:opacity-50",
  ghost:
    "bg-transparent text-ink border-transparent hover:bg-panel shadow-none hover:shadow-none active:translate-x-0 active:translate-y-0 active:shadow-none",
};

const sizeClass: Record<Size, string> = {
  sm: "px-2 py-1 text-xs",
  md: "px-3 py-1.5 text-sm",
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
  return (
    <BaseButton
      className={[
        "inline-flex items-center justify-center gap-1 border-2 font-medium",
        "shadow-hard transition-none select-none",
        "active:translate-x-[2px] active:translate-y-[2px] active:shadow-none",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        "disabled:cursor-not-allowed disabled:active:translate-x-0 disabled:active:translate-y-0 disabled:active:shadow-hard",
        variantClass[variant],
        sizeClass[size],
        active ? "translate-x-[2px] translate-y-[2px] shadow-none bg-ink text-paper" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...props}
    />
  );
}
