import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const TILESETS = path.join(ROOT, "data", "tilesets");

const SOURCE = "people.png";

type Rgb = [number, number, number];

type Sheet = { dest: string; recolour: { from: Rgb; to: Rgb }[] };

const SHEETS: Sheet[] = [
  {
    dest: "townsfolk.png",
    recolour: [
      { from: [110, 39, 39], to: [44, 74, 58] },
      { from: [174, 35, 52], to: [62, 116, 82] },
      { from: [205, 104, 61], to: [140, 120, 72] },
      { from: [251, 185, 84], to: [214, 196, 128] },
      { from: [105, 79, 98], to: [92, 72, 58] },
    ],
  },
  {
    dest: "smith.png",
    recolour: [
      { from: [110, 39, 39], to: [50, 51, 83] },
      { from: [174, 35, 52], to: [72, 74, 119] },
      { from: [205, 104, 61], to: [77, 101, 180] },
      { from: [251, 185, 84], to: [199, 220, 208] },
      { from: [105, 79, 98], to: [69, 41, 63] },
    ],
  },
  {
    dest: "armourer.png",
    recolour: [
      { from: [110, 39, 39], to: [69, 41, 63] },
      { from: [174, 35, 52], to: [168, 132, 243] },
      { from: [205, 104, 61], to: [207, 101, 127] },
      { from: [251, 185, 84], to: [255, 255, 255] },
      { from: [105, 79, 98], to: [158, 69, 57] },
    ],
  },
];

function key([r, g, b]: Rgb): number {
  return (r << 16) | (g << 8) | b;
}

async function main() {
  const source = PNG.sync.read(await fs.readFile(path.join(TILESETS, SOURCE)));

  for (const { dest, recolour } of SHEETS) {
    const lookup = new Map(recolour.map(({ from, to }) => [key(from), to]));

    const out = new PNG({ width: source.width, height: source.height });
    source.data.copy(out.data);

    for (let i = 0; i < out.data.length; i += 4) {
      if (out.data[i + 3] === 0) continue;
      const swap = lookup.get(key([out.data[i]!, out.data[i + 1]!, out.data[i + 2]!]));
      if (!swap) continue;
      [out.data[i], out.data[i + 1], out.data[i + 2]] = swap;
    }

    await fs.writeFile(path.join(TILESETS, dest), PNG.sync.write(out));
    console.log(`Generated data/tilesets/${dest} from ${SOURCE}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
