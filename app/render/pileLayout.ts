/**
 * Where the sprites of a pile sit inside the cell they share.
 *
 * A pile is one placement holding several things — see `../lib/piles` — and up
 * to now it drew as one sprite with a number beside it. This is the other half
 * of that: three berries look like three berries, laid out the way the pips on a
 * die are, so the count is legible on the board without reading anything.
 *
 * ## Deterministic, not jittered
 *
 * Nothing here is random. A heap that re-scattered itself every rebuild would
 * shimmer whenever anything else in the cell changed, and two clients would draw
 * the same pile differently — the map is the only state, and it carries a count
 * and not a seed. The same count always produces the same arrangement.
 *
 * ## Two arrangements, and why there have to be two
 *
 * **Up to six it is the die face**, from a table, because a die's faces are not
 * a fill order and cannot be generated: the centre pip is there at one, gone at
 * two, back at three, gone at four, back at five and gone again at six. No
 * monotone rule over a lattice does that. It is a table because it *is* a table.
 *
 * **Past six there is no die face left to copy**, so the arrangement becomes the
 * general one: the integer positions inside a small disc, chosen by taking the
 * centre and then repeatedly the position furthest from everything already
 * taken. Farthest-first is four lines, it never picks the same pixel twice — the
 * offsets are whole pixels, so a candidate set that ran out would mean two
 * sprites drawn exactly on top of each other — and it spreads whatever number it
 * is given without knowing anything about that number in advance.
 *
 * The seam is visible if you go looking: seven is not "six plus one" and does
 * not need to be. Both halves put a dot near the middle and the rest around it,
 * which is the whole of what a pile has to say.
 *
 * ## Whole pixels
 *
 * Offsets are integers in world pixels, and that is not fussiness. A merged
 * static quad at a fractional offset samples its texture off the pixel grid for
 * as long as it exists — one column of the sprite comes out a pixel wider than
 * its neighbour, and it never settles the way a walking sprite's does. A walker
 * gets to be between pixels because it is going somewhere; a heap on the floor
 * is not.
 */

/** How far a sprite moves from where it would have been drawn, in world pixels. */
export type PileOffset = { dx: number; dy: number };

/**
 * The one offset for anything that is not a pile: none at all.
 *
 * Shared rather than rebuilt, because every tile in the world asks for it and
 * exactly one of them in a thousand is a pile.
 */
export const NO_PILE_OFFSET: readonly PileOffset[] = [{ dx: 0, dy: 0 }];

/**
 * Most sprites one pile draws, however many it holds.
 *
 * A dozen is the widest pile anybody has authored (`data/tiles.json`'s berries),
 * so up to that the picture is exact. Past it the picture stops being exact and
 * the tally beside the name carries the number instead — which is the right
 * trade in both directions: ninety-nine sprites in one cell is ninety-nine quads
 * for a heap nobody could have counted anyway.
 *
 * Counting by eye gives out well before this does. A die face is exact to six;
 * past that a heap reads as *how big* rather than as a number, which is the
 * honest thing for it to say and the reason the tally exists.
 */
export const MAX_PILE_SPRITES = 12;

/**
 * How far out a pip sits on a die face, in world pixels.
 *
 * **Fixed, unlike the disc below**, and that is what makes a face read as a
 * face: the pips of a die are the same distance apart whichever face is up, so a
 * two that spread further than a five would look like a different object rather
 * than the same object holding more.
 *
 * **Three of the eight pixels a cell is wide**, which puts opposite pips six
 * apart, and the number was arrived at by looking. Two was the first attempt and
 * was wrong for a reason worth writing down: a tile's sprite is as wide as its
 * cell, so pips four apart overlap by half their own width and a four and a five
 * come out as the same red blob. A die face only reads when the pips are small
 * against the gaps between them, and six pixels is the least that buys here.
 */
const DIE_RADIUS_PX = 3;

/**
 * How far out the outermost sprite sits in the general arrangement, in world
 * pixels.
 *
 * **It grows with the count** here, where a die face's does not, and it has to:
 * the offsets are whole pixels, so a disc of a given radius holds a fixed number
 * of distinct positions and a large pile would simply run out of them. Square
 * root, because what is being covered is an area.
 *
 * The cap is what stops a heap becoming a field. Sprites already overhang their
 * own cell — a tile's art is as wide as the cell it stands on — so what this
 * bounds is how much *further* the outermost one reaches: half a cell, which
 * looks like a heap that has spread a bit, where a whole cell looked like
 * berries scattered over the three tiles around it.
 */
const SPREAD_PER_ROOT_PX = 1.5;
const MAX_PILE_RADIUS_PX = 4;

function discRadiusPx(count: number): number {
  return Math.min(
    MAX_PILE_RADIUS_PX,
    Math.max(1, Math.round(Math.sqrt(count) * SPREAD_PER_ROOT_PX)),
  );
}

/**
 * The six faces, in lattice units — a corner is 1, the middle is 0.
 *
 * Written the way they are read off a die: two is the diagonal pair, three is
 * the diagonal line through the middle, four is the corners, five is the corners
 * and the middle, six is the two full columns.
 */
