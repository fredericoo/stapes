import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { PNG } from "pngjs";
import { humanPart } from "../../app/lib/humanParts";
import { FRAME_PX, SHEET_FACINGS, SHEET_POSES } from "../../app/lib/humanSprite";

export const TILESETS = path.resolve(import.meta.dirname, "..", "..", "data", "tilesets");
export const BLOCK_W = SHEET_POSES.length * FRAME_PX;
export const BLOCK_H = SHEET_FACINGS.length * FRAME_PX;
export const OUTLINE = "#2e222f";
export const PREVIEW_SCALE = 12;
export const PREVIEW_BACKDROP = "#5a8c5a";

export const read = (file: string) => PNG.sync.read(readFileSync(path.join(TILESETS, file)));

export function hexAt(png: PNG, x: number, y: number): string | null {
  const i = (y * png.width + x) * 4;
  const d = png.data;
  if (d[i + 3] === 0) return null;
  return `#${[d[i]!, d[i + 1]!, d[i + 2]!].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** The colour of a pixel of block `block`, frame (`pose`, `row`), or null where it is transparent. */
export function pixel(
  png: PNG,
  block: number,
  pose: number,
  row: number,
  x: number,
  y: number,
): string | null {
  const columns = Math.floor(png.width / BLOCK_W);
  const bx = (block % columns) * BLOCK_W + pose * FRAME_PX + x;
  const by = Math.floor(block / columns) * BLOCK_H + row * FRAME_PX + y;
  return hexAt(png, bx, by);
}

export const heads = read("human_heads.png");
export const body = read("human_base.png");
export const BALD = humanPart("bald").block;

/** Where a pose has nothing drawn under a worn part but the body's own outline, so the part needs an outline of its own. */
export function openAt(pose: number, row: number) {
  return (x: number, y: number) => {
    const under = pixel(body, 0, pose, row, x, y);
    return !pixel(heads, BALD, pose, row, x, y) && (!under || under === OUTLINE);
  };
}

export function headCentre(pose: number, row: number): [number, number] {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < FRAME_PX; y++) {
    for (let x = 0; x < FRAME_PX; x++) {
      if (!pixel(heads, BALD, pose, row, x, y)) continue;
      sx += x + 0.5;
      sy += y + 0.5;
      n++;
    }
  }
  return [sx / n, sy / n];
}

/** The offset that lays the bald head's east blob, transposed, on its south one. */
export function eastToSouthOffset(pose: number): [number, number] {
  const south = SHEET_FACINGS.indexOf("s");
  const east = SHEET_FACINGS.indexOf("e");
  const blob = (row: number) => {
    const cells: [number, number][] = [];
    for (let y = 0; y < FRAME_PX; y++)
      for (let x = 0; x < FRAME_PX; x++)
        if (pixel(heads, BALD, pose, row, x, y)) cells.push([x, y]);
    return cells;
  };
  const target = new Set(blob(south).map(([x, y]) => y * FRAME_PX + x));
  let best = { overlap: -1, ox: 0, oy: 0 };
  for (let ox = -4; ox <= 4; ox++) {
    for (let oy = -4; oy <= 4; oy++) {
      const overlap = blob(east).filter(([x, y]) =>
        target.has((x + oy) * FRAME_PX + y + ox),
      ).length;
      if (overlap > best.overlap) best = { overlap, ox, oy };
    }
  }
  return [best.ox, best.oy];
}

/** `people.png`'s palette and transparency, which every `human_*.png` is indexed with. */
function peoplePalette(): { colours: string[]; chunks: Buffer[] } {
  const bytes = readFileSync(path.join(TILESETS, "people.png"));
  let plte: Buffer | undefined;
  let trns: Buffer | undefined;
  for (let i = 8; i < bytes.length;) {
    const size = bytes.readUInt32BE(i);
    const type = bytes.toString("ascii", i + 4, i + 8);
    if (type === "PLTE") plte = bytes.subarray(i, i + 12 + size);
    if (type === "tRNS") trns = bytes.subarray(i, i + 12 + size);
    i += 12 + size;
  }
  if (!plte || !trns) throw new Error("people.png is not indexed");
  const colours: string[] = [];
  for (let k = 0; k < (plte.length - 12) / 3; k++) {
    const rgb = [plte[8 + k * 3]!, plte[9 + k * 3]!, plte[10 + k * 3]!];
    const opaque = k >= trns.length - 12 || trns[8 + k] === 255;
    colours.push(opaque ? `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}` : "");
  }
  return { colours, chunks: [plte, trns] };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 4);
  return out;
}

/** pngjs only writes RGBA, and the human sheets stay indexed, so the PNG is assembled here. */
export function writeIndexed(
  file: string,
  width: number,
  height: number,
  colours: (string | null)[],
) {
  const { colours: palette, chunks } = peoplePalette();
  const index = new Map(palette.map((c, i) => [c, i]));
  const transparent = palette.indexOf("");
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = colours[y * width + x];
      const i = c ? index.get(c) : transparent;
      if (i === undefined) throw new Error(`${c} is not in people.png's palette`);
      raw[y * (width + 1) + 1 + x] = i;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 3, 0, 0, 0], 8);
  writeFileSync(
    path.join(TILESETS, file),
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      ...chunks,
      chunk("IDAT", deflateSync(raw, { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

/** Every colour of an indexed human sheet, by `y * width + x`, so a script can rewrite some blocks and keep the rest. */
export function readColours(file: string): { width: number; colours: (string | null)[] } {
  const png = read(file);
  const colours: (string | null)[] = [];
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) colours.push(hexAt(png, x, y));
  return { width: png.width, colours };
}

/** Writes `layers` (each a function from frame pixel to colour, bottom first) for every facing of the standing pose, in rows, at `PREVIEW_SCALE`. */
export function writePreview(
  file: string,
  rows: ((row: number, x: number, y: number) => string | null)[][],
) {
  const w = SHEET_FACINGS.length * FRAME_PX;
  const png = new PNG({ width: w * PREVIEW_SCALE, height: rows.length * FRAME_PX * PREVIEW_SCALE });
  rows.forEach((layers, r) => {
    SHEET_FACINGS.forEach((_, row) => {
      for (let y = 0; y < FRAME_PX; y++) {
        for (let x = 0; x < FRAME_PX; x++) {
          let c = PREVIEW_BACKDROP;
          for (const layer of layers) c = layer(row, x, y) ?? c;
          const n = Number.parseInt(c.slice(1), 16);
          for (let dy = 0; dy < PREVIEW_SCALE; dy++) {
            for (let dx = 0; dx < PREVIEW_SCALE; dx++) {
              const px = (row * FRAME_PX + x) * PREVIEW_SCALE + dx;
              const py = (r * FRAME_PX + y) * PREVIEW_SCALE + dy;
              png.data.set(
                [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255],
                (py * png.width + px) * 4,
              );
            }
          }
        }
      }
    });
  });
  writeFileSync(file, PNG.sync.write(png));
}
