import { useRef } from "react";
import { NOTICE_FLASH_CLASS, type PanelNotice, useNoticeAnimation } from "./panelNotice";

/** Must sit inside a positioned box: the flash fills its nearest one. */
export function NoticeIcon({
  notice,
  children,
}: {
  notice: PanelNotice | null;
  children: React.ReactNode;
}) {
  const iconRef = useRef<HTMLSpanElement>(null);
  const flashRef = useRef<HTMLSpanElement>(null);
  useNoticeAnimation(notice, iconRef, flashRef);

  return (
    <>
      <span
        ref={flashRef}
        aria-hidden="true"
        className={[
          "pointer-events-none absolute inset-0 opacity-0",
          NOTICE_FLASH_CLASS[notice?.tone ?? "neutral"],
        ].join(" ")}
      />
      <span ref={iconRef} className="relative inline-flex">
        {children}
      </span>
    </>
  );
}
