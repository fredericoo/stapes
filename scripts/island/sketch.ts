import sharp from "sharp";

export const SKETCH_PATH = "docs/lore-map.webp";

export const enum Mark {
  Unknown = 0,
  Sea = 1,
  Land = 2,
  Water = 3,
  Snow = 4,
  Desert = 5,
  Lava = 6,
}

export type Sketch = {
  width: number;
  height: number;
  marks: Uint8Array;
};

/**
 * Sorts one sketch pixel into what it shows. The gorge is drawn as a dark
 * red-brown channel round a brighter line of lava, and both read as lava. The lighthouse's two grey beams
 * are drawn over the sea south-east of the headland, so low-saturation grey
 * there is sea; everywhere else it is the mountain's rocky rim.
 */
function classify(r: number, g: number, b: number, px: number, py: number): Mark {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (min > 232) return Mark.Snow;
  if (r > 180 && g < 120 && b < 90) return Mark.Lava;
  if (r > 110 && r < 200 && g < 118 && r - g > 36 && b < 90) return Mark.Lava;
  if (r - b > 60 && r > g + 18) return Mark.Desert;
  if (b > r + 12 && b >= g - 4) return Mark.Water;
  if (max - min < 22 && max > 95 && max < 200 && px > 880 && py > 820) return Mark.Water;
  if (g >= b - 4 && max > 60) return Mark.Land;
  return Mark.Unknown;
}

/** The two region names lettered over the sea, in sketch pixels, clipped to stop short of the coast. */
const SEA_LABELS: ReadonlyArray<readonly [number, number, number, number]> = [
  [90, 190, 382, 238],
  [1098, 212, 1345, 256],
];

/**
 * Reads the planning sketch into one mark per sketch pixel. Labels, roads,
 * markers and their outlines read as `Unknown` and are filled from the pixels
 * round them.
 */
export async function readSketch(path = SKETCH_PATH): Promise<Sketch> {
  const { data, info } = await sharp(path)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const marks = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const mark = classify(data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!, x, y);
      const lettered = SEA_LABELS.some(
        ([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1,
      );
      marks[i] = lettered ? Mark.Sea : mark;
    }
  }
  return { width, height, marks };
}
