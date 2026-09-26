const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** Signature (8) + length (4) + "IHDR" (4) + width (4) + height (4). */
const IHDR_END = 24;

export function readPngSize(bytes: Uint8Array): {
  width: number;
  height: number;
} {
  if (bytes.length < IHDR_END) throw new Error("Not a PNG");
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error("Not a PNG");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
