import { tilesetUrl } from "./api";
import { LAYERS } from "./humanParts";
import {
  SHEET_HEIGHT_PX,
  SHEET_WIDTH_PX,
  composeSheet,
  humanSheetId,
  splitBlocks,
  type HumanLook,
  type LayerBlocks,
  type Rgba,
} from "./humanSprite";

let blocksPromise: Promise<LayerBlocks> | null = null;
const canvases = new Map<string, Promise<HTMLCanvasElement>>();

async function loadPartFile(file: string): Promise<Rgba[]> {
  const response = await fetch(tilesetUrl(file));
  if (!response.ok) throw new Error(`${file}: ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(bitmap, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return splitBlocks({ data, width, height });
}

/** Every layer's blocks, fetched once per page; a failed fetch is retried on the next call. */
export function loadLayerBlocks(): Promise<LayerBlocks> {
  blocksPromise ??= Promise.all(
    LAYERS.map(async (layer) => [layer.id, await loadPartFile(layer.file)] as const),
  )
    .then((entries) => Object.fromEntries(entries) as LayerBlocks)
    .catch((err: unknown) => {
      blocksPromise = null;
      throw err;
    });
  return blocksPromise;
}

/** A look's composed sheet on a canvas, built once per look and shared by every caller. */
export function humanSheetCanvas(look: HumanLook): Promise<HTMLCanvasElement> {
  const id = humanSheetId(look);
  const cached = canvases.get(id);
  if (cached) return cached;
  const promise = loadLayerBlocks().then((blocks) => {
    const canvas = document.createElement("canvas");
    canvas.width = SHEET_WIDTH_PX;
    canvas.height = SHEET_HEIGHT_PX;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    ctx.putImageData(
      new ImageData(composeSheet(blocks, look), SHEET_WIDTH_PX, SHEET_HEIGHT_PX),
      0,
      0,
    );
    return canvas;
  });
  promise.catch(() => canvases.delete(id));
  canvases.set(id, promise);
  return promise;
}
