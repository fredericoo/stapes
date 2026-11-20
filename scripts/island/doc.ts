import { WALK_DURATION_MS } from "../../app/game/constants";
import type { Builder } from "./build";
import { PLACES, type PlaceId } from "./layout";
import type { Plan } from "./plan";
import type { Island } from "./terrain";

const cell = (c: { x: number; y: number; z: number } | null) =>
  c ? `${c.x}, ${c.y}, L${c.z}` : "—";

/** The lamp posts of one route in the order a lamplighter walks them: nearest first from the first post. */
function walkingOrder(points: Array<{ x: number; y: number; z: number }>) {
  const left = [...points];
  const out = left.length ? [left.shift()!] : [];
  while (left.length) {
    const last = out[out.length - 1]!;
    left.sort(
      (a, b) => Math.hypot(a.x - last.x, a.y - last.y) - Math.hypot(b.x - last.x, b.y - last.y),
    );
    out.push(left.shift()!);
  }
  return out;
}

/** `docs/map.md`, written from what the generator placed, so its coordinates are the map's. */
export function mapDoc(
  b: Builder,
  plan: Plan,
  island: Island,
  settings: { seed: number; cellsPerPixel: number },
): string {
  const w = (x: number, y: number, z: number) => b.world(x, y, z);
  const lines: string[] = [];
  lines.push(
    "# The map of Rune Isle",
    "",
    "Where everything on the surface of `data/map.json` is, and who lives and works",
    "where. **This file is written by `bun run generate:island`** together with the",
    "map, so an edit here is lost the next time the map is generated; change",
    "`scripts/island/` instead. Coordinates are map cells, `x, y, level`. The wreck",
    "beach, where a player wakes, is `0, 0`; north is negative `y`.",
    "",
    `The island is seed ${settings.seed} of the reference generator at ${settings.cellsPerPixel} cells per pixel of`,
    "`docs/lore-map.webp`, inside the sketch's coastline. A step takes",
    `${WALK_DURATION_MS} ms and movement is four-way, so a road's length in cells is its walking time.`,
    "",
    "Each character's tile stands in the cell under *Stands*, which their routines",
    "read as their home; `docs/notes.md`, *The cast is placed at work*, says why",
    "that is the work cell for most of them. No wild creature is placed.",
    "",
    "## Places",
    "",
    "| Place | Where | Level |",
    "| --- | --- | --- |",
  );
  for (const id of Object.keys(PLACES) as PlaceId[]) {
    const p = island.place(id);
    const z = Math.max(0, island.level[p.y * island.width + p.x]!);
    const at = w(p.x, p.y, z);
    lines.push(`| ${PLACES[id].label} | ${at.x}, ${at.y} | ${z} |`);
  }
  lines.push(
    "",
    "## Who lives and works where",
    "",
    "| Tile id | Name | Home | Bed | Works at | Work cell | Stands |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const r of b.residents) {
    if (!r.tileId) continue;
    lines.push(
      `| \`${r.tileId}\` | ${r.name} | ${r.home} | ${cell(r.bed)} | ${r.work} | ${cell(r.workCell)} | ${r.post ? `${cell(r.post)}, facing ${r.post.facing}` : "—"} |`,
    );
  }
  if (b.cats.length) {
    lines.push("", "The named cats live with their owners:", "");
    for (const c of b.cats) {
      const owner = b.residents.find((r) => r.tileId === c.owner)!;
      lines.push(`- \`${c.tileId}\` with ${owner.name}, at ${cell(c)}`);
    }
  }
  const spare = b.residents.filter((r) => !r.tileId);
  if (spare.length) {
    lines.push("", "Beds nobody in the cast sleeps in:", "");
    for (const r of spare) lines.push(`- ${r.name}: ${r.home}, ${cell(r.bed)}`);
  }
  lines.push(
    "",
    "## Buildings",
    "",
    "| Building | North-west corner | South-east corner | Level | Storeys | Door |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const bd of b.buildings) {
    const a = w(bd.rect.x0, bd.rect.y0, bd.z);
    const c = w(bd.rect.x1, bd.rect.y1, bd.z);
    const d = w(bd.door.x, bd.door.y, bd.z);
    const open = b.board.get(bd.door.x, bd.door.y, bd.z)?.at(-1)?.tileId === "door-open";
    lines.push(
      `| ${bd.label} | ${a.x}, ${a.y} | ${c.x}, ${c.y} | ${bd.z} | ${bd.storeys} | ${d.x}, ${d.y} (${bd.door.wall}${open ? ", open" : ""}) |`,
    );
  }
  lines.push("", "## The lamplighters' routes", "");
  lines.push(
    "Each town's lamp posts are `lamppost-off` beside its streets, and only the two",
    "towns have them, because only they have a lamplighter. The posts are listed in",
    "the order a walk from the first one reaches them, nearest next.",
    "",
  );
  const routes = new Map<string, Array<{ x: number; y: number; z: number }>>();
  for (const l of b.lamps) routes.set(l.route, [...(routes.get(l.route) ?? []), l]);
  for (const [route, posts] of routes) {
    lines.push(
      `- **${route}**, ${posts.length} posts: ${walkingOrder(posts)
        .map((p) => `${p.x}, ${p.y}`)
        .join("; ")}.`,
    );
  }
  lines.push("", "## Roads", "", "| From | To | Cells | Walk |", "| --- | --- | --- | --- |");
  for (const r of plan.roadLengths) {
    lines.push(
      `| ${PLACES[r.from].label} | ${PLACES[r.to].label} | ${r.cells} | ${Math.round((r.cells * WALK_DURATION_MS) / 1000)} s |`,
    );
  }
  lines.push(
    "",
    `${plan.bridges.length} bridges carry roads over rivers; elsewhere a road wades the river at a ford.`,
    `${plan.ramps.length} ramps join the terraces, and every cell a player can reach has a way back.`,
    "",
  );
  return lines.join("\n");
}
