/**
 * Read a POSIX tar archive.
 *
 * A hundred lines rather than a dependency, because the format is a fixed
 * 512-byte header followed by content padded to 512 bytes, and this only ever
 * reads what `tar` on a build machine produced. Uncompressed: continuous
 * integration pipes it through `gzip -d` on the way out, or does not compress at
 * all — a client build is a few megabytes and the upload is once per deploy.
 *
 * Deliberately strict about what it will produce. Every path is checked by the
 * caller before it becomes a filename, and anything that is not a plain file is
 * skipped rather than interpreted: a symlink in an archive is a way to write
 * outside the directory it is unpacked into.
 */

const BLOCK = 512;

/** Header field offsets, from the POSIX ustar layout. */
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

    // Two consecutive zero blocks end the archive; one is enough to stop on,
    // since a real header always has a name.
    if (header.every((byte) => byte === 0)) break;

    const name = readString(decoder, header, NAME, 100);
    const prefix = readString(decoder, header, PREFIX, 155);
    const size = readOctal(decoder, header, SIZE, 12);
    const type = String.fromCharCode(header[TYPE] ?? 0);

    offset += BLOCK;

    // '0' and '\0' are plain files. Directories ('5') need no entry — the
    // writer creates parents. Everything else, symlinks especially, is skipped:
    // an archive is untrusted input even when we produced it.
    if ((type === "0" || type === "\0") && size > 0) {
      const path = normalizeEntry(prefix ? `${prefix}/${name}` : name);
      if (path) files.set(path, archive.slice(offset, offset + size));
    }

    // Content is padded up to the next block boundary.
    offset += Math.ceil(size / BLOCK) * BLOCK;
  }

  return files;
}

/**
 * Strip the leading `./` that `tar -C dir .` produces, and refuse the rest.
 *
 * An absolute path or one containing `..` is how an archive escapes the
 * directory it is unpacked into. Returning null drops the entry entirely rather
 * than trying to repair it — there is no legitimate build that contains one.
 */
function normalizeEntry(path: string): string | null {
  const cleaned = path.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!cleaned) return null;
  if (cleaned.startsWith("/")) return null;
  if (cleaned.split("/").includes("..")) return null;
  return cleaned;
}

function readString(
  decoder: TextDecoder,
  header: Uint8Array,
  at: number,
  length: number,
): string {
  const field = header.subarray(at, at + length);
  const end = field.indexOf(0);
  return decoder.decode(end === -1 ? field : field.subarray(0, end));
}

function readOctal(
  decoder: TextDecoder,
  header: Uint8Array,
  at: number,
  length: number,
): number {
  const text = readString(decoder, header, at, length).trim();
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}
