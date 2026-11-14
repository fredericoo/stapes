import { canWalk, listStandingSurfaces } from "../game/movement";
import { reachableCells } from "../game/navigation";
import { findPlayers } from "../game/player";
import { isSkyExposed, stackOcclusion } from "../lib/lighting";
import { computeLightingFlood } from "../lib/lightingFlood";
import { getStack, listCoords, presentLevels, removeTileAt, replaceStack } from "../lib/mapData";
import {
  coordKey,
  HEIGHT_PER_LEVEL,
  MAX_LIGHT_LEVEL,
  type Direction,
  type MapFile,
  type PlacedTile,
  type TileDef,
} from "../lib/types";
import { fitsHeightAtElevation } from "../lib/validation";

export type CaveProblemKind =
  | "open-sky"
  | "daylight"
  | "no-headroom"
  | "unreachable"
  | "walled-in"
  | "ramp-not-stood-on"
  | "ramp-climbs-nowhere"
  | "ramp-unreachable"
  | "no-approach";

export type CaveProblem = {
  kind: CaveProblemKind;
  x: number;
  y: number;
  z: number;
  message: string;
};

type Cell = { x: number; y: number };

export type CaveCheckInput = {
  map: MapFile;
  tilesById: Record<string, TileDef>;
  levels: readonly number[];
  mouth: Cell;
  mouthDescent: Direction;
  /** Cells open to the sky on purpose, the mouth among them; light near them is expected. */
  openings: readonly Cell[];
  /** `x,y,z` of the cells a carve just wrote; every dirt cell on `levels` when absent. */
  carved?: ReadonlySet<string>;
};

export type CaveReport = {
  problems: CaveProblem[];
  cells: number;
  walked: Record<string, number>;
  daylit: { count: number; brightest: number; at: string };
};

/** Sky light at or under this reads as a glow through a crack; above it, as a hole in the roof. */
export const DIM_ENOUGH = 64;

const ROCK_TILES = new Set(["half-stone", "cave-wall-sloped", "cave-wall-sloped-grey"]);
const isRock = (stack: readonly PlacedTile[]) => stack.some((t) => ROCK_TILES.has(t.tileId));

const STEP: Record<Direction, Cell> = {
  n: { x: 0, y: -1 },
  e: { x: 1, y: 0 },
  s: { x: 0, y: 1 },
  w: { x: -1, y: 0 },
};
const DIRS: Direction[] = ["n", "e", "s", "w"];

const chebyshev = (a: Cell, b: Cell) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const where = (x: number, y: number, z: number) => `${x},${y} L${z}`;

