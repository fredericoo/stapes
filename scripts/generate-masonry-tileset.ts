import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { PX_PER_HEIGHT } from "../app/lib/geometry";
import { CELL_SIZE, type TileDef, type TileSprite } from "../app/lib/types";
import { paint, readJson, writeTileset } from "./tileset-output";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, "data");

const TILESET_ID = "masonry";
const FRAME_MS = 200;

const CELL = CELL_SIZE;
const HALF = CELL / 2;
const SPRITE_CELLS = 2;
const SPRITE_PX = SPRITE_CELLS * CELL;

const PILLAR_HEIGHT_UNITS = 2;
const PILLAR_RISE_PX = PILLAR_HEIGHT_UNITS * PX_PER_HEIGHT;

const FLOOR_BLOCK_CELLS = 4;
const FLOOR_SOURCE = { file: "floors.png", x: 0, y: 4 };
const FLOOR_SOURCE_TILE = "wooden-floor";
const FLOOR_ROW = SPRITE_CELLS;

const SHEET_COLS = 4 * FLOOR_BLOCK_CELLS;
const SHEET_ROWS = FLOOR_ROW + 2 * FLOOR_BLOCK_CELLS;

/** Samples per pixel along each axis; a pixel is drawn when most of its samples hit. */
const SUPERSAMPLE = 4;
const MARCH_STEP_PX = 1 / 64;

/** Palette indices. */
const WHITE = 28;
const PALE = 27;
const GREY = 25;
const DUSK = 22;
const PLUM = 8;
const INK = 4;

const SIDE_RAMP = [WHITE, PALE, GREY, DUSK];

type Shape = "disc" | "square";
/**
 * `jagged` replaces a flat top with heights sampled at even angles round the
 * centre, starting due east, for a shaft that has snapped.
 */
type Layer = { from: number; to: number; shape: Shape; radius: number; jagged?: number[] };
/**
 * A crack on the side is a line through `[degrees, height]`, the angle round
 * the centre measured from due east towards south; one on a top face is a line
 * through footprint pixels `[x, y]`.
 */
type Crack = { face: "side" | "top"; points: [number, number][] };
/** `below` and `above` say whether this segment stacks on, or under, another one's shaft. */
type Pillar = {
  tileId: string;
  name: string;
  layers: Layer[];
  below: boolean;
  above: boolean;
  cracks?: Crack[];
};

const SHAFT_RADIUS = 3.4;
const MOULDING_RADIUS = 3.8;
const SLAB_RADIUS = 4;

const BASE: Layer[] = [
  { from: 0, to: 1, shape: "square", radius: SLAB_RADIUS },
  { from: 1, to: 2, shape: "disc", radius: MOULDING_RADIUS },
  { from: 2, to: PILLAR_RISE_PX, shape: "disc", radius: SHAFT_RADIUS },
];
const SHAFT: Layer[] = [{ from: 0, to: PILLAR_RISE_PX, shape: "disc", radius: SHAFT_RADIUS }];
const CAPITAL: Layer[] = [
  { from: 0, to: 2, shape: "disc", radius: SHAFT_RADIUS },
  { from: 2, to: 3, shape: "disc", radius: MOULDING_RADIUS },
  { from: 3, to: PILLAR_RISE_PX, shape: "square", radius: SLAB_RADIUS },
];
const SNAPPED: Layer[] = [
  {
    from: 0,
    to: PILLAR_RISE_PX,
    shape: "disc",
    radius: SHAFT_RADIUS,
    jagged: [2.2, 1, 0.6, 1.4, 2.6, 3.9, 3.6, 3.2],
  },
];

