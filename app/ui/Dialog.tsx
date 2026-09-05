import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ReactNode } from "react";

export function Dialog({
  open,
  onOpenChange,
  title,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * The editor size: as wide as the window allows, and a fixed height.
   *
   * Fixed rather than fitted because a wide dialog is a tabbed one, and a
   * popup sized to its content jumps every time a tab with a different amount
   * in it is opened — the footer and its Save button move under the pointer.
   * The body scrolls inside the box instead. A narrow dialog is one short form
   * and keeps fitting its content.
   */
  wide?: boolean;
}) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-40 bg-ink/50" />
        <BaseDialog.Popup
          className={[
            "fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "flex flex-col border-2 border-border bg-paper shadow-hard",
            wide
              ? "h-[90vh] w-[min(1100px,96vw)]"
              : "max-h-[90vh] w-[min(560px,94vw)]",
          ].join(" ")}
        >
          <div className="flex items-center justify-between border-b-2 border-border bg-ink px-3 py-2 text-paper">
            <BaseDialog.Title className="text-sm font-bold uppercase tracking-wide">
              {title}
            </BaseDialog.Title>
            <BaseDialog.Close className="border-2 border-transparent px-2 py-0.5 text-sm text-paper hover:border-paper">
              ✕
            </BaseDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
          {footer ? (
            <div className="flex items-center justify-end gap-2 border-t-2 border-border bg-panel p-3">
              {footer}
            </div>
          ) : null}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