export function checkCaves(input: CaveCheckInput): CaveReport {
  const { tilesById, levels, mouth, mouthDescent, openings, carved } = input;
  const problems: CaveProblem[] = [];
  const problem = (kind: CaveProblemKind, x: number, y: number, z: number, message: string) =>
    problems.push({ kind, x, y, z, message });
  let live = input.map;
  const playerDef = tilesById["player"]!;

  const denCells = new Set<string>();
  const bodies: Array<{ x: number; y: number; z: number; def: TileDef }> = [];
  for (const z of levels) {
    for (const { x, y, stack } of listCoords(live, z)) {
      if (isRock(stack)) continue;
      if (!stack.some((p) => p.tileId === "dirt")) continue;
      if (carved && !carved.has(`${x},${y},${z}`)) continue;
      denCells.add(`${x},${y},${z}`);
      for (const placed of stack) {
        const def = tilesById[placed.tileId];
        if (def?.kind === "battler") bodies.push({ x, y, z, def });
      }
    }
  }
  const cellsOf = () =>
    [...denCells].map((cell) => cell.split(",").map(Number) as [number, number, number]);

  const occlusion = new Map<string, ReturnType<typeof stackOcclusion>>();
  for (const z of presentLevels(live)) {
    for (const { x, y, stack } of listCoords(live, z)) {
      occlusion.set(`${z}:${coordKey(x, y)}`, stackOcclusion(stack, tilesById));
    }
  }
  for (const [x, y, z] of cellsOf()) {
    if (!isSkyExposed(x, y, z, occlusion)) continue;
    if (openings.some((o) => o.x === x && o.y === y)) continue;
    problem("open-sky", x, y, z, `open sky over ${where(x, y, z)}`);
  }

  /**
   * Light within reach of a cell the sky can see is that cell's light, and the
   * cell is either an opening or already reported as open sky. What is left is
   * light through something that only partly covers the sky.
   */
  const skyHoles = new Map<number, Cell[]>();
  for (const z of levels) {
    const holes: Cell[] = openings.map(({ x, y }) => ({ x, y }));
    for (const { x, y } of listCoords(live, z)) {
      if (isSkyExposed(x, y, z, occlusion)) holes.push({ x, y });
    }
    skyHoles.set(z, holes);
  }

  const flood = computeLightingFlood(live, tilesById);
  const daylit = { count: 0, brightest: 0, at: "" };
  for (const [x, y, z] of cellsOf()) {
    if (skyHoles.get(z)!.some((o) => chebyshev(o, { x, y }) <= MAX_LIGHT_LEVEL)) continue;
    const lv = flood.levels.get(z);
    if (!lv) continue;
    const lx = x - lv.x0;
    const ly = y - lv.y0;
    if (lx < 0 || ly < 0 || lx >= lv.w || ly >= lv.h) continue;
    const sky = lv.sky[ly * lv.w + lx]!;
    if (sky === 0) continue;
    daylit.count++;
    if (sky > daylit.brightest) Object.assign(daylit, { brightest: sky, at: where(x, y, z) });
    if (sky > DIM_ENOUGH) {
      problem(
        "daylight",
        x,
        y,
        z,
        `daylight reaches ${where(x, y, z)} at ${sky}/255, which is a hole rather than a glow`,
      );
    }
  }

  for (const body of bodies) {
    const room = fitsHeightAtElevation(
      live,
      body.x,
      body.y,
      body.z * HEIGHT_PER_LEVEL,
      body.def.height,
      tilesById,
      { throughPlayers: true },
    );
    if (!room.ok && room.reason?.includes("ceiling")) {
      problem(
        "no-headroom",
        body.x,
        body.y,
        body.z,
        `${body.def.id} at ${where(body.x, body.y, body.z)} has no headroom`,
      );
    }
  }

  const spawns = findPlayers(live);
  for (const spawn of spawns) {
    live = removeTileAt(live, spawn.x, spawn.y, spawn.z, spawn.stackIndex);
  }
  for (const z of levels) {
    for (const { x, y, stack } of listCoords(live, z)) {
      const kept = stack.filter((p) => tilesById[p.tileId]?.kind !== "battler");
      if (kept.length === stack.length) continue;
      live = replaceStack(live, x, y, z, kept);
    }
  }

  const settle = (x: number, y: number, feetAbs: number) => {
    const surfaces = listStandingSurfaces(live, x, y, tilesById);
    return (
      surfaces.find((s) => s.abs === feetAbs) ??
      surfaces.filter((s) => s.abs < feetAbs).sort((a, b) => b.abs - a.abs)[0] ??
      null
    );
  };
  const feetAt = (x: number, y: number, z: number) =>
    listStandingSurfaces(live, x, y, tilesById).find((s) => s.z === z)?.abs ?? z * HEIGHT_PER_LEVEL;

  const report = (walked: Record<string, number>): CaveReport => ({
    problems,
    cells: denCells.size,
    walked,
    daylit,
  });

  const approach = { x: mouth.x - STEP[mouthDescent].x, y: mouth.y - STEP[mouthDescent].y };
  const start = settle(approach.x, approach.y, 0);
  if (!start) {
    problem(
      "no-approach",
      approach.x,
      approach.y,
      0,
      "nowhere to stand on the approach to the mouth",
    );
    return report({});
  }

  const starts = [{ ...approach, z: start.z }, ...spawns.map(({ x, y, z }) => ({ x, y, z }))];
  const world = { board: live, traveller: playerDef, tilesById, statusDefs: {} };
  const seen = new Set<string>();
  for (const { x, y, z } of reachableCells(world, starts).values()) seen.add(`${x},${y},${z}`);

  /**
   * Only a cell a body can stand in has to be reachable. A wall, or a barrel
   * or crate under a floor, is a dirt cell nobody stands in, not one nobody
   * can reach.
   */
  const standable = (x: number, y: number, z: number) =>
    listStandingSurfaces(live, x, y, tilesById).some(
      (s) =>
        s.z === z &&
        fitsHeightAtElevation(live, x, y, s.abs, playerDef.height, tilesById, {
          throughPlayers: true,
        }).ok,
    );
  for (const [x, y, z] of cellsOf()) {
    if (seen.has(`${x},${y},${z}`) || !standable(x, y, z)) continue;
    problem("unreachable", x, y, z, `carved cell ${where(x, y, z)} cannot be walked to`);
  }

  for (const body of bodies) {
    if (seen.has(`${body.x},${body.y},${body.z}`)) continue;
    problem(
      "walled-in",
      body.x,
      body.y,
      body.z,
      `${body.def.id} at ${where(body.x, body.y, body.z)} is walled in`,
    );
  }

  for (const z of levels) {
    for (const { x, y, stack } of listCoords(live, z)) {
      if (!stack.some((p) => p.tileId === "ramp")) continue;
      const onRamp = settle(x, y, z * HEIGHT_PER_LEVEL + 2);
      if (!onRamp || onRamp.abs !== z * HEIGHT_PER_LEVEL + 2) {
        problem("ramp-not-stood-on", x, y, z, `ramp at ${where(x, y, z)} is not stood on`);
        continue;
      }
      const stackIndex = getStack(live, x, y, onRamp.z).length;
      const climbs = DIRS.some((direction) => {
        const step = canWalk(
          live,
          { x, y, z: onRamp.z, stackIndex },
          direction,
          playerDef,
          tilesById,
        );
        return step.ok && feetAt(step.to.x, step.to.y, step.to.z) > onRamp.abs;
      });
      if (!climbs)
        problem("ramp-climbs-nowhere", x, y, z, `ramp at ${where(x, y, z)} climbs nowhere`);
      if (!seen.has(`${x},${y},${onRamp.z}`)) {
        problem("ramp-unreachable", x, y, z, `ramp at ${where(x, y, z)} cannot be walked to`);
      }
    }
  }

  const walked: Record<string, number> = {};
  for (const z of levels) walked[`L${z}`] = [...seen].filter((k) => k.endsWith(`,${z}`)).length;
  return report(walked);
}
