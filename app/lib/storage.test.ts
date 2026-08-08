import { describe, expect, it } from "vitest";
import { readPngSize } from "./storage.server";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** The first 24 bytes of a PNG: signature, IHDR chunk header, width, height. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set(SIGNATURE, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // IHDR payload length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe("readPngSize", () => {
  it("reads width and height from the IHDR chunk", () => {
    expect(readPngSize(pngHeader(160, 64))).toEqual({ width: 160, height: 64 });
  });

  it("reads dimensions past the 16-bit range", () => {
    expect(readPngSize(pngHeader(4096, 70000))).toEqual({
      width: 4096,
      height: 70000,
    });
  });

  it("rejects bytes that do not start with the PNG signature", () => {
    const notPng = pngHeader(8, 8);
    notPng[3] = 0;
    expect(() => readPngSize(notPng)).toThrow("Not a PNG");
  });

  it("rejects a file too short to hold an IHDR", () => {
    expect(() => readPngSize(pngHeader(8, 8).subarray(0, 23))).toThrow(
      "Not a PNG",
    );
  });

  /**
   * The bytes arrive as a view onto a larger upload buffer, so reading through
   * the underlying ArrayBuffer rather than the view would find the wrong offset.
   */
  it("honours a non-zero byteOffset", () => {
    const padded = new Uint8Array(32);
    padded.set(pngHeader(320, 128), 8);
    expect(readPngSize(padded.subarray(8))).toEqual({
      width: 320,
      height: 128,
    });
  });
});
