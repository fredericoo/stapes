import type { ReactNode } from "react";
import { InfoTip } from "./InfoTip";
import { Switch } from "./Switch";

export function SwitchField({
  checked,
  onCheckedChange,
  label,
  info,
  size = "field",
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  info?: ReactNode;
  size?: "section" | "field";
}) {
  return (
    <div className="flex items-center gap-1.5">
      <label className="flex items-center gap-2">
        <Switch checked={checked} onCheckedChange={onCheckedChange} ariaLabel={label} />
        <span
          aria-hidden="true"
          className={
            size === "section" ? "text-sm font-bold" : "text-xs font-bold uppercase text-muted"
          }
        >
          {label}
        </span>
      </label>
      {info ? <InfoTip>{info}</InfoTip> : null}
    </div>
  );
}
