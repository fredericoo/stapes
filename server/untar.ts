const BLOCK = 512;

const NAME = 0;
const SIZE = 124;
const TYPE = 156;
const PREFIX = 345;

export function untar(archive: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  let offset = 0;

  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);

    if (header.every((byte) => byte === 0)) break;

    const name = readString(decoder, header, NAME, 100);
    const prefix = readString(decoder, header, PREFIX, 155);
    const size = readOctal(decoder, header, SIZE, 12);
    const type = String.fromCharCode(header[TYPE] ?? 0);

    offset += BLOCK;

    if ((type === "0" || type === "\0") && size > 0) {
      const path = normalizeEntry(prefix ? `${prefix}/${name}` : name);
      if (path) files.set(path, archive.slice(offset, offset + size));
    }

    offset += Math.ceil(size / BLOCK) * BLOCK;
  }

  return files;
}

function normalizeEntry(path: string): string | null {
  const cleaned = path.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!cleaned) return null;
  if (cleaned.startsWith("/")) return null;
  if (cleaned.split("/").includes("..")) return null;
  return cleaned;
}

function readString(decoder: TextDecoder, header: Uint8Array, at: number, length: number): string {
  const field = header.subarray(at, at + length);
  const end = field.indexOf(0);
  return decoder.decode(end === -1 ? field : field.subarray(0, end));
}

function readOctal(decoder: TextDecoder, header: Uint8Array, at: number, length: number): number {
  const text = readString(decoder, header, at, length).trim();
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}
