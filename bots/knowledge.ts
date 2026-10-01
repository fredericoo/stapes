import { canRewardFrom, type ObjectRef } from "../app/game/affordances";
import type { Equipment } from "../app/game/equipment";
import type { ActorSnapshot } from "../app/game/GameSession";
import { listStandingSurfaces } from "../app/game/movement";
import type { NavGoal, NavWorld } from "../app/game/navigation";
import { chunkKeyFor, listChunkKeys, listCoords, removeTileAt } from "../app/lib/mapData";
import { resolveReward, resolveTeleport } from "../app/lib/interactions";
import type { StatusDef } from "../app/lib/status";
import { MAX_LEVEL, MIN_LEVEL } from "../app/lib/types";
import type { Coord, MapFile, PlacedTile, TileDef } from "../app/lib/types";

/**
 * What a bot knows is what its socket was sent: every chunk it has been near,
 * as it last saw it. A chunk nobody sent is absent on every level, which is
 * the only way an empty chunk and an unseen one differ.
 */
export class Knowledge {
  readonly board: MapFile;
  private readonly seenChunks: ReadonlySet<string>;

  constructor(
    map: MapFile,
    bodies: readonly ActorSnapshot[],
    readonly tilesById: Record<string, TileDef>,
    readonly statusDefs: Record<string, StatusDef>,
  ) {
    this.board = withoutBodies(map, bodies);
    const seen = new Set<string>();
    for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
      for (const key of listChunkKeys(map, z)) seen.add(key);
    }
    this.seenChunks = seen;
  }

  world(selfId: string): NavWorld {
    return {
      board: this.board,
      traveller: this.tilesById.player!,
      tilesById: this.tilesById,
      statusDefs: this.statusDefs,
      who: selfId,
    };
  }

  seen(x: number, y: number): boolean {
    return this.seenChunks.has(chunkKeyFor(x, y));
  }

  /** A cell beside one in a chunk the bot has never been sent. */
  onFrontier(cell: Coord): boolean {
    return (
      !this.seen(cell.x + 1, cell.y) ||
      !this.seen(cell.x - 1, cell.y) ||
      !this.seen(cell.x, cell.y + 1) ||
      !this.seen(cell.x, cell.y - 1)
    );
  }

  rewardsOnOffer(tags: readonly string[]): Array<{ ref: ObjectRef; tag: string; name: string }> {
    const out: Array<{ ref: ObjectRef; tag: string; name: string }> = [];
    this.eachPlacement((ref, def, placed) => {
      const reward = resolveReward(placed, def);
      if (!reward || tags.includes(reward.tag)) return;
      out.push({ ref, tag: reward.tag, name: def.name });
    });
    return out;
  }

  signs(): Array<{ at: Coord; text: string }> {
    const out: Array<{ at: Coord; text: string }> = [];
    this.eachPlacement((ref, _def, placed) => {
      const text = placed.inscription?.trim();
      if (text) out.push({ at: { x: ref.x, y: ref.y, z: ref.z }, text });
    });
    return out;
  }

  ways(): Array<{ at: Coord; to: Coord; name: string }> {
    const out: Array<{ at: Coord; to: Coord; name: string }> = [];
    this.eachPlacement((ref, def, placed) => {
      const teleport = resolveTeleport(placed, def, ref);
      if (teleport) out.push({ at: ref, to: teleport.to, name: teleport.actionName ?? def.name });
    });
    return out;
  }

  rewardGoal(ref: ObjectRef, equipment: Equipment, tags: readonly string[]): NavGoal {
    return {
      reached: (cell) => canRewardFrom(this.board, this.tilesById, cell, ref, equipment, tags),
      estimate: (cell) => Math.max(0, Math.abs(cell.x - ref.x) + Math.abs(cell.y - ref.y) - 1),
    };
  }

  /** Standing cells on level `z` between `near` and `far` cells of `from`. */
  standingCellsAround(from: Coord, near: number, far: number): Coord[] {
    const out: Coord[] = [];
    for (const { x, y } of listCoords(this.board, from.z)) {
      const away = Math.abs(x - from.x) + Math.abs(y - from.y);
      if (away < near || away > far) continue;
      const surfaces = listStandingSurfaces(this.board, x, y, this.tilesById);
      if (surfaces.some((surface) => surface.z === from.z)) out.push({ x, y, z: from.z });
    }
    return out;
  }

  /** Every standing cell beside a chunk the bot has never been sent. */
  frontierCells(): Coord[] {
    const out: Coord[] = [];
    const columns = new Set<string>();
    for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
      for (const { x, y } of listCoords(this.board, z)) {
        const key = `${x},${y}`;
        if (columns.has(key)) continue;
        columns.add(key);
        if (!this.onFrontier({ x, y, z })) continue;
        for (const surface of listStandingSurfaces(this.board, x, y, this.tilesById)) {
          out.push({ x, y, z: surface.z });
        }
      }
    }
    return out;
  }

  private eachPlacement(visit: (ref: ObjectRef, def: TileDef, placed: PlacedTile) => void) {
    for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
      for (const { x, y, stack } of listCoords(this.board, z)) {
        stack.forEach((placed, stackIndex) => {
          const def = this.tilesById[placed.tileId];
          if (def) visit({ x, y, z, stackIndex }, def, placed);
        });
      }
    }
  }
}

/**
 * The edge of a map is a frontier forever, because nothing lies beyond it to
 * be sent. Marking blocks rather than cells as explored is what stops a bot
 * creeping along that edge one cell at a time.
 */
export const EXPLORED_BLOCK_CELLS = 6;

export function exploredKey(cell: Coord): string {
  const bx = Math.floor(cell.x / EXPLORED_BLOCK_CELLS);
  const by = Math.floor(cell.y / EXPLORED_BLOCK_CELLS);
  return `${cell.z}:${bx},${by}`;
}

function withoutBodies(map: MapFile, bodies: readonly ActorSnapshot[]): MapFile {
  const highestFirst = [...bodies].sort((a, b) => b.stackIndex - a.stackIndex);
  let board = map;
  for (const body of highestFirst) {
    board = removeTileAt(board, body.x, body.y, body.z, body.stackIndex);
  }
  return board;
}
