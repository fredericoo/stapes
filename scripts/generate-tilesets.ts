/**
 * Generates placeholder tilesets and seed data for the Stapes editor.
 * Run: pnpm generate
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import type { FlatMapFile, PlacedTile, TilesetDef } from "../app/lib/types";
import { normalizeTiles } from "../app/lib/types";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, "data");
const TILESETS = path.join(DATA, "tilesets");

function setPixel(
  png: PNG,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a = 255,
) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const i = (png.width * y + x) << 2;
  png.data[i] = r;
  png.data[i + 1] = g;
  png.data[i + 2] = b;
  png.data[i + 3] = a;
}

function fillRect(
  png: PNG,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
  a = 255,
) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      setPixel(png, xx, yy, r, g, b, a);
    }
  }
}

function drawCellBorder(
  png: PNG,
  cx: number,
  cy: number,
  r: number,
  g: number,
  b: number,
) {
  const x = cx * 8;
  const y = cy * 8;
  for (let i = 0; i < 8; i++) {
    setPixel(png, x + i, y, r, g, b);
    setPixel(png, x + i, y + 7, r, g, b);
    setPixel(png, x, y + i, r, g, b);
    setPixel(png, x + 7, y + i, r, g, b);
  }
}

async function main() {
  await fs.mkdir(TILESETS, { recursive: true });

  // Layout (cells): 16 wide x 8 tall = 128x64 png
  // Row 0: grass, dirt, water0, water1, water2, halfstone, wall, empty
  // Row 1: tree TL, tree TR  |  (tree is 2x2 starting at 0,1)
  // Row 2: tree BL, tree BR
  // Row 3: torch N0, N1, E0, E1, S0, S1, W0, W1
  const png = new PNG({ width: 128, height: 64 });
  fillRect(png, 0, 0, 128, 64, 0, 0, 0, 0);

  // grass (0,0)
  fillRect(png, 0, 0, 8, 8, 74, 148, 60);
  for (let i = 0; i < 6; i++) {
    setPixel(png, 1 + (i % 3) * 2, 2 + Math.floor(i / 3) * 3, 56, 120, 44);
  }

  // dirt (1,0)
  fillRect(png, 8, 0, 8, 8, 140, 98, 56);
  setPixel(png, 10, 2, 110, 70, 40);
  setPixel(png, 13, 5, 110, 70, 40);

  // water frames (2,0) (3,0) (4,0)
  const waters = [
    [40, 90, 180],
    [50, 110, 200],
    [35, 80, 170],
  ] as const;
  waters.forEach(([r, g, b], i) => {
    const x = (2 + i) * 8;
    fillRect(png, x, 0, 8, 8, r, g, b);
    setPixel(png, x + 2, 2 + i, 180, 220, 255);
    setPixel(png, x + 5, 5 - (i % 2), 180, 220, 255);
  });

  // half stone (5,0) — lower half filled to suggest height 1
  fillRect(png, 40, 0, 8, 8, 0, 0, 0, 0);
  fillRect(png, 40, 4, 8, 4, 150, 150, 155);
  fillRect(png, 40, 4, 8, 1, 190, 190, 195);

  // wall (6,0)
  fillRect(png, 48, 0, 8, 8, 120, 120, 128);
  fillRect(png, 48, 0, 8, 2, 160, 160, 168);
  fillRect(png, 48, 6, 8, 2, 80, 80, 88);
  drawCellBorder(png, 6, 0, 60, 60, 70);

  // tree 2x2 at (0,1)
  // canopy
  fillRect(png, 0, 8, 16, 12, 34, 110, 40);
  fillRect(png, 2, 9, 12, 8, 48, 140, 55);
  // trunk on bottom-right cell (base)
  fillRect(png, 11, 18, 3, 6, 110, 70, 30);
  fillRect(png, 8, 16, 8, 2, 34, 110, 40);

  // torches row 3: N0 N1 E0 E1 S0 S1 W0 W1
  // Simple flame + bracket oriented by direction
  function drawTorch(
    cx: number,
    flameBright: boolean,
    dir: "n" | "e" | "s" | "w",
  ) {
    const ox = cx * 8;
    const oy = 24;
    fillRect(png, ox, oy, 8, 8, 0, 0, 0, 0);
    const fr = flameBright ? 255 : 220;
    const fg = flameBright ? 180 : 120;
    const fb = 40;
    // bracket against a wall side
    if (dir === "n") {
      fillRect(png, ox + 3, oy + 5, 2, 2, 90, 90, 100);
      fillRect(png, ox + 2, oy + 2, 4, 3, fr, fg, fb);
    } else if (dir === "s") {
      fillRect(png, ox + 3, oy + 1, 2, 2, 90, 90, 100);
      fillRect(png, ox + 2, oy + 3, 4, 3, fr, fg, fb);
    } else if (dir === "e") {
      fillRect(png, ox + 1, oy + 3, 2, 2, 90, 90, 100);
      fillRect(png, ox + 3, oy + 2, 3, 4, fr, fg, fb);
    } else {
      fillRect(png, ox + 5, oy + 3, 2, 2, 90, 90, 100);
      fillRect(png, ox + 2, oy + 2, 3, 4, fr, fg, fb);
    }
    setPixel(png, ox + 3, oy + 3, 255, 255, 200);
  }

  const dirs = ["n", "e", "s", "w"] as const;
  dirs.forEach((d, di) => {
    drawTorch(di * 2, true, d);
    drawTorch(di * 2 + 1, false, d);
  });

  const pngPath = path.join(TILESETS, "basic.png");
  const buffer = PNG.sync.write(png);
  await fs.writeFile(pngPath, buffer);

  const tilesets: TilesetDef[] = [
    {
      id: "basic",
      name: "Basic",
      file: "basic.png",
      width: 128,
      height: 64,
    },
  ];

  const cell = (
    x: number,
    y: number,
    w = 1,
    h = 1,
    baseX = w - 1,
    baseY = h - 1,
  ) => ({
    tilesetId: "basic",
    rect: { x, y, w, h },
    base: { x: baseX, y: baseY },
  });

  const tiles = normalizeTiles([
    {
      id: "grass",
      name: "Grass",
      height: 0,
      directional: false,
      variants: {
        default: [{ sprite: cell(0, 0), durationMs: 200 }],
      },
      attributes: {},
    },
    {
      id: "dirt",
      name: "Dirt",
      height: 0,
      directional: false,
      variants: {
        default: [{ sprite: cell(1, 0), durationMs: 200 }],
      },
      attributes: {},
    },
    {
      id: "water",
      name: "Water",
      height: 0,
      directional: false,
      variants: {
        default: [
          { sprite: cell(2, 0), durationMs: 280 },
          { sprite: cell(3, 0), durationMs: 280 },
          { sprite: cell(4, 0), durationMs: 280 },
        ],
      },
      attributes: {},
    },
    {
      id: "half-stone",
      name: "Half Stone",
      height: 1,
      directional: false,
      variants: {
        default: [{ sprite: cell(5, 0), durationMs: 200 }],
      },
      attributes: {},
    },
    {
      id: "stone-wall",
      name: "Stone Wall",
      height: 2,
      directional: false,
      variants: {
        default: [{ sprite: cell(6, 0), durationMs: 200 }],
      },
      attributes: {},
    },
    {
      id: "tree",
      name: "Tree",
      height: 2,
      directional: false,
      variants: {
        default: [{ sprite: cell(0, 1, 2, 2, 1, 1), durationMs: 200 }],
      },
      attributes: {},
    },
    {
      id: "torch",
      name: "Wall Torch",
      height: 0,
      directional: true,
      variants: {
        n: [
          { sprite: cell(0, 3), durationMs: 180 },
          { sprite: cell(1, 3), durationMs: 180 },
        ],
        e: [
          { sprite: cell(2, 3), durationMs: 180 },
          { sprite: cell(3, 3), durationMs: 180 },
        ],
        s: [
          { sprite: cell(4, 3), durationMs: 180 },
          { sprite: cell(5, 3), durationMs: 180 },
        ],
        w: [
          { sprite: cell(6, 3), durationMs: 180 },
          { sprite: cell(7, 3), durationMs: 180 },
        ],
      },
      attributes: {},
    },
  ] as unknown[]);

  // Built flat, then grouped — same shape the file on disk uses.
  const map: FlatMapFile = { version: 1, levels: {} };

  const put = (z: number, x: number, y: number, stack: PlacedTile[]) => {
    const zk = String(z);
    if (!map.levels[zk]) map.levels[zk] = {};
    map.levels[zk]![`${x},${y}`] = stack;
  };

  // Grass field 0..7 x 0..7
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      put(0, x, y, [{ tileId: "grass" }]);
    }
  }

  // Water pond
  for (const [x, y] of [
    [2, 2],
    [3, 2],
    [2, 3],
    [3, 3],
  ] as const) {
    put(0, x, y, [{ tileId: "water" }]);
  }

  // Tree
  put(0, 5, 5, [{ tileId: "grass" }, { tileId: "tree" }]);

  // Wall enclosure with torches
  for (let x = 1; x <= 4; x++) {
    put(0, x, 6, [{ tileId: "grass" }, { tileId: "stone-wall" }]);
  }
  put(0, 1, 5, [{ tileId: "grass" }, { tileId: "stone-wall" }]);
  put(0, 4, 5, [{ tileId: "grass" }, { tileId: "stone-wall" }]);
  put(0, 2, 5, [
    { tileId: "grass" },
    { tileId: "stone-wall" },
    { tileId: "torch", direction: "s" },
  ]);
  put(0, 3, 5, [{ tileId: "grass" }, { tileId: "half-stone" }]);

  // Upper floor sample
  put(1, 2, 5, [{ tileId: "dirt" }]);
  put(1, 3, 5, [{ tileId: "dirt" }]);

  // Cave sample
  put(-1, 2, 2, [{ tileId: "dirt" }]);
  put(-1, 3, 2, [{ tileId: "dirt" }, { tileId: "half-stone" }]);

  await fs.writeFile(
    path.join(DATA, "tilesets.json"),
    `${JSON.stringify(tilesets, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(DATA, "tiles.json"),
    `${JSON.stringify(tiles, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(DATA, "map.json"),
    `${JSON.stringify(map, null, 2)}\n`,
  );

  console.log(
    "Generated data/tilesets/basic.png, tilesets.json, tiles.json, map.json",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
