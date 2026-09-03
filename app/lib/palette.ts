/**
 * Fixed Stapes Aseprite palette (opaque entries only) + OKLab matching.
 */

/**
 * Opaque entries from stapes.pal (first two non-opaque dropouts removed),
 * followed by four blues added since. Append only — never reorder or remove:
 * the quantiser picks whichever entry is nearest, so a new colour only ever
 * claims pixels that were already landing on its neighbours, whereas moving
 * one changes what index 0 is, and the status preview's backdrop reads it.
 */
export const STAPES_PALETTE: readonly string[] = [
  "#2e222f",
  "#313638",
  "#45293f",
  "#6e2727",
  "#3e3546",
  "#323353",
  "#165a4c",
  "#484a77",
  "#694f62",
  "#ae2334",
  "#e83b3b",
  "#9e4539",
  "#fb6b1d",
  "#cd683d",
  "#cf657f",
  "#239063",
  "#1ebc73",
  "#f79617",
  "#e6904e",
  "#fbb954",
  "#91db69",
  "#d5e04b",
  "#7f708a",
  "#4d65b4",
  "#4d9be6",
  "#9babb2",
  "#a884f3",
  "#c7dcd0",
  "#ffffff",
  "#affcdb",
  "#53d5cf",
  "#225ac0",
  "#362281",
];

export const PALETTE_SIZE = STAPES_PALETTE.length;

export type Oklab = readonly [number, number, number];

function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = Number.parseInt(m[1]!, 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

/** Flat `vec3` array (length = hex.length * 3) for a GLSL uniform. */
export function paletteRgb01(hex: readonly string[]): Float32Array {
  const out = new Float32Array(hex.length * 3);
  for (let i = 0; i < hex.length; i++) {
    const [r, g, b] = parseHex(hex[i]!);
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  }
  return out;
}

function srgbChannelToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearChannelToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Björn Ottosson sRGB → OKLab. Inputs are sRGB 0..1. */
/**
 * A colour channel dragged back into range.
 *
 * Here rather than private to each caller because every use of it in this
 * codebase is the same use: a round trip through OKLab can land a saturated
 * colour outside sRGB, and a negative channel is not a colour.
 */
export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function srgbToOklab(r: number, g: number, b: number): Oklab {
  const lr = srgbChannelToLinear(r);
  const lg = srgbChannelToLinear(g);
  const lb = srgbChannelToLinear(b);

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

/** Inverse of {@link srgbToOklab}. */
export function oklabToSrgb(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  return [
    linearChannelToSrgb(lr),
    linearChannelToSrgb(lg),
    linearChannelToSrgb(lb),
  ];
}

/** Flat OKLab triples for the uniform (source fragment converts once per pixel). */
export function paletteOklab(hex: readonly string[]): Float32Array {
  const out = new Float32Array(hex.length * 3);
  for (let i = 0; i < hex.length; i++) {
    const [r, g, b] = parseHex(hex[i]!);
    const [L, a, bb] = srgbToOklab(r, g, b);
    out[i * 3] = L;
    out[i * 3 + 1] = a;
    out[i * 3 + 2] = bb;
  }
  return out;
}

/**
 * Mean nearest-neighbour distance in the given flat OKLab array.
 */
export function meanPaletteSpacing(lab: Float32Array): number {
  const n = lab.length / 3;
  if (n < 2) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const Li = lab[i * 3]!;
    const ai = lab[i * 3 + 1]!;
    const bi = lab[i * 3 + 2]!;
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const dL = Li - lab[j * 3]!;
      const da = ai - lab[j * 3 + 1]!;
      const db = bi - lab[j * 3 + 2]!;
      const d = Math.sqrt(dL * dL + da * da + db * db);
      if (d < best) best = d;
    }
    sum += best;
  }
  return sum / n;
}

/**
 * CPU mirror of the GLSL nearest-match. `lab` is a single OKLab triple;
 * `palette` is the flat OKLab array. Distance weights a/b by `chromaWeight`.
 */
export function nearestPaletteIndex(
  lab: Oklab,
  palette: Float32Array,
  chromaWeight = 1,
): number {
  const n = palette.length / 3;
  let best = 0;
  let bestD = Infinity;
  const [L, a, b] = lab;
  for (let i = 0; i < n; i++) {
    const dL = L - palette[i * 3]!;
    const da = a - palette[i * 3 + 1]!;
    const db = b - palette[i * 3 + 2]!;
    const d = dL * dL + chromaWeight * (da * da + db * db);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Nearest by squared sRGB distance (chromaWeight ignored). */
export function nearestPaletteIndexSrgb(
  rgb: readonly [number, number, number],
  paletteRgb: Float32Array,
): number {
  const n = paletteRgb.length / 3;
  let best = 0;
  let bestD = Infinity;
  const [r, g, b] = rgb;
  for (let i = 0; i < n; i++) {
    const dr = r - paletteRgb[i * 3]!;
    const dg = g - paletteRgb[i * 3 + 1]!;
    const db = b - paletteRgb[i * 3 + 2]!;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export function hexToRgb01(hex: string): [number, number, number] {
  return parseHex(hex);
}
