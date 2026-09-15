/**
 * PROTOTYPE — does the subscription's idea of sight agree with the game's?
 *
 * `app/game/sight.ts` is the real statement of what blocks a look, and
 * `app/net/visibleSet.ts` restates it against flat arrays because reading the
 * map through `getStack` was 43ms of a 59ms computation. Two statements of one
 * rule can disagree, and this is the check that says whether they do.
 *
 * The answer decides whether anything else about the prototype is meaningful:
 * a subscription that admits bodies the game says you cannot see is not an
 * occlusion subscription, it is a slightly smaller box.
 *
 *   bun scripts/check-sight-agrees.ts
 */
import { GameSession } from "../app/game/GameSession";
import { TICK_MS } from "../app/game/constants";
import { hasLineOfSight } from "../app/game/sight";
import { parseMap } from "../app/lib/mapData";
import { statusesById } from "../app/lib/status";
import { tilesByIdFromList } from "../app/lib/validation";
import { normalizeTileDef, type Coord, type TileDef } from "../app/lib/types";
import { cellKey3, visibleFrom } from "../app/net/visibleSet";

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
  const actors = session.actorSnapshots();
  const me = actors.find((a) => a.id === "me")!;
  const from: Coord = { x: me.x, y: me.y, z: me.z };

  const { visible } = visibleFrom(live, tilesById, from);

  // Every body in the world, asked both ways.
  let agreeSeen = 0;
  let agreeHidden = 0;
  const admitted: string[] = [];
  const missed: string[] = [];
  for (const actor of actors) {
    if (actor.id === "me") continue;
    const at = { x: actor.x, y: actor.y, z: actor.z };
    const mine = visible.has(cellKey3(at.x, at.y, at.z));
    const theirs = hasLineOfSight(live, tilesById, from, at);
    if (mine && theirs) agreeSeen++;
    else if (!mine && !theirs) agreeHidden++;
    else if (mine) admitted.push(`${actor.id} @ ${at.x},${at.y},${at.z}`);
    else missed.push(`${actor.id} @ ${at.x},${at.y},${at.z}`);
  }

  console.log(`\nstanding at ${from.x},${from.y},${from.z} — ${actors.length - 1} other bodies\n`);
  console.log(`both say seen:    ${agreeSeen}`);
  console.log(`both say hidden:  ${agreeHidden}`);
  console.log(`ONLY the subscription says seen (a leak):  ${admitted.length}`);
  console.log(`ONLY game/sight says seen (a hole):        ${missed.length}`);
  for (const line of admitted.slice(0, 12)) console.log(`   leak  ${line}`);
  for (const line of missed.slice(0, 12)) console.log(`   hole  ${line}`);

  // And the same question over ground rather than bodies, which is the larger
  // sample: every cell the subscription claims, checked against the ray.
  let cells = 0;
  let cellLeaks = 0;
  for (const key of visible) {
    const [x, y, z] = key.split(",").map(Number);
    cells++;
    if (!hasLineOfSight(live, tilesById, from, { x: x!, y: y!, z: z! })) cellLeaks++;
  }
  console.log(
    `\nground: ${cells} cells claimed, ${cellLeaks} of them the ray says are hidden (${((cellLeaks / cells) * 100).toFixed(1)}%)\n`,
  );
}

await main();