/** Heights are in pixels above the bottom of the segment, which is four tall. */
const PILLARS: Pillar[] = [
  {
    tileId: "marble-pillar-bottom",
    name: "Marble pillar (bottom)",
    below: false,
    above: true,
    layers: BASE,
  },
  {
    tileId: "marble-pillar-middle",
    name: "Marble pillar (middle)",
    below: true,
    above: true,
    layers: SHAFT,
  },
  {
    tileId: "marble-pillar-top",
    name: "Marble pillar (top)",
    below: true,
    above: false,
    layers: CAPITAL,
  },
  {
    tileId: "marble-pillar-bottom-cracked",
    name: "Marble pillar (bottom, cracked)",
    below: false,
    above: true,
    layers: BASE,
    cracks: [
      {
        face: "side",
        points: [
          [95, 2.2],
          [80, 2.9],
          [90, 3.4],
          [70, 3.9],
        ],
      },
    ],
  },
  {
    tileId: "marble-pillar-middle-cracked",
    name: "Marble pillar (middle, cracked)",
    below: true,
    above: true,
    layers: SHAFT,
    cracks: [
      {
        face: "side",
        points: [
          [115, 0.3],
          [95, 1.3],
          [70, 2],
          [55, 3.1],
          [35, 3.8],
        ],
      },
    ],
  },
  {
    tileId: "marble-pillar-middle-cracked-2",
    name: "Marble pillar (middle, cracked 2)",
    below: true,
    above: true,
    layers: SHAFT,
    cracks: [
      {
        face: "side",
        points: [
          [130, 0.2],
          [110, 1],
          [120, 1.8],
        ],
      },
      {
        face: "side",
        points: [
          [60, 2.2],
          [75, 3],
          [65, 3.9],
        ],
      },
    ],
  },
  {
    tileId: "marble-pillar-top-cracked",
    name: "Marble pillar (top, cracked)",
    below: true,
    above: false,
    layers: CAPITAL,
    cracks: [
      {
        face: "side",
        points: [
          [70, 0.2],
          [85, 1],
          [65, 1.8],
        ],
      },
      {
        face: "top",
        points: [
          [1, 2],
          [3, 3],
          [4, 5],
          [6, 6],
        ],
      },
    ],
  },
  {
    tileId: "marble-pillar-broken",
    name: "Marble pillar (broken)",
    below: true,
    above: false,
    layers: SNAPPED,
    cracks: [
      {
        face: "side",
        points: [
          [60, 0.4],
          [75, 1.1],
        ],
      },
    ],
  },
];

/** Room for the shaft of the segment below, which is drawn down and to the right of this one. */
const CANVAS_PX = SPRITE_PX + PILLAR_RISE_PX;

type Vec3 = [number, number, number];
type Hit = { x: number; y: number; z: number; normal: Vec3; rough: boolean };
type Span = { top: number; bottom: number };

