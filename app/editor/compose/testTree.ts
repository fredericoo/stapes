import tilesRaw from "../../../data/tiles.json";
import { PLAYER_TILE_ID } from "../../game/constants";
import { navigationLegs, settleAt, type NavWorld } from "../../game/navigation";
import { wadesIn } from "../../game/pathfinding";
import { cellKey } from "../../game/pressurePlates";
import { getStack } from "../../lib/mapData";
import type { Coord } from "../../lib/types";
import { normalizeTiles } from "../../lib/types";
import { tilesByIdFromList } from "../../lib/validation";
import { buildMap, type BuildResult, type ComponentRegistry } from "./build";
import { COMPONENTS } from "./components";
import type { Frame, MapNode } from "./doc";

export const tilesById = tilesByIdFromList(normalizeTiles(tilesRaw as unknown[]));

export type Spot = { x: number; y: number; z?: number };

export type Size = { w: number; h: number };

export type WalkOptions = { wading?: boolean };

const DEFAULT_SEED = 7;

const UNNAMED = "";

/** Leave `key` out unless another node names this one: `buildTree` gives every unnamed node its own. */
export function node(
  type: string,
  props: Record<string, unknown> = {},
  rest: Partial<Omit<MapNode, "type" | "props">> = {},
): MapNode {
  return { type, key: UNNAMED, props, ...rest };
}

/**
 * A node's seed comes from its key, so an unnamed node is keyed by its type
 * and how many of that type came before it in the tree. A key counted across
 * every tree a file builds would re-roll a test whenever one was added above it.
 */
function keyed(root: MapNode): MapNode {
  const counts = new Map<string, number>();
  const visit = (n: MapNode): MapNode => {
    const nth = (counts.get(n.type) ?? 0) + 1;
    counts.set(n.type, nth);
    const key = n.key === UNNAMED ? `${n.type}-${nth}` : n.key;
    return { ...n, key, children: n.children?.map(visit) };
  };
  return visit(root);
}

export function frame(x: number, y: number, w: number, h: number): Frame {
  return { x, y, w, h };
}

/** Flat ground of one tile over the whole frame, for a test that wants land and no coast. */
export function land(size: Size, children: MapNode[], tile = "grass"): MapNode {
  return node(
    "group",
    {},
    {
      frame: frame(0, 0, size.w, size.h),
      children: [node("fill", { tiles: [tile], edge: [], mode: "whole stack" }), ...children],
    },
  );
}

/**
 * A sea holding one smooth island `margin` cells in from each edge. `children`
 * are laid beside the island, after it; `island.under` are its own children,
 * which is what a rule an island keeps over its descendants applies to.
 */
export function isle(
  size: Size,
  children: MapNode[],
  margin = 4,
  island: { under?: MapNode[]; props?: Record<string, unknown> } = {},
): MapNode {
  const shore = frame(margin, margin, size.w - margin * 2, size.h - margin * 2);
  return node(
    "sea",
    {},
    {
      frame: frame(0, 0, size.w, size.h),
      children: [
        node("island", { roughness: 0, ...island.props }, { frame: shore, children: island.under }),
        ...children,
      ],
    },
  );
}

/**
 * Builds a tree with the real components and the real tile catalogue. A node
 * that cannot be built fails the test here with its reason, unless the test
 * is about the refusal and asks to be handed the `problems`.
 */
export function buildTree(
  root: MapNode,
  opts: { seed?: number; components?: ComponentRegistry; problems?: "returned" } = {},
): BuildResult {
  const built = buildMap(
    { version: 1, seed: opts.seed ?? DEFAULT_SEED, root: keyed(root) },
    tilesById,
    opts.components ?? COMPONENTS,
  );
  if (built.problems.length > 0 && opts.problems !== "returned") {
    const reasons = built.problems.map((p) => `${p.key}: ${p.reason}`).join("\n");
    throw new Error(`The tree did not build:\n${reasons}`);
  }
  return built;
}

function navWorld(built: BuildResult): NavWorld {
  return { board: built.map, traveller: tilesById[PLAYER_TILE_ID]!, tilesById, statusDefs: {} };
}

/**
 * Where a player put down at a spot stands: on the raised ground there, unless
 * the spot names a level. A spot with nothing to stand on is a mistake in the
 * test, and would otherwise read as "cannot be walked to".
 */
export function standingAt(built: BuildResult, spot: Spot): Coord {
  const z = spot.z ?? built.elevation.get(`${spot.x},${spot.y}`) ?? 0;
  const cell = settleAt(navWorld(built), { x: spot.x, y: spot.y, z });
  const blocked = cell
    ? getStack(built.map, cell.x, cell.y, cell.z).find(
        (p) => tilesById[p.tileId]?.walkable === false,
      )
    : undefined;
  if (!cell || blocked) {
    const why = blocked ? `${blocked.tileId} is in the way` : "there is no ground";
    throw new Error(`Nobody can stand at ${spot.x},${spot.y}: ${why}\n${sketch(built)}`);
  }
  return cell;
}

/**
 * Every cell a player starting at a spot can get to with the legs the game
 * gives it: steps, ramps, doors it can open, ladders, and drops. A drop is why
 * the way down a cliff is walked where the way up is not. Unless `wading`, it
 * keeps its feet dry the way a click to walk does for a body that cannot swim,
 * which is what makes a river something to cross.
 */
export function reach(built: BuildResult, from: Spot, opts: WalkOptions = {}): Map<string, Coord> {
  const world = navWorld(built);
  const start = standingAt(built, from);
  const dry = !opts.wading && !wadesIn(world.board, start, tilesById);
  const seen = new Map([[cellKey(start), start]]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    for (const leg of navigationLegs(world, queue[head]!)) {
      const key = cellKey(leg.to);
      if (seen.has(key)) continue;
      if (dry && wadesIn(world.board, leg.to, tilesById)) continue;
      seen.set(key, leg.to);
      queue.push(leg.to);
    }
  }
  return seen;
}

export function walks(built: BuildResult, from: Spot, to: Spot, opts: WalkOptions = {}): boolean {
  return reach(built, from, opts).has(cellKey(standingAt(built, to)));
}

/**
 * The map as text for the message of a failed assertion, one character a
 * cell: `~` water, `^` a ramp, `#` something in the way, a digit for raised
 * ground and `.` for the rest of what can be stood on.
 */
export function sketch(built: BuildResult): string {
  const root = built.layout.placements.get(built.layout.order[0]!)!.bounds;
  const rows: string[] = [];
  for (let y = root.minY; y <= root.maxY; y++) {
    let row = "";
    for (let x = root.minX; x <= root.maxX; x++) {
      const z = built.elevation.get(`${x},${y}`) ?? 0;
      const ids = getStack(built.map, x, y, z).map((p) => p.tileId);
      if (ids.length === 0) row += " ";
      else if (ids.includes("ramp")) row += "^";
      else if (ids.at(-1) === "deep-water" || wadesIn(built.map, { x, y, z }, tilesById))
        row += "~";
      else if (ids.some((id) => tilesById[id]?.walkable === false)) row += "#";
      else row += z > 0 ? String(z) : ".";
    }
    rows.push(row);
  }
  return rows.join("\n");
}