const DIE_FACES: readonly (readonly (readonly [number, number])[])[] = [
  [[0, 0]],
  [
    [-1, -1],
    [1, 1],
  ],
  [
    [-1, -1],
    [0, 0],
    [1, 1],
  ],
  [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ],
  [
    [-1, -1],
    [1, -1],
    [0, 0],
    [-1, 1],
    [1, 1],
  ],
  [
    [-1, -1],
    [-1, 0],
    [-1, 1],
    [1, -1],
    [1, 0],
    [1, 1],
  ],
];

/**
 * Every whole-pixel offset inside a disc of this radius, in a fixed order.
 *
 * The order is what makes {@link spreadInDisc} reproducible: its greedy pass
 * takes the first of several equally distant candidates, and "first" has to mean
 * something. Back to front, then left to right — the order a person would read
 * them in, and the order the sprites end up drawn in.
 */
function discOffsets(radiusPx: number): PileOffset[] {
  const out: PileOffset[] = [];
  const limit = radiusPx * radiusPx;
  for (let dy = -radiusPx; dy <= radiusPx; dy++) {
    for (let dx = -radiusPx; dx <= radiusPx; dx++) {
      if (dx * dx + dy * dy <= limit) out.push({ dx, dy });
    }
  }
  return out;
}

/** Squared, because only the comparison matters and a root costs more. */
function gapSquared(a: PileOffset, b: PileOffset): number {
  const dx = a.dx - b.dx;
  const dy = a.dy - b.dy;
  return dx * dx + dy * dy;
}

/**
 * `count` of the given positions, spread as far apart as taking them one at a
 * time can manage.
 *
 * Farthest-first: start in the middle, then repeatedly take whichever position
 * is furthest from everything taken so far. It is not the optimal packing and
 * does not need to be — what it guarantees is the two things a heap needs, that
 * no two sprites land on one pixel and that they fill outwards rather than
 * clumping on one side.
 *
 * Quadratic in the candidate set, which is at most twenty-nine positions for the
 * widest disc here, and asked once per distinct count thanks to
 * {@link pileOffsets}' memo.
 */
function spreadInDisc(
  candidates: readonly PileOffset[],
  count: number,
): PileOffset[] {
  const taken: PileOffset[] = [];
  const left = [...candidates];

  // The middle first, so a heap has something at its centre — the one thing
  // every die face with an odd number of pips agrees about.
  const middle = left.findIndex((o) => o.dx === 0 && o.dy === 0);
  taken.push(...left.splice(middle === -1 ? 0 : middle, 1));

  while (taken.length < count && left.length > 0) {
    let best = 0;
    let bestGap = -1;
    for (let i = 0; i < left.length; i++) {
      let nearest = Number.POSITIVE_INFINITY;
      for (const chosen of taken) {
        nearest = Math.min(nearest, gapSquared(left[i]!, chosen));
      }
      if (nearest > bestGap) {
        bestGap = nearest;
        best = i;
      }
    }
    taken.push(...left.splice(best, 1));
  }
  return taken;
}

/** Back to front, then left to right — see {@link pileOffsets}' return order. */
function inDrawOrder(offsets: PileOffset[]): PileOffset[] {
  return offsets.sort((a, b) => a.dy - b.dy || a.dx - b.dx);
}

/**
 * Asked once per distinct count and then never again.
 *
 * Counts are small integers bounded by {@link MAX_PILE_SPRITES}, so this holds a
 * dozen entries for the life of the page — where the pass it replaces runs
 * inside the cell loop of a level rebuild, which is thousands of cells.
 */
const memo = new Map<number, readonly PileOffset[]>();

/**
 * Where each sprite of a pile of `count` goes, in world pixels from where a
 * single one would have been drawn.
 *
 * **Back to front**, so a caller can lean on the order: index 0 is the sprite
 * furthest up the screen and therefore furthest away, and each one after it is
 * nearer the camera. That is exactly the order they have to be depth-biased in
 * for a heap to overlap the way a heap does.
 *
 * A count of one — every tile in the world that is not a pile — comes back as
 * {@link NO_PILE_OFFSET}, so nothing that is not a pile moves by so much as a
 * pixel.
 */
export function pileOffsets(count: number): readonly PileOffset[] {
  if (count <= 1) return NO_PILE_OFFSET;
  const drawn = Math.min(count, MAX_PILE_SPRITES);

  const cached = memo.get(drawn);
  if (cached) return cached;

  const face = DIE_FACES[drawn - 1];
  const offsets = face
    ? face.map(([dx, dy]) => ({ dx: dx * DIE_RADIUS_PX, dy: dy * DIE_RADIUS_PX }))
    : spreadInDisc(discOffsets(discRadiusPx(drawn)), drawn);

  const ordered: readonly PileOffset[] = inDrawOrder(offsets);
  memo.set(drawn, ordered);
  return ordered;
}

/**
 * How much to lift one sprite of a pile above the one behind it, as a fraction
 * of a stack index.
 *
 * A pile's sprites share a cell, an elevation and a stack index, so every one of
 * them resolves to the same depth and two that overlap come down to whichever
 * fragment happens to win. This separates them, in the units
 * `../lib/geometry`'s `depthStackBias` already speaks: strictly inside one
 * index, so a heap sorts within itself and still sits exactly where its
 * placement does relative to everything else in the stack.
 */
export function pileDepthNudge(index: number, total: number): number {
  return total <= 1 ? 0 : (index + 1) / (total + 1);
}
