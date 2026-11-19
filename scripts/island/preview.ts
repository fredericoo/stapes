import { PNG } from "pngjs";
import { Ground, type Island } from "./terrain";

const COLOURS: Record<number, [number, number, number]> = {
  [Ground.DeepSea]: [46, 84, 112],
  [Ground.Shallows]: [86, 140, 160],
  [Ground.Beach]: [226, 210, 160],
  [Ground.Grass]: [128, 168, 88],
  [Ground.Woods]: [78, 128, 64],
  [Ground.DeepWoods]: [44, 88, 48],
  [Ground.Bog]: [62, 96, 84],
  [Ground.Lake]: [70, 130, 170],
  [Ground.River]: [74, 140, 186],
  [Ground.Snow]: [240, 244, 248],
  [Ground.Rock]: [140, 136, 128],
  [Ground.Desert]: [212, 170, 112],
  [Ground.Basalt]: [96, 74, 66],
  [Ground.Lava]: [222, 84, 34],
};

/**
 * Draws the island top-down, `zoom` pixels a cell. Higher ground is lighter,
 * and a cliff (a step down to the south or east) is shaded, so terraces read
 * as they will from the game's camera.
 */
export function renderIsland(island: Island, zoom: number): PNG {
  const { width: w, height: h, level, ground, road } = island;
  const png = new PNG({ width: w * zoom, height: h * zoom });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let [r, g, b] = level[i]! < 0 ? [30, 52, 72] : COLOURS[ground[i]!]!;
      const l = Math.max(0, level[i]!);
      const lift = 1 + 0.05 * l;
      r *= lift;
      g *= lift;
      b *= lift;
      const south = y + 1 < h ? level[i + w]! : l;
      const east = x + 1 < w ? level[i + 1]! : l;
      const north = y > 0 ? level[i - w]! : l;
      if (south < l || east < l) {
        r *= 0.62;
        g *= 0.62;
        b *= 0.62;
      } else if (north > l) {
        r *= 0.85;
        g *= 0.85;
        b *= 0.85;
      }
      const nearRoad = road[i] || (x + 1 < w && road[i + 1]) || (y + 1 < h && road[i + w]);
      if (road[i]) [r, g, b] = ground[i] === Ground.River ? [120, 80, 50] : [120, 84, 52];
      else if (nearRoad && zoom < 3) [r, g, b] = [150, 112, 72];
      for (let dy = 0; dy < zoom; dy++) {
        for (let dx = 0; dx < zoom; dx++) {
          const o = ((y * zoom + dy) * w * zoom + x * zoom + dx) * 4;
          png.data[o] = Math.min(255, r);
          png.data[o + 1] = Math.min(255, g);
          png.data[o + 2] = Math.min(255, b);
          png.data[o + 3] = 255;
        }
      }
    }
  }
  return png;
}

/** Cells the map file would hold: a filled column per raised cell, plus the sea ring. */
export function countLevelCells(island: Island): { surface: number; perLevel: number[] } {
  const perLevel: number[] = [];
  let surface = 0;
  for (let i = 0; i < island.level.length; i++) {
    const l = island.level[i]!;
    if (l < 0) continue;
    for (let z = 0; z <= l; z++) perLevel[z] = (perLevel[z] ?? 0) + 1;
    surface += l + 1;
  }
  return { surface, perLevel };
}
