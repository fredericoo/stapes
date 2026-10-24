import { tilesetUrl } from "./api";
import { LAYERS } from "./humanParts";
import { splitBlocks, type LayerBlocks, type Rgba } from "./humanSprite";

let blocksPromise: Promise<LayerBlocks> | null = null;

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
