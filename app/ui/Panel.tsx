import type { ReactNode } from "react";

export function Panel({
  children,
  className = "",
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <div
      className={[
        "border-2 border-border bg-panel shadow-hard",
        className,
      ].join(" ")}
    >
      {title ? (
        <div className="border-b-2 border-border bg-ink px-2 py-1 text-xs font-bold uppercase tracking-wide text-paper">
          {title}
        </div>
      ) : null}
      {children}
    </div>
  );
}
