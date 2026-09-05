/**
 * Derives further sets of clothes for the one person in `people.png`.
 * Run: bun run generate:npcs
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

type Rgb = [number, number, number];

/** One person's cloth, as `from -> to` against {@link SOURCE}. */
type Sheet = { dest: string; recolour: { from: Rgb; to: Rgb }[] };

/**
 * Every derived sheet, keyed on the exact source colour rather than on a hue
 * rotation: the source is a hand-picked palette of eleven entries, and a
 * rotation would land between them and quietly add colours to a sheet whose
 * whole look comes from not having any spare ones.
 *
 * Each one moves the same five warm entries, because those five are the cloth.
 * Two sheets that moved different subsets would be two figures shaded
 * differently rather than two people dressed differently.
 */
const SHEETS: Sheet[] = [
  {
    dest: "townsfolk.png",
    recolour: [
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
    ],
  },
  {
    // The smith. Cold where the other two are warm: the player is red and the
    // townsfolk green, and a third person in brown leather — the obvious
    // choice for somebody at a forge — would be the player again at eight
    // pixels tall. Every entry below is already in `app/lib/palette`'s list.
    dest: "smith.png",
    recolour: [
      // Deep red shadow -> deep blue shadow.
      { from: [110, 39, 39], to: [50, 51, 83] },
      // The main red of the tunic -> blue work cloth.
      { from: [174, 35, 52], to: [72, 74, 119] },
      // Orange trim -> a brighter blue.
      { from: [205, 104, 61], to: [77, 101, 180] },
      // Yellow highlight -> pale steel, a colour the sheet already carries, so
      // the highlight stays a highlight without widening the palette.
      { from: [251, 185, 84], to: [199, 220, 208] },
      // Plum hair -> near-black.
      { from: [105, 79, 98], to: [69, 41, 63] },
    ],
  },
  {
    // The armourer, who sells cloth as well as plate and is dressed out of
    // the dyed end of their own stock. Violet is the one hue none of the
    // three above uses, which is the whole criterion: a fourth person has to
    // be told from the other three at a glance and there is only one figure
    // drawn to tell them apart with.
    dest: "armourer.png",
    recolour: [
      // Deep red shadow -> dark plum shadow.
      { from: [110, 39, 39], to: [69, 41, 63] },
      // The main red of the tunic -> dyed violet.
      { from: [174, 35, 52], to: [168, 132, 243] },
      // Orange trim -> rose.
      { from: [205, 104, 61], to: [207, 101, 127] },
      // Yellow highlight -> white, which the sheet already carries, so violet
      // keeps a sheen without the palette gaining a colour for it.
      { from: [251, 185, 84], to: [255, 255, 255] },
      // Plum hair -> auburn.
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
      // A fully transparent pixel has no colour worth matching, and matching it
      // anyway would repaint the empty half of the sheet.
      if (out.data[i + 3] === 0) continue;
      const swap = lookup.get(
        key([out.data[i]!, out.data[i + 1]!, out.data[i + 2]!]),
      );
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
