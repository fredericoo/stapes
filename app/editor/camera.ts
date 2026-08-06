import { useEditorStore } from "./store";

/** Apply a wheel event as a camera pan (same math as the map canvas). */
export function panCameraByWheel(
  e: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "shiftKey">,
  pageSize?: { width: number; height: number },
) {
  const store = useEditorStore.getState();
  // Shift+wheel on mice often only reports deltaY — treat it as horizontal.
  let dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
  let dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
  if (e.deltaMode === 1) {
    dx *= 16;
    dy *= 16;
  } else if (e.deltaMode === 2) {
    dx *= pageSize?.width ?? window.innerWidth;
    dy *= pageSize?.height ?? window.innerHeight;
  }
  store.setCamera({
    x: store.camera.x + dx / store.zoom,
    y: store.camera.y + dy / store.zoom,
  });
}
