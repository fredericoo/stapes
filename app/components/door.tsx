import { IconAlertCircle } from "@tabler/icons-react";
import type { ComponentProps, ReactNode } from "react";

export const SYSTEM_MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

export function Door({ children }: { children: ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-30 flex flex-col items-center justify-center gap-5 overflow-y-auto bg-ink p-6"
      style={{ fontFamily: SYSTEM_MONO }}
    >
      {children}
    </div>
  );
}

export function DoorLogo() {
  return (
    <img
      src="/logo.png"
      alt="The Last Stones"
      width={263}
      height={104}
      className="w-[263px] max-w-full min-[574px]:w-[526px]"
      style={{ imageRendering: "pixelated" }}
    />
  );
}

export function DoorTitle({ children }: { children: ReactNode }) {
  return <h1 className="text-xs uppercase tracking-widest text-paper/60">{children}</h1>;
}

export function DoorField({ label, ...props }: ComponentProps<"input"> & { label: string }) {
  return (
    <label className="flex w-full flex-col gap-1">
      <span className="text-[10px] uppercase tracking-widest text-paper/60">{label}</span>
      <input
        className="border-2 border-paper/40 bg-transparent px-3 py-2 text-base text-paper placeholder:text-paper/30 focus:border-paper focus:outline-none disabled:opacity-50"
        style={{ fontFamily: SYSTEM_MONO }}
        {...props}
      />
    </label>
  );
}

export function DoorButton({ className = "", ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={`border-2 border-paper px-6 py-3 text-xs uppercase tracking-widest text-paper hover:bg-paper hover:text-ink disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-paper ${className}`}
      style={{ fontFamily: SYSTEM_MONO }}
      {...props}
    />
  );
}

export function DoorError({ children }: { children: ReactNode }) {
  return (
    <p
      className="flex max-w-sm items-start gap-2 text-xs leading-relaxed text-danger-on-ink"
      role="alert"
    >
      <IconAlertCircle size={16} stroke={2} className="shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

export function DoorNote({ children }: { children: ReactNode }) {
  return <p className="max-w-sm text-center text-xs leading-relaxed text-paper/40">{children}</p>;
}
