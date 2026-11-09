import { browserContext } from "../lib/browserContext";
import type { FrameMeter } from "../render/frameMeter";
import {
  FRAME_REPORT_INTERVAL_MS,
  FRAME_REPORT_PATH,
  type FrameDevice,
  type FrameReport,
} from "./frameReport";

const AREA_CELLS = 16;

export type FrameReportContext = {
  canvas: { width: number; height: number } | null;
  lighting: boolean;
  position: { x: number; y: number; z: number } | null;
};

function device(): FrameDevice {
  const context = browserContext();
  const webgl = context.webgl as { renderer?: string } | null;
  return {
    userAgent: context.userAgent as string,
    platform: (context.platform as string | undefined) ?? null,
    mobile: context.mobile as boolean | null,
    screen: context.screen as string,
    viewport: context.viewport as string,
    devicePixelRatio: context.devicePixelRatio as number,
    cores: context.cores as number | null,
    memoryGb: context.memoryGb as number | null,
    gpu: webgl?.renderer ?? null,
  };
}

/**
 * Sends on a timer and again when the page is hidden, which is the last event
 * a phone reliably delivers before it discards a tab. `sendBeacon` is used
 * because a fetch started there is cancelled with the page.
 */
export function startFrameReports(meter: FrameMeter, context: () => FrameReportContext) {
  const tab = crypto.randomUUID();
  let about: FrameDevice | null = null;

  const send = () => {
    const span = meter.drain();
    const now = context();
    if (!span || !now.canvas) return;
    about ??= device();
    const report: FrameReport = {
      ...span,
      tab,
      build: import.meta.env.BUILD_ID ?? null,
      canvas: `${now.canvas.width}x${now.canvas.height}`,
      lighting: now.lighting,
      area: now.position && {
        x: Math.floor(now.position.x / AREA_CELLS) * AREA_CELLS,
        y: Math.floor(now.position.y / AREA_CELLS) * AREA_CELLS,
        z: now.position.z,
      },
      device: { ...about, viewport: `${innerWidth}x${innerHeight}` },
    };
    navigator.sendBeacon(
      FRAME_REPORT_PATH,
      new Blob([JSON.stringify(report)], { type: "application/json" }),
    );
  };

  const onVisibility = () => {
    if (document.visibilityState === "hidden") send();
  };
  const timer = setInterval(send, FRAME_REPORT_INTERVAL_MS);
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibility);
    send();
  };
}
