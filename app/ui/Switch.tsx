import { Switch as BaseSwitch } from "@base-ui/react/switch";
import type { ComponentProps, ReactNode } from "react";

type Props = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  ariaLabel: string;
  /** Rendered inside the thumb (e.g. an icon). */
  thumb?: ReactNode;
  className?: string;
} & Omit<
  ComponentProps<typeof BaseSwitch.Root>,
  "checked" | "onCheckedChange" | "className" | "children"
>;

export function Switch({
  checked,
  onCheckedChange,
  ariaLabel,
  thumb,
  className = "",
  ...props
}: Props) {
  return (
    <BaseSwitch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={ariaLabel}
      className={[
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center",
        "border-2 border-border bg-paper shadow-hard",
        "transition-none select-none",
        "data-[checked]:bg-accent",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...props}
    >
      <BaseSwitch.Thumb
        className={[
          "pointer-events-none flex size-3.5 items-center justify-center",
          "bg-ink text-paper",
          "transition-transform duration-100 ease-out",
          "translate-x-0.5 data-[checked]:translate-x-4",
          "data-[checked]:bg-paper data-[checked]:text-ink",
        ].join(" ")}
      >
        {thumb}
      </BaseSwitch.Thumb>
    </BaseSwitch.Root>
  );
}
