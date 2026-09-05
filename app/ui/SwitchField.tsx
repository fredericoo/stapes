import type { ReactNode } from "react";
import { InfoTip } from "./InfoTip";
import { Switch } from "./Switch";

/**
 * A switch with its caption, and the `i` beside them.
 *
 * The caption is a `<label>` so clicking the word flips the switch. The `i` is
 * a button of its own and sits *outside* that label on purpose: anything
 * inside a label is folded into the control's accessible name, so a switch
 * captioned "Push" with the tooltip inside read out as "Push More about
 * this". Two sizes, because a section's switch is its title and a field's
 * switch is one more caption in a row of them.
 */
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
        <Switch
          checked={checked}
          onCheckedChange={onCheckedChange}
          ariaLabel={label}
        />
        {/* Hidden from the tree because the switch already carries this word
            as its aria-label, and Base UI also points it at the wrapping label
            — with the text counted, the switch read as "Push Push". */}
        <span
          aria-hidden="true"
          className={
            size === "section"
              ? "text-sm font-bold"
              : "text-xs font-bold uppercase text-muted"
          }
        >
          {label}
        </span>
      </label>
      {info ? <InfoTip>{info}</InfoTip> : null}
    </div>
  );
}
