import type { ReactNode } from "react";
import { InfoTip } from "./InfoTip";

/**
 * The caption over a control, with its `i` when there is more to say.
 *
 * One component so every caption in the editor is the same size and weight,
 * and so the tooltip sits in the same place beside every one of them. The
 * caption is the field's name in the engine's own words; `info` is what the
 * engine does with it. Nothing else belongs up here — a sentence that only
 * restates the caption is the thing this replaced.
 */
export function FieldLabel({
  children,
  info,
  className = "",
}: {
  children: ReactNode;
  info?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={[
        "inline-flex items-center gap-1 text-xs font-bold uppercase text-muted",
        className,
      ].join(" ")}
    >
      {children}
      {info ? <InfoTip>{info}</InfoTip> : null}
    </span>
  );
}

/**
 * A section's title: the same caption, at the weight a group of fields gets,
 * with room on the left for the switch that turns the section on.
 */
export function SectionTitle({
  children,
  info,
}: {
  children: ReactNode;
  info?: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-bold">
      {children}
      {info ? <InfoTip>{info}</InfoTip> : null}
    </span>
  );
}
