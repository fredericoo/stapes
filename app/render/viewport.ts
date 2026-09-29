import { CELL_SIZE } from "../lib/types";
import { VIEW_CELLS } from "../lib/view";

export { VIEW_CELLS };

export const VIEW_PX = VIEW_CELLS * CELL_SIZE;

export type ViewportFit = {
  bufferPx: number;
  renderScale: number;
  cssScale: number;
};

export function fitViewport(cssSize: number, spanPx: number = VIEW_PX): ViewportFit {
  const usable = Math.max(1, Math.floor(cssSize));
  const span = Math.max(1, Math.floor(spanPx));
  const renderScale = Math.max(1, Math.floor(usable / span));
  return {
    bufferPx: span * renderScale,
    renderScale,
    cssScale: usable / span,
  };
}