function normalise([x, y, z]: Vec3): Vec3 {
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

function distance(layer: Layer, x: number, y: number): number {
  const dx = x - HALF;
  const dy = y - HALF;
  if (layer.shape === "disc") return Math.hypot(dx, dy) - layer.radius;
  return Math.max(Math.abs(dx), Math.abs(dy)) - layer.radius;
}

function angleOf(x: number, y: number): number {
  return Math.atan2(y - HALF, x - HALF);
}

function topOf(layer: Layer, x: number, y: number): number {
  if (!layer.jagged) return layer.to;
  const at =
    ((angleOf(x, y) / (2 * Math.PI)) * layer.jagged.length + layer.jagged.length) %
    layer.jagged.length;
  const i = Math.floor(at);
  const next = layer.jagged[(i + 1) % layer.jagged.length]!;
  return layer.jagged[i]! + (next - layer.jagged[i]!) * (at - i);
}

function layerAt(layers: Layer[], x: number, y: number, z: number): Layer | undefined {
  return layers.find((l) => z >= l.from && z < topOf(l, x, y) && distance(l, x, y) <= 0);
}

function sideNormal(layer: Layer, x: number, y: number): Vec3 {
  const e = 1 / 128;
  const nx = distance(layer, x + e, y) - distance(layer, x - e, y);
  const ny = distance(layer, x, y + e) - distance(layer, x, y - e);
  return normalise([nx, ny, 0]);
}

/**
 * Walks the view ray down from the top of the span. A point at height `z` is
 * drawn `z` pixels up and to the left of where it stands, so the ray through
 * sprite pixel `u, v` meets footprint `u - 8 + z, v - 8 + z` at that height.
 * A hit with solid stone just above it was met through the side.
 */
function castRay(layers: Layer[], span: Span, u: number, v: number): Hit | null {
  for (let z = span.top - MARCH_STEP_PX / 2; z > span.bottom; z -= MARCH_STEP_PX) {
    const x = u - CELL + z;
    const y = v - CELL + z;
    const layer = layerAt(layers, x, y, z);
    if (!layer) continue;
    const covered = layerAt(layers, x, y, z + 2 * MARCH_STEP_PX) !== undefined;
    const normal: Vec3 = covered ? sideNormal(layer, x, y) : [0, 0, 1];
    return { x, y, z, normal, rough: !covered && layer.jagged !== undefined };
  }
  return null;
}

/**
 * Shades a side by where its normal points across the screen, from the
 * south-west edge of the column to the north-east one, so a curve gets even
 * bands rather than a lit face and a dark one. A square face lands on the
 * convention every block here keeps: the south face lit and the east one dark.
 */
/** A snapped end is shaded by how far down it broke, so the break reads as rubble and not as a lid. */
function roughTone(z: number): number {
  if (z > 2.8) return PALE;
  return z > 1.2 ? GREY : DUSK;
}

function shade({ normal, rough, z }: Hit): number {
  if (normal[2] > 0.5) return rough ? roughTone(z) : PALE;
  const across = (normal[0] - normal[1]) / Math.SQRT2;
  return SIDE_RAMP[
    Math.min(SIDE_RAMP.length - 1, Math.floor(((across + 1) / 2) * SIDE_RAMP.length))
  ]!;
}

/** A crack is dusk through stone and ink through the stone that is already dusk. */
const CRACKED: Record<number, number> = { [WHITE]: DUSK, [PALE]: DUSK, [GREY]: DUSK, [DUSK]: INK };
const CRACK_HALF_WIDTH_PX = 0.45;
/** A crack is thinner than a pixel, so a pixel takes it when this share of its samples land on one. */
const CRACK_SHARE = 0.25;

function distanceToLine(points: [number, number][], px: number, py: number): number {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]!;
    const [bx, by] = points[i]!;
    const t = Math.max(
      0,
      Math.min(
        1,
        ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2),
      ),
    );
    best = Math.min(best, Math.hypot(px - ax - t * (bx - ax), py - ay - t * (by - ay)));
  }
  return best;
}

/** Side cracks are measured along the surface, so a degree is as long as it is round the shaft. */
function onCrack(cracks: Crack[], hit: Hit): boolean {
  const top = hit.normal[2] > 0.5;
  return cracks.some((crack) => {
    if ((crack.face === "top") !== top) return false;
    if (top) return distanceToLine(crack.points, hit.x, hit.y) <= CRACK_HALF_WIDTH_PX;
    const toArc = (degrees: number) => (degrees * Math.PI * SHAFT_RADIUS) / 180;
    const line = crack.points.map(([degrees, z]): [number, number] => [toArc(degrees), z]);
    return distanceToLine(line, SHAFT_RADIUS * angleOf(hit.x, hit.y), hit.z) <= CRACK_HALF_WIDTH_PX;
  });
}

type Owner = "below" | "own" | "above";
type Pixel = { index: number; z: number; owner: Owner } | null;

function ownerOf(z: number): Owner {
  if (z < 0) return "below";
  return z < PILLAR_RISE_PX ? "own" : "above";
}

function shaftOutside(from: number, to: number): Layer {
  return { from, to, shape: "disc", radius: SHAFT_RADIUS };
}

/**
 * Draws the segment as part of a column first, with the shafts it joins carried
 * on above and below it, and keeps the pixels whose stone is its own. That is
 * what makes a column seamless: every segment cuts its pixels out of the same
 * picture. The cap the next segment would cover comes from the segment drawn
 * alone, so a column that stops there still has a top.
 */
