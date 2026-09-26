export type GifFrame = {
  readonly indices: Uint8Array;
  readonly delayCs: number;
};

export type GifOptions = {
  readonly width: number;
  readonly height: number;
  readonly palette: readonly (readonly [number, number, number])[];
  readonly transparentIndex: number | null;
};

class ByteWriter {
  private bytes: number[] = [];
  byte(b: number): void {
    this.bytes.push(b & 0xff);
  }
  u16(n: number): void {
    this.byte(n);
    this.byte(n >> 8);
  }
  ascii(s: string): void {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }
  append(data: ArrayLike<number>): void {
    for (let i = 0; i < data.length; i++) this.byte(data[i]!);
  }
  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

function lzw(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const out: number[] = [];
  let bitBuf = 0;
  let bitCount = 0;
  let codeSize = minCodeSize + 1;
  let next = end + 1;
  let dict = new Map<string, number>();

  const emit = (code: number): void => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuf & 0xff);
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };
  const reset = (): void => {
    dict = new Map();
    codeSize = minCodeSize + 1;
    next = end + 1;
  };

  emit(clear);
  let prefix = String(indices[0]);
  let prefixCode = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!;
    const key = `${prefix},${k}`;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = key;
      prefixCode = found;
      continue;
    }
    emit(prefixCode);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > 1 << codeSize && codeSize < 12) codeSize++;
    } else {
      emit(clear);
      reset();
    }
    prefix = String(k);
    prefixCode = k;
  }
  emit(prefixCode);
  emit(end);
  if (bitCount > 0) out.push(bitBuf & 0xff);

  const blocks: number[] = [];
  for (let i = 0; i < out.length; i += 255) {
    const chunk = out.slice(i, i + 255);
    blocks.push(chunk.length, ...chunk);
  }
  blocks.push(0);
  return Uint8Array.from(blocks);
}

export function encodeGif(opts: GifOptions, frames: readonly GifFrame[]): Uint8Array {
  const { width, height, palette, transparentIndex } = opts;
  let tableBits = 1;
  while (1 << tableBits < palette.length) tableBits++;
  const minCodeSize = Math.max(2, tableBits);

  const w = new ByteWriter();
  w.ascii("GIF89a");
  w.u16(width);
  w.u16(height);
  w.byte(0x80 | ((tableBits - 1) << 4) | (tableBits - 1));
  w.byte(0);
  w.byte(0);
  for (let i = 0; i < 1 << tableBits; i++) {
    const c = palette[i] ?? [0, 0, 0];
    w.byte(c[0]);
    w.byte(c[1]);
    w.byte(c[2]);
  }

  w.byte(0x21);
  w.byte(0xff);
  w.byte(11);
  w.ascii("NETSCAPE2.0");
  w.byte(3);
  w.byte(1);
  w.u16(0);
  w.byte(0);

  for (const frame of frames) {
    w.byte(0x21);
    w.byte(0xf9);
    w.byte(4);
    w.byte((2 << 2) | (transparentIndex === null ? 0 : 1));
    w.u16(frame.delayCs);
    w.byte(transparentIndex ?? 0);
    w.byte(0);

    w.byte(0x2c);
    w.u16(0);
    w.u16(0);
    w.u16(width);
    w.u16(height);
    w.byte(0);
    w.byte(minCodeSize);
    w.append(lzw(frame.indices, minCodeSize));
  }

  w.byte(0x3b);
  return w.toUint8Array();
}
