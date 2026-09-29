import type { ReactNode } from "react";
import { InfoTip } from "./InfoTip";

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

export function SectionTitle({ children, info }: { children: ReactNode; info?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-bold">
      {children}
      {info ? <InfoTip>{info}</InfoTip> : null}
    </span>
  );
}