function renderPillar(pillar: Pillar): Pixel[][] {
  const layers = [...pillar.layers];
  if (pillar.below) layers.push(shaftOutside(-PILLAR_RISE_PX, 0));
  if (pillar.above) layers.push(shaftOutside(PILLAR_RISE_PX, 2 * PILLAR_RISE_PX));
  const cracks = pillar.cracks ?? [];
  const inColumn = outline(
    render(layers, cracks, {
      top: pillar.above ? 2 * PILLAR_RISE_PX : PILLAR_RISE_PX,
      bottom: pillar.below ? -PILLAR_RISE_PX : 0,
    }),
  );
  const alone = outline(render(pillar.layers, cracks, { top: PILLAR_RISE_PX, bottom: 0 }));
  return inColumn.slice(0, SPRITE_PX).map((row, v) =>
    row.slice(0, SPRITE_PX).map((pixel, u) => {
      if (pixel?.owner === "own") return pixel;
      return pixel?.owner === "below" ? null : alone[v]![u]!;
    }),
  );
}

function render(layers: Layer[], cracks: Crack[], span: Span): Pixel[][] {
  return Array.from({ length: CANVAS_PX }, (_, v) =>
    Array.from({ length: CANVAS_PX }, (_, u) => samplePixel(layers, cracks, span, u, v)),
  );
}

/**
 * The colour is the one most samples agree on, so an edge does not take a stray
 * tone, and the pixel belongs to whichever segment most of its samples hit.
 */
function samplePixel(layers: Layer[], cracks: Crack[], span: Span, u: number, v: number): Pixel {
  const votes = new Map<number, number>();
  const owners = new Map<Owner, number>();
  let hits = 0;
  let cracked = 0;
  let z = 0;
  for (let j = 0; j < SUPERSAMPLE; j++) {
    for (let i = 0; i < SUPERSAMPLE; i++) {
      const hit = castRay(layers, span, u + (i + 0.5) / SUPERSAMPLE, v + (j + 0.5) / SUPERSAMPLE);
      if (!hit) continue;
      hits++;
      z += hit.z;
      if (hit.z >= 0 && hit.z < PILLAR_RISE_PX && onCrack(cracks, hit)) cracked++;
      const index = shade(hit);
      votes.set(index, (votes.get(index) ?? 0) + 1);
      owners.set(ownerOf(hit.z), (owners.get(ownerOf(hit.z)) ?? 0) + 1);
    }
  }
  if (hits * 2 < SUPERSAMPLE * SUPERSAMPLE) return null;
  const index = mostVoted(votes);
  return {
    index: cracked >= hits * CRACK_SHARE ? (CRACKED[index] ?? index) : index,
    z: z / hits,
    owner: mostVoted(owners),
  };
}

function mostVoted<T>(votes: Map<T, number>): T {
  return [...votes].sort((a, b) => b[1] - a[1])[0]![0];
}

const BOTTOM_EDGE_PX = 0.75;

/**
 * Darkens the silhouette: ink on the shaded north-east side and the ground line,
 * a dusk tone on the lit south-west side.
 */
function outline(grid: Pixel[][]): Pixel[][] {
  const empty = (u: number, v: number) => !grid[v]?.[u];
  return grid.map((row, v) =>
    row.map((pixel, u) => {
      if (!pixel) return null;
      if (empty(u + 1, v) || empty(u, v - 1)) return { ...pixel, index: INK };
      if (empty(u, v + 1)) return { ...pixel, index: pixel.z < BOTTOM_EDGE_PX ? INK : DUSK };
      if (empty(u - 1, v)) return { ...pixel, index: DUSK };
      return pixel;
    }),
  );
}

type FloorPattern = { tileId: string; name: string; joints: string[]; face: number; joint: number };

/**
 * One cell of each floor, eight by eight, and it repeats across cell edges. `#`
 * is a joint between stones. The joints are broken and one palette step from
 * the stone so the floor stays quiet under whatever stands on it.
 */
const FLOORS: FloorPattern[] = [
  {
    tileId: "flagstone-floor",
    name: "Flagstone floor",
    face: GREY,
    joint: DUSK,
    joints: [
      ".......#",
      ".......#",
      "........",
      "........",
      "........",
      ".......#",
      "........",
      "###..##.",
    ],
  },
  {
    tileId: "slate-floor",
    name: "Slate floor",
    face: DUSK,
    joint: PLUM,
    joints: [
      ".......#",
      "........",
      "........",
      "##.###..",
      "...#....",
      "........",
      "........",
      ".###..##",
    ],
  },
];

