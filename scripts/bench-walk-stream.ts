/**
 * PROTOTYPE — what walking costs a sight subscription, per step.
 *
 * Standing still is quiet; the question is what a *walk* streams. The chunk
 * subscription only changes when you cross a chunk boundary, so it is idle for
 * fifteen steps out of sixteen and then hands over a column. A sight
 * subscription moves with every step, so it has something to send on every one
 * of them — and every patch a client receives is a `setStacks`, a new chunk
 * identity, a geometry rebuild and a light invalidation.
 *
 * This walks a body in a straight line across the real map and counts the
 * ground each step newly owes, both ways.
 *
 *   bun scripts/bench-walk-stream.ts
 */
import { GameSession } from "../app/game/GameSession";
import { TICK_MS } from "../app/game/constants";
import { getStack, parseMap } from "../app/lib/mapData";
import { statusesById } from "../app/lib/status";
import { tilesByIdFromList } from "../app/lib/validation";
import { normalizeTileDef, type Coord, type TileDef } from "../app/lib/types";
import {
  INTEREST_REACH_CHUNKS,
  cellsOfChunks,
  chunksEntered,
  interestChunks,
} from "../app/net/interest";
import { subscriptionFor } from "../app/net/visibleSet";

const STEPS = 24;

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

async function main() {
  const map = parseMap(await Bun.file("data/map.json").text());
  const tiles: TileDef[] = (
    JSON.parse(await Bun.file("data/tiles.json").text()) as unknown[]
  ).map((raw) => normalizeTileDef(raw));
  const tilesById = tilesByIdFromList(tiles);
  const statuses = statusesById(
    JSON.parse(await Bun.file("data/statuses.json").text()) as unknown[],
  );

  const session = new GameSession(map, tiles, { actorIds: [], statuses });
  session.spawn("me");
  for (let i = 0; i < Math.round(2000 / TICK_MS); i++) session.tick(TICK_MS);
  const live = session.getMap();
  const self = session.actorSnapshots().find((a) => a.id === "me")!;

  // A straight line from wherever the spawn put us. Walked on paper rather than
  // through the simulation, because what is being measured is the subscription
  // as a function of position and nothing about whether the ground is walkable.
  const path: Coord[] = [];
  for (let i = 0; i < STEPS; i++) {
    path.push({ x: self.x + i, y: self.y, z: self.z });
  }

  // --- sight: what each step newly owes ------------------------------------
  const sentSight = new Set<string>();
  const sightPerStep: number[] = [];
  let sightTotal = 0;
  for (const at of path) {
    const { ground } = subscriptionFor(live, tilesById, at);
    let fresh = 0;
    for (const key of ground) {
      if (sentSight.has(key)) continue;
      sentSight.add(key);
      fresh++;
    }
    sightPerStep.push(fresh);
    sightTotal += fresh;
  }

  // --- chunks: the same walk, the shipped subscription ----------------------
  const chunkPerStep: number[] = [];
  let chunkTotal = 0;
  let held: Set<string> | undefined;
  for (const at of path) {
    const now = interestChunks(at.x, at.y);
    const entered = chunksEntered(held, now, at);
    held = now;
    const cells = entered.length ? cellsOfChunks(live, entered).length : 0;
    chunkPerStep.push(cells);
    chunkTotal += cells;
  }

  const show = (name: string, per: number[], total: number) => {
    const sorted = [...per].sort((a, b) => a - b);
    const busy = per.filter((n) => n > 0).length;
    console.log(
      `${name.padEnd(8)} ${String(total).padStart(7)} cells over ${STEPS} steps   ` +
        `p50 ${String(percentile(sorted, 0.5)).padStart(5)}  worst ${String(sorted[sorted.length - 1]).padStart(6)}   ` +
        `steps with anything to send: ${busy}/${STEPS}`,
    );
  };

  console.log(
    `\nwalking ${STEPS} cells east from the spawn (reach ${INTEREST_REACH_CHUNKS} chunks vs sight)\n`,
  );
  show("sight", sightPerStep, sightTotal);
  show("chunks", chunkPerStep, chunkTotal);
  console.log();
  void getStack;
}

await main();
