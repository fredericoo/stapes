import type { ComponentProps } from "react";
import { Input as BaseInput } from "@base-ui/react/input";

// `ComponentProps<"input">` rather than `InputHTMLAttributes` so `ref` comes
// with the rest of the props — a caller that wants to focus this field by
// keyboard has no other way to reach it.
type Props = ComponentProps<"input">;

export function Input({ className = "", ...props }: Props) {
  return (
    <BaseInput
      className={[
        "border-2 border-border bg-paper px-2 py-1 text-sm text-ink shadow-hard",
        "placeholder:text-muted",
        "focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-accent",
        "disabled:opacity-50",
        className,
      ].join(" ")}
      {...props}
    />
  );
}
