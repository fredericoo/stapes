export type PileOffset = { dx: number; dy: number };

export const NO_PILE_OFFSET: readonly PileOffset[] = [{ dx: 0, dy: 0 }];

export const MAX_PILE_SPRITES = 12;

const DIE_RADIUS_PX = 3;

const SPREAD_PER_ROOT_PX = 1.5;
const MAX_PILE_RADIUS_PX = 4;

function discRadiusPx(count: number): number {
  return Math.min(
    MAX_PILE_RADIUS_PX,
    Math.max(1, Math.round(Math.sqrt(count) * SPREAD_PER_ROOT_PX)),
  );
}

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

function gapSquared(a: PileOffset, b: PileOffset): number {
  const dx = a.dx - b.dx;
  const dy = a.dy - b.dy;
  return dx * dx + dy * dy;
}

function spreadInDisc(candidates: readonly PileOffset[], count: number): PileOffset[] {
  const taken: PileOffset[] = [];
  const left = [...candidates];

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

function inDrawOrder(offsets: PileOffset[]): PileOffset[] {
  return offsets.sort((a, b) => a.dy - b.dy || a.dx - b.dx);
}

const memo = new Map<number, readonly PileOffset[]>();

/**
 * Depends only on `count`, the one thing every client knows about a pile. Any
 * randomness would draw the same pile differently on each client.
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

export function pileDepthNudge(index: number, total: number): number {
  return total <= 1 ? 0 : (index + 1) / (total + 1);
}

export function pileRings(
  count: number,
): readonly { at: PileOffset; peers: readonly PileOffset[] }[] {
  const cached = ringMemo.get(Math.min(Math.max(count, 1), MAX_PILE_SPRITES));
  if (cached) return cached;

  const offsets = pileOffsets(count);
  const rings = offsets.map((at) => ({
    at,
    peers: offsets
      .filter((other) => other !== at)
      .map((other) => ({ dx: at.dx - other.dx, dy: at.dy - other.dy })),
  }));

  ringMemo.set(offsets.length, rings);
  return rings;
}

const ringMemo = new Map<number, readonly { at: PileOffset; peers: readonly PileOffset[] }[]>();
