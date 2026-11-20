import type { Direction, PlacedTile } from "../../app/lib/types";
import type { Builder, Building, Resident } from "./build";

type Cell = { x: number; y: number; z: number };

/** Who stands beside their bed rather than at their work cell: the travellers have no work cell. */
const BY_THE_BED = new Set(["hamid-sarraf", "anselm-quaye", "yeva-kostenko"]);

/** Which way somebody at an outdoor post looks; indoors they face the door. */
const LOOKS: Record<string, Direction> = {
  "tove-arnesdatter": "n",
  "ifeoma-nwachukwu": "w",
  "wenna-pascoe": "n",
  "hesper-vaun": "n",
  "dagny-rook": "s",
  "suvi-kallio": "e",
  "casimir-wren": "e",
  "fen-achterberg": "s",
  "taavi-kask": "s",
  "nadia-ferreira": "s",
  "absalom-grieve": "s",
  "edda-kell": "n",
  "sigrun-halde": "n",
  "gideon-okafor": "e",
  "liv-sandvik": "n",
};

/** Each named cat, with whom it lives. */
const CATS: Record<string, string> = {
  "cat-biscuit": "ifeoma-nwachukwu",
  "cat-soot": "mina-dross",
  "cat-ghee": "rukmini-desai",
  "cat-captain": "margit-oslund",
  "cat-nettle": "morwen-teague",
};

/**
 * Puts every character's tile on the board. A placement is the body's home:
 * `returns-home` walks it back there each morning, and `keeps-hours` walks
 * from there at bedtime to its `bed` spot, the floor beside its own bed,
 * which is placed last so that no body starts on it. It opens doors and
 * climbs ladders on the way (`docs/notes.md`, *The cast
 * is placed at work*).
 */
export function placeCast(b: Builder) {
  const placed = new Map<Resident, PlacedTile>();
  for (const r of b.residents) {
    if (!r.tileId) continue;
    const post = BY_THE_BED.has(r.tileId) || !r.workCell ? b.bedside(r.bed!) : free(b, r.workCell);
    if (!post) throw new Error(`${r.name}: no free floor beside the bed`);
    const inside = buildingAt(b, post);
    placed.set(r, b.stand(r, post, r.faces ?? LOOKS[r.tileId] ?? inside?.door.wall ?? "s"));
  }
  for (const [cat, owner] of Object.entries(CATS)) {
    const by = b.residents.find((r) => r.tileId === owner)?.post;
    if (!by) throw new Error(`${cat}: ${owner} is not placed`);
    const at = free(b, by, 1);
    const x = at.x - b.board.ox;
    const y = at.y - b.board.oy;
    b.put(x, y, at.z, cat, "s");
    b.cats.push({ tileId: cat, owner, ...at });
  }
  for (const [r, tile] of placed) {
    const bed = r.bed && b.bedside(r.bed);
    if (!bed) throw new Error(`${r.name}: no free floor beside the bed`);
    tile.spots = { bed };
    r.bedside = bed;
  }
}

/** The free floor cell nearest `at`, `at` itself if it is free, skipping the first `skip` rings. */
function free(b: Builder, at: Cell, skip = 0): Cell {
  for (let ring = skip; ring <= 3; ring++)
    for (let dy = -ring; dy <= ring; dy++)
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const cell = { x: at.x + dx, y: at.y + dy, z: at.z };
        if (b.isFree(cell.x - b.board.ox, cell.y - b.board.oy, cell.z)) return cell;
      }
  throw new Error(`no free floor near ${at.x}, ${at.y}, L${at.z}`);
}

function buildingAt(b: Builder, at: Cell): Building | undefined {
  const x = at.x - b.board.ox;
  const y = at.y - b.board.oy;
  return b.buildings.find(
    (h) =>
      at.z >= h.z &&
      at.z < h.z + h.storeys &&
      x > h.rect.x0 &&
      x < h.rect.x1 &&
      y > h.rect.y0 &&
      y < h.rect.y1,
  );
}
