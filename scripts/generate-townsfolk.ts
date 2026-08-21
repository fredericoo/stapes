/**
 * Derives a second set of clothes for the one person in `people.png`.
 * Run: pnpm generate:townsfolk
 *
 * There is exactly one humanoid drawn for this world and the player is wearing
 * it, so the first NPC anybody stands next to would be the player's twin — which
 * is the single worst thing a body can look like in a game where the interesting
 * question is *who* said that. Redrawing the figure is the right fix and needs
 * somebody who can draw; recolouring it is the cheap one, and it is honest about
 * being cheap: same silhouette, same animation, different person.
 *
 * Only the warm tones move. The greys and the outline carry every bit of the
 * shading and the read of the pose, so a remap that touched them would make a
 * flatter figure rather than a differently dressed one — what changes is the
 * cloth, which is what tells two people apart at eight pixels tall anyway.
 *
 * Generated rather than committed as art because there is no drawing decision in
 * it: the output is pinned by `people.png` plus the table below, so a hand-edited
 * version is either identical to this or a divergence nobody meant.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const TILESETS = path.join(ROOT, "data", "tilesets");

const SOURCE = "people.png";
const DEST = "townsfolk.png";

type Rgb = [number, number, number];

/**
 * Warm cloth to cool cloth, as `from -> to`.
 *
 * Keyed on the exact colour rather than on a hue rotation because the source is
 * a hand-picked palette of eleven entries: a rotation would land between them
 * and quietly add colours to a sheet whose whole look comes from not having any
 * spare ones.
 */
const RECOLOUR: { from: Rgb; to: Rgb }[] = [
  // Deep red shadow -> deep green shadow.
  { from: [110, 39, 39], to: [44, 74, 58] },
  // The main red of the tunic -> green.
  { from: [174, 35, 52], to: [62, 116, 82] },
  // Orange trim -> olive.
  { from: [205, 104, 61], to: [140, 120, 72] },
  // Yellow highlight -> pale gold, which keeps the highlight reading as one.
  { from: [251, 185, 84], to: [214, 196, 128] },
  // Plum hair -> brown.
  { from: [105, 79, 98], to: [92, 72, 58] },
];

function key([r, g, b]: Rgb): number {
  return (r << 16) | (g << 8) | b;
}

async function main() {
  const source = PNG.sync.read(await fs.readFile(path.join(TILESETS, SOURCE)));
  const lookup = new Map(RECOLOUR.map(({ from, to }) => [key(from), to]));

  const out = new PNG({ width: source.width, height: source.height });
  source.data.copy(out.data);

  for (let i = 0; i < out.data.length; i += 4) {
    // A fully transparent pixel has no colour worth matching, and matching it
    // anyway would repaint the empty half of the sheet.
    if (out.data[i + 3] === 0) continue;
    const swap = lookup.get(
      key([out.data[i]!, out.data[i + 1]!, out.data[i + 2]!]),
    );
    if (!swap) continue;
    [out.data[i], out.data[i + 1], out.data[i + 2]] = swap;
  }

  const dest = path.join(TILESETS, DEST);
  await fs.writeFile(dest, PNG.sync.write(out));
  console.log(`Generated data/tilesets/${DEST} from ${SOURCE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