function alphaAt(png: PNG, x: number, y: number): number {
  return png.data[((png.width * y + x) << 2) + 3]!;
}

/**
 * The wooden floor's sheet decides which pixels of each slice are floor, so the
 * stone floors cut away under a half wall exactly where the wood does. The
 * inner block is the complement of the outer one, as the wood's is.
 */
function drawFloor(
  sheet: PNG,
  wood: PNG,
  pattern: FloorPattern,
  origin: { x: number; y: number },
  inner: boolean,
) {
  const span = FLOOR_BLOCK_CELLS * CELL;
  for (let py = 0; py < span; py++) {
    for (let px = 0; px < span; px++) {
      const solid = alphaAt(wood, FLOOR_SOURCE.x * CELL + px, FLOOR_SOURCE.y * CELL + py) > 0;
      if (solid === inner) continue;
      paint(
        sheet,
        origin.x * CELL + px,
        origin.y * CELL + py,
        pattern.joints[py % CELL]![px % CELL] === "#" ? pattern.joint : pattern.face,
      );
    }
  }
}

function pillarTile(pillar: Pillar, column: number): TileDef {
  const sprite: TileSprite = {
    frames: [
      {
        sprite: { rect: { x: 0, y: 0, w: SPRITE_CELLS, h: SPRITE_CELLS }, base: { x: 1, y: 1 } },
        durationMs: FRAME_MS,
      },
    ],
  };
  return {
    id: pillar.tileId,
    name: pillar.name,
    height: PILLAR_HEIGHT_UNITS,
    type: "simple",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET_ID, x: column * SPRITE_CELLS, y: 0 },
    walkable: false,
    sprite,
  };
}

function floorTiles(pattern: FloorPattern, wood: TileDef, column: number): TileDef[] {
  const outer: TileDef = {
    id: pattern.tileId,
    name: pattern.name,
    height: 0,
    type: "autotile",
    kind: "prop",
    attributes: {},
    anchor: { tilesetId: TILESET_ID, x: column, y: FLOOR_ROW },
    connectsTo: ["hole"],
    slices: wood.slices,
  };
  const inner: TileDef = {
    ...outer,
    id: `${pattern.tileId}-inner`,
    name: `${pattern.name} (inner)`,
    anchor: { tilesetId: TILESET_ID, x: column, y: FLOOR_ROW + FLOOR_BLOCK_CELLS },
    intangible: true,
    connectsTo: [pattern.tileId],
  };
  return [outer, inner];
}

async function main() {
  const sheet = new PNG({ width: SHEET_COLS * CELL, height: SHEET_ROWS * CELL });
  sheet.data.fill(0);

  const tiles = await readJson<TileDef[]>(path.join(DATA, "tiles.json"));
  const generated: TileDef[] = [];

  PILLARS.forEach((pillar, column) => {
    const pixels = renderPillar(pillar);
    pixels.forEach((row, v) =>
      row.forEach((pixel, u) => {
        if (pixel) paint(sheet, column * SPRITE_PX + u, v, pixel.index);
      }),
    );
    generated.push(pillarTile(pillar, column));
  });

  const wood = PNG.sync.read(await fs.readFile(path.join(DATA, "tilesets", FLOOR_SOURCE.file)));
  const woodTile = tiles.find((t) => t.id === FLOOR_SOURCE_TILE);
  if (!woodTile?.slices) throw new Error(`${FLOOR_SOURCE_TILE} has no slices to copy`);
  FLOORS.forEach((pattern, i) => {
    const column = i * FLOOR_BLOCK_CELLS;
    drawFloor(sheet, wood, pattern, { x: column, y: FLOOR_ROW }, false);
    drawFloor(sheet, wood, pattern, { x: column, y: FLOOR_ROW + FLOOR_BLOCK_CELLS }, true);
    generated.push(...floorTiles(pattern, woodTile, column));
  });

  await writeTileset(TILESET_ID, "Masonry", sheet, generated);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
