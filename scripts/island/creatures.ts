import { chunkifyMap } from "../../app/lib/mapData";
import type { FlatMapFile, PlacedTile, TileDef } from "../../app/lib/types";
import { MAP_FILE_VERSION, coordKey } from "../../app/lib/types";
import { canPlace } from "../../app/lib/validation";
import { tile } from "./board";
import type { Builder } from "./build";
import { distanceTo, mulberry32 } from "./grid";
import { SAFE_PATH } from "./layout";
import { Ground } from "./terrain";
import type { CaveRoom, Underground } from "./underground";

/** Which land a habitat belongs to; `camp` is the neutral country round the camp and the roads. */
export type Land = "camp" | "water" | "fire" | "nature" | "barrow" | "roads" | "deep";

/** A habitat as the generator placed it, for `docs/map.md`. */
export type PlacedHabitat = {
  name: string;
  land: Land;
  tier: number;
  levels: string;
  wanted: Record<string, number>;
  placed: Record<string, number>;
  at: Array<{ tileId: string; x: number; y: number; z: number }>;
};

type Cell = { x: number; y: number; z: number };

type Habitat = {
  name: string;
  land: Land;
  /** 1 is a land's edge, where a new player hunts; each step up is further in or deeper down. */
  tier: number;
  cells: () => Cell[];
  creatures: Array<[string, number]>;
  /** Fewest cells between two creatures of this habitat. */
  spacing: number;
};

/** Ground a body is never placed on: it drowns, burns, slides or falls there. */
const NOT_GROUND = new Set(["water", "deep-water", "lava", "ice", "hole"]);

/**
 * Cells from the wreck beach road and the camp that a hostile creature keeps.
 * Further than any shipped creature sees (a bat 8, a wolf 9, the troll's 30
 * is its chase, not its sight) plus the leash that brings it back home.
 */
const SAFE_CELLS = 26;
const PASSIVE_SAFE_CELLS = 6;
/** Cells from any settlement's site that a hostile creature keeps. */
const SITE_CELLS = 18;
/** Cells between any two creatures, whatever their habitat. */
const CROWD_CELLS = 2;
/** How far along the wreck beach road the safe zone is traced, past the road's own length. */
const SAFE_ROAD_STEPS = 140;
const ROAD_THREAT_SPACING = 45;
/**
 * The mountain below the snow line, whose rock `planIsland` turns to grass:
 * high ground no further than this from the snow.
 */
const MOUNTAIN_LEVEL = 2;
const MOUNTAIN_CELLS = 30;
const RING_INNER = 1.5;
const RING_OUTER = 2.5;
const RING_CLEAR = 3.2;
const RING_MIN_CELLS = 9;

const FIRE_LAND = new Set<number>([Ground.Desert, Ground.Basalt, Ground.Lava]);
const NATURE_LAND = new Set<number>([Ground.Woods, Ground.DeepWoods, Ground.Bog]);

/**
 * Places the island's wild creatures, land by land. Each elemental land rises
 * from weak creatures at its edge to the strongest at its centre, and each
 * cave from its mouth to its lowest floor (`docs/lore.md`, *The three
 * elemental lands*). Nothing hostile is placed near the wreck beach road, the
 * camp or any settlement, and nothing anywhere `reach` leaves out, the cells
 * a player can walk to from the wreck beach.
 */
export function placeCreatures(
  b: Builder,
  underground: Underground,
  tilesById: Record<string, TileDef>,
  reach: ReadonlySet<string>,
): PlacedHabitat[] {
  const { island, plan, board } = b;
  const w = island.width;
  const h = island.height;
  const n = w * h;

  const surface = (i: number) => island.level[i]!;
  const isGround = (x: number, y: number, z: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const stack = board.get(x, y, z);
    if (!stack || stack.length === 0) return false;
    if (NOT_GROUND.has(stack[stack.length - 1]!.tileId)) return false;
    for (const placed of stack) {
      const def = tilesById[placed.tileId];
      if (!def || (def.height ?? 0) !== 0 || def.walkable === false) return false;
    }
    if (!reach.has(`${x + board.ox},${y + board.oy},${z}`)) return false;
    const i = y * w + x;
    if (z >= surface(i)) {
      if (plan.reserved[i] || plan.road[i] || plan.siteOf[i]) return false;
      if (board.get(x, y, z + 1)?.length) return false;
    }
    return true;
  };

  const safeFrom = safeZone(b);
  const safeDistance = distanceTo(island, (i) => safeFrom[i] === 1);
  const siteDistance = distanceTo(island, (i) => plan.siteOf[i]! > 0);
  const depthIn = (land: Set<number>) => distanceTo(island, (i) => !land.has(island.biome[i]!));
  const desertDepth = depthIn(FIRE_LAND);
  const woodsDepth = depthIn(NATURE_LAND);
  const shore = distanceTo(island, (i) => island.ground[i] === Ground.Shallows);
  const lake = distanceTo(island, (i) => island.ground[i] === Ground.Lake);
  const snow = distanceTo(island, (i) => island.ground[i] === Ground.Snow);

  const surfaceWhere = (keep: (i: number) => boolean): (() => Cell[]) => {
    let cached: Cell[] | null = null;
    return () => {
      if (cached) return cached;
      cached = [];
      for (let i = 0; i < n; i++) {
        if (island.level[i]! < 0 || !keep(i)) continue;
        const x = i % w;
        const y = (i - x) / w;
        if (isGround(x, y, surface(i))) cached.push({ x, y, z: surface(i) });
      }
      return cached;
    };
  };

  const near = (place: { x: number; y: number }, r: number) => (i: number) => {
    const x = i % w;
    const y = (i - x) / w;
    return Math.hypot(x - place.x, y - place.y) <= r;
  };

  const roomsNamed = (...names: string[]) =>
    underground.rooms.filter((room) =>
      names.some((name) => room.name === name || new RegExp(`^${name} \\d+$`).test(room.name)),
    );

  const inRooms = (...names: string[]): (() => Cell[]) => {
    let cached: Cell[] | null = null;
    return () => {
      if (cached) return cached;
      const seen = new Set<string>();
      cached = [];
      const rooms = roomsNamed(...names);
      if (rooms.length === 0) throw new Error(`creatures: no room called ${names.join(" or ")}`);
      for (const room of rooms) {
        for (const c of roomCells(room)) {
          const k = `${c.x},${c.y},${c.z}`;
          if (seen.has(k) || !isGround(c.x, c.y, c.z)) continue;
          seen.add(k);
          cached.push(c);
        }
      }
      return cached;
    };
  };

  const roomCells = (room: CaveRoom): Cell[] => {
    const cx = room.x - board.ox;
    const cy = room.y - board.oy;
    const out: Cell[] = [];
    for (let y = cy - room.ry - 1; y <= cy + room.ry + 1; y++)
      for (let x = cx - room.rx - 1; x <= cx + room.rx + 1; x++)
        if (((x - cx) / (room.rx + 1)) ** 2 + ((y - cy) / (room.ry + 1)) ** 2 <= 1)
          out.push({ x, y, z: room.z });
    return out;
  };

  const awayFromPeople = (i: number) =>
    safeDistance[i]! >= SAFE_CELLS && siteDistance[i]! >= SITE_CELLS;
  const camp = island.place("camp");
  const peak = island.place("peak");
  const g = (i: number) => island.ground[i]!;

  const habitats: Habitat[] = [
    {
      name: "Fields round the camp",
      land: "camp",
      tier: 1,
      cells: surfaceWhere(
        (i) =>
          near(camp, 75)(i) &&
          awayFromPeople(i) &&
          (g(i) === Ground.Grass || g(i) === Ground.Woods),
      ),
      creatures: [["rat", 16]],
      spacing: 5,
    },
    {
      name: "Meadows round the camp",
      land: "camp",
      tier: 1,
      cells: surfaceWhere(
        (i) =>
          near(camp, 90)(i) &&
          safeDistance[i]! >= PASSIVE_SAFE_CELLS &&
          siteDistance[i]! >= 4 &&
          (g(i) === Ground.Grass || g(i) === Ground.Woods),
      ),
      creatures: [
        ["deer", 10],
        ["rabbit", 12],
      ],
      spacing: 6,
    },
    {
      name: "Bat cave",
      land: "camp",
      tier: 1,
      cells: inRooms("Bat cave"),
      creatures: [["bat", 7]],
      spacing: 2,
    },

    {
      name: "Beaches",
      land: "water",
      tier: 1,
      cells: surfaceWhere((i) => g(i) === Ground.Beach && shore[i]! <= 4 && awayFromPeople(i)),
      creatures: [["water-slime", 14]],
      spacing: 14,
    },
    {
      name: "Sea grotto",
      land: "water",
      tier: 1,
      cells: inRooms("Sea grotto"),
      creatures: [["water-slime", 8]],
      spacing: 4,
    },
    {
      name: "The lake shore",
      land: "water",
      tier: 2,
      cells: surfaceWhere((i) => lake[i]! > 0 && lake[i]! <= 6 && awayFromPeople(i)),
      creatures: [
        ["water-slime", 10],
        ["tide-wisp", 3],
      ],
      spacing: 10,
    },
    {
      name: "The flooded caves",
      land: "water",
      tier: 2,
      cells: inRooms("Flooded caves"),
      creatures: [["water-slime", 12]],
      spacing: 5,
    },
    {
      name: "The flooded caves below",
      land: "water",
      tier: 3,
      cells: inRooms("Flooded caves below"),
      creatures: [
        ["water-slime", 4],
        ["snow-wolf", 6],
      ],
      spacing: 5,
    },
    {
      name: "Under the lakes",
      land: "water",
      tier: 3,
      cells: inRooms("Under the lakes"),
      creatures: [["snow-wolf", 6]],
      spacing: 4,
    },
    {
      name: "The mountain",
      land: "water",
      tier: 3,
      cells: surfaceWhere(
        (i) =>
          g(i) === Ground.Grass &&
          island.level[i]! >= MOUNTAIN_LEVEL &&
          snow[i]! <= MOUNTAIN_CELLS &&
          awayFromPeople(i),
      ),
      creatures: [["snow-wolf", 10]],
      spacing: 12,
    },
    {
      name: "The frost caves",
      land: "water",
      tier: 3,
      cells: inRooms("Frost hall", "Frost caves second", "Frost caves third"),
      creatures: [["snow-wolf", 10]],
      spacing: 4,
    },
    {
      name: "The crystal galleries",
      land: "water",
      tier: 3,
      cells: inRooms("Crystal gallery", "Crystal gallery east", "Crystal halls"),
      creatures: [["snow-wolf", 12]],
      spacing: 6,
    },
    {
      name: "The snow below the peak",
      land: "water",
      tier: 4,
      cells: surfaceWhere((i) => g(i) === Ground.Snow && awayFromPeople(i)),
      creatures: [["snow-wolf", 10]],
      spacing: 10,
    },
    {
      name: "The White Peak",
      land: "water",
      tier: 5,
      cells: surfaceWhere((i) => g(i) === Ground.Snow && near(peak, 30)(i)),
      creatures: [["yeti", 1]],
      spacing: 1,
    },
    {
      name: "The frozen lake",
      land: "water",
      tier: 4,
      cells: inRooms("Frozen lake"),
      creatures: [["snow-wolf", 8]],
      spacing: 6,
    },
    {
      name: "The frozen lake below",
      land: "water",
      tier: 5,
      cells: inRooms("Frozen lake below"),
      creatures: [
        ["snow-wolf", 6],
        ["yeti", 1],
      ],
      spacing: 6,
    },

    {
      name: "The desert edge",
      land: "fire",
      tier: 1,
      cells: surfaceWhere(
        (i) =>
          g(i) === Ground.Desert &&
          desertDepth[i]! > 0 &&
          desertDepth[i]! <= 14 &&
          awayFromPeople(i),
      ),
      creatures: [["fire-slime", 14]],
      spacing: 12,
    },
    {
      name: "Snake hollow",
      land: "fire",
      tier: 1,
      cells: inRooms("Snake hollow"),
      creatures: [["snake", 6]],
      spacing: 2,
    },
    {
      name: "The open waste",
      land: "fire",
      tier: 2,
      cells: surfaceWhere(
        (i) => g(i) === Ground.Desert && desertDepth[i]! > 14 && awayFromPeople(i),
      ),
      creatures: [
        ["fire-slime", 8],
        ["ember-wisp", 4],
      ],
      spacing: 12,
    },
    {
      name: "The lava gorge",
      land: "fire",
      tier: 3,
      cells: surfaceWhere((i) => g(i) === Ground.Basalt && awayFromPeople(i)),
      creatures: [
        ["fire-slime", 6],
        ["ember-wisp", 3],
      ],
      spacing: 10,
    },
    {
      name: "Ember deeps, sandstone",
      land: "fire",
      tier: 2,
      cells: inRooms("Ember deeps", "Ember deeps -1"),
      creatures: [["fire-slime", 14]],
      spacing: 5,
    },
    {
      name: "Ember deeps, sandstone below",
      land: "fire",
      tier: 3,
      cells: inRooms("Ember deeps -2"),
      creatures: [["fire-slime", 8]],
      spacing: 6,
    },
    {
      name: "Ember deeps, basalt",
      land: "fire",
      tier: 4,
      cells: inRooms("Ember deeps -3", "Ember deeps -4"),
      creatures: [["cave-troll", 3]],
      spacing: 14,
    },

    {
      name: "The forest edge",
      land: "nature",
      tier: 1,
      cells: surfaceWhere(
        (i) =>
          g(i) === Ground.Woods && woodsDepth[i]! > 0 && woodsDepth[i]! <= 10 && awayFromPeople(i),
      ),
      creatures: [
        ["nature-slime", 14],
        ["snake", 4],
      ],
      spacing: 12,
    },
    {
      name: "Woodland grazing",
      land: "nature",
      tier: 1,
      cells: surfaceWhere(
        (i) => g(i) === Ground.Woods && siteDistance[i]! >= 4 && safeDistance[i]! >= SAFE_CELLS,
      ),
      creatures: [
        ["deer", 8],
        ["rabbit", 8],
      ],
      spacing: 10,
    },
    {
      name: "The deep woods",
      land: "nature",
      tier: 2,
      cells: surfaceWhere((i) => g(i) === Ground.DeepWoods && awayFromPeople(i)),
      creatures: [
        ["nature-slime", 6],
        ["wolf", 8],
        ["moss-wisp", 4],
      ],
      spacing: 10,
    },
    {
      name: "The rootways",
      land: "nature",
      tier: 2,
      cells: inRooms("Rootways"),
      creatures: [["nature-slime", 10]],
      spacing: 5,
    },
    {
      name: "The rootways below",
      land: "nature",
      tier: 3,
      cells: inRooms("Rootways below"),
      creatures: [["wolf", 8]],
      spacing: 5,
    },
    {
      name: "The rootways deep",
      land: "nature",
      tier: 4,
      cells: inRooms("Rootways deep"),
      creatures: [["bear", 4]],
      spacing: 8,
    },
    {
      name: "Bear caves",
      land: "nature",
      tier: 3,
      cells: inRooms("Bear caves", "Bear caves inner"),
      creatures: [["bear", 4]],
      spacing: 5,
    },
    {
      name: "The bog",
      land: "nature",
      tier: 4,
      cells: surfaceWhere((i) => g(i) === Ground.Bog && awayFromPeople(i)),
      creatures: [
        ["bog-imp", 10],
        ["nature-slime", 6],
      ],
      spacing: 9,
    },
    {
      name: "Troll cave",
      land: "nature",
      tier: 4,
      cells: inRooms("Troll cave"),
      creatures: [["cave-troll", 2]],
      spacing: 4,
    },

    {
      name: "The barrow",
      land: "barrow",
      tier: 2,
      cells: inRooms("barrow hall"),
      creatures: [["skeleton", 12]],
      spacing: 4,
    },
    {
      name: "Wolf den",
      land: "roads",
      tier: 2,
      cells: inRooms("Wolf den"),
      creatures: [["wolf", 6]],
      spacing: 2,
    },
    {
      name: "The deep way",
      land: "deep",
      tier: 5,
      cells: inRooms("The deep way west", "The deep way east"),
      creatures: [["cyclops", 1]],
      spacing: 12,
    },
  ];

  const taken: Cell[] = [];
  const crowded = (c: Cell, within: number, among: readonly Cell[]) =>
    among.some((o) => o.z === c.z && Math.abs(o.x - c.x) < within && Math.abs(o.y - c.y) < within);

  const out: PlacedHabitat[] = [];
  const put = (habitat: PlacedHabitat, tileId: string, c: Cell) => {
    board.push(c.x, c.y, c.z, tile(tileId, "s"));
    taken.push(c);
    habitat.placed[tileId] = (habitat.placed[tileId] ?? 0) + 1;
    habitat.at.push({ tileId, ...b.world(c.x, c.y, c.z) });
    if (tileId.endsWith("-wisp")) ringWithFlowers(b, c, isGround);
  };

  for (const habitat of habitats) {
    const random = mulberry32(hashName(habitat.name));
    const cells = [...habitat.cells()];
    for (let k = cells.length - 1; k > 0; k--) {
      const j = Math.floor(random() * (k + 1));
      [cells[k], cells[j]] = [cells[j]!, cells[k]!];
    }
    const record: PlacedHabitat = {
      name: habitat.name,
      land: habitat.land,
      tier: habitat.tier,
      levels: [...new Set(cells.map((c) => c.z))].sort((a, b) => b - a).join(", "),
      wanted: Object.fromEntries(habitat.creatures),
      placed: {},
      at: [],
    };
    const mine: Cell[] = [];
    for (const [tileId, count] of habitat.creatures) {
      let left = count;
      for (const c of cells) {
        if (left === 0) break;
        if (!isGround(c.x, c.y, c.z) || !fits(b, tileId, c)) continue;
        if (crowded(c, habitat.spacing, mine) || crowded(c, CROWD_CELLS, taken)) continue;
        if (tileId.endsWith("-wisp") && ringCells(b, c, isGround).length < RING_MIN_CELLS) continue;
        put(record, tileId, c);
        mine.push(c);
        left--;
      }
    }
    out.push(record);
  }

  out.push(placeRoadThreats(b, isGround, safeDistance, siteDistance, taken, crowded, put));
  return out;
}

/**
 * The roads between the towns, a creature of the land each passes through
 * every `ROAD_THREAT_SPACING` cells a few steps off the road: the threats
 * `docs/lore.md` puts on the roads for a new player to be careful of.
 */
function placeRoadThreats(
  b: Builder,
  isGround: (x: number, y: number, z: number) => boolean,
  safeDistance: Float32Array,
  siteDistance: Float32Array,
  taken: Cell[],
  crowded: (c: Cell, within: number, among: readonly Cell[]) => boolean,
  put: (h: PlacedHabitat, tileId: string, c: Cell) => void,
): PlacedHabitat {
  const { island, plan } = b;
  const w = island.width;
  const record: PlacedHabitat = {
    name: "The roads between the towns",
    land: "roads",
    tier: 2,
    levels: "",
    wanted: {},
    placed: {},
    at: [],
  };
  const random = mulberry32(hashName(record.name));
  const offRoad = (i: number, min: number, max: number, tileId: string): Cell | null => {
    const x0 = i % w;
    const y0 = (i - x0) / w;
    for (let tries = 0; tries < 40; tries++) {
      const r = min + random() * (max - min);
      const a = random() * Math.PI * 2;
      const x = Math.round(x0 + Math.cos(a) * r);
      const y = Math.round(y0 + Math.sin(a) * r);
      const j = y * w + x;
      const z = island.level[j]!;
      if (safeDistance[j]! < SAFE_CELLS || siteDistance[j]! < SITE_CELLS) continue;
      if (!isGround(x, y, z) || !fits(b, tileId, { x, y, z })) continue;
      if (crowded({ x, y, z }, CROWD_CELLS, taken)) continue;
      return { x, y, z };
    }
    return null;
  };
  const want = (id: string) => (record.wanted[id] = (record.wanted[id] ?? 0) + 1);

  const roadCells: number[] = [];
  for (let i = 0; i < plan.road.length; i++)
    if (plan.road[i] && safeDistance[i]! >= SAFE_CELLS && siteDistance[i]! >= SITE_CELLS)
      roadCells.push(i);
  const stops: number[] = [];
  for (const i of roadCells) {
    const x = i % w;
    const y = (i - x) / w;
    const far = stops.every((s) => {
      const sx = s % w;
      return Math.hypot(sx - x, (s - sx) / w - y) >= ROAD_THREAT_SPACING;
    });
    if (far) stops.push(i);
  }
  for (const i of stops) {
    const land = island.biome[i]!;
    const [tileId, count] = FIRE_LAND.has(land)
      ? (["snake", 1] as const)
      : land === Ground.Bog
        ? (["bog-imp", 1] as const)
        : land === Ground.Snow
          ? (["snow-wolf", 1] as const)
          : (["wolf", 2] as const);
    for (let k = 0; k < count; k++) {
      want(tileId);
      const at = offRoad(i, 4, 9, tileId);
      if (at) put(record, tileId, at);
    }
  }
  record.levels = [...new Set(record.at.map((c) => c.z))].sort((a, b) => b - a).join(", ");
  return record;
}

/**
 * The wreck beach road and the camp, as 1 in a grid: the road is followed
 * from the beach for a fixed number of steps, which reaches the camp's site
 * and stops before it can run far along a road that shares its line.
 */
function safeZone(b: Builder): Uint8Array {
  const { island, plan } = b;
  const w = island.width;
  const out = new Uint8Array(w * island.height);
  const [from, to] = SAFE_PATH;
  const beach = island.place(from);
  const site = plan.sites.get(to as "camp")!;
  for (let y = site.y0; y <= site.y1; y++)
    for (let x = site.x0; x <= site.x1; x++) out[y * w + x] = 1;
  for (let dy = -8; dy <= 8; dy++)
    for (let dx = -8; dx <= 8; dx++) out[(beach.y + dy) * w + beach.x + dx] = 1;
  let start = -1;
  let best = Infinity;
  for (let dy = -20; dy <= 20; dy++)
    for (let dx = -20; dx <= 20; dx++) {
      const i = (beach.y + dy) * w + beach.x + dx;
      if (plan.road[i] && Math.hypot(dx, dy) < best) {
        best = Math.hypot(dx, dy);
        start = i;
      }
    }
  if (start < 0) throw new Error("creatures: no road starts near the wreck beach");
  const seen = new Map<number, number>([[start, 0]]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    out[i] = 1;
    const steps = seen.get(i)!;
    if (steps >= SAFE_ROAD_STEPS || plan.siteOf[i]) continue;
    for (const j of [i - 1, i + 1, i - w, i + w]) {
      if (!plan.road[j] || seen.has(j)) continue;
      seen.set(j, steps + 1);
      queue.push(j);
    }
  }
  return out;
}

/**
 * Whether the body fits where it would stand, by the editor's own rule, so a
 * tall creature is not put under a cave roof it would stand through. The
 * check reads a few cells and levels round the cell, not the whole board.
 */
function fits(b: Builder, tileId: string, c: Cell): boolean {
  const flat: FlatMapFile = { version: MAP_FILE_VERSION, levels: {} };
  for (let z = c.z - 1; z <= c.z + 3; z++) {
    const cells: Record<string, PlacedTile[]> = {};
    for (let y = c.y - 4; y <= c.y + 4; y++)
      for (let x = c.x - 4; x <= c.x + 4; x++) {
        const stack = b.board.get(x, y, z);
        if (stack) cells[coordKey(x, y)] = stack;
      }
    flat.levels[String(z)] = cells;
  }
  return canPlace(chunkifyMap(flat), c.x, c.y, c.z, b.tilesById[tileId]!, b.tilesById, "s").ok;
}

function ringCells(
  b: Builder,
  c: Cell,
  isGround: (x: number, y: number, z: number) => boolean,
): Cell[] {
  const out: Cell[] = [];
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) {
      const d = Math.hypot(dx, dy);
      if (d < RING_INNER || d > RING_OUTER) continue;
      if (isGround(c.x + dx, c.y + dy, c.z)) out.push({ x: c.x + dx, y: c.y + dy, z: c.z });
    }
  return out;
}

const FLOWERS = ["red-flowers", "yellow-flowers"] as const;

/**
 * The ring of flowers that marks where a wisp appears (`docs/notes.md`, *The
 * forest wisps*): flowers between 1.5 and 2.5 cells out, in whichever colour
 * is rarer nearby, and none loose inside 3.2 cells to blur it.
 */
function ringWithFlowers(
  b: Builder,
  c: Cell,
  isGround: (x: number, y: number, z: number) => boolean,
) {
  const { board } = b;
  const isFlower = (p: PlacedTile) => (FLOWERS as readonly string[]).includes(p.tileId);
  const count = { "red-flowers": 0, "yellow-flowers": 0 };
  for (let dy = -10; dy <= 10; dy++)
    for (let dx = -10; dx <= 10; dx++)
      for (const p of board.get(c.x + dx, c.y + dy, c.z) ?? [])
        if (isFlower(p)) count[p.tileId as keyof typeof count]++;
  const colour = count["red-flowers"] <= count["yellow-flowers"] ? "red-flowers" : "yellow-flowers";
  for (let dy = -4; dy <= 4; dy++)
    for (let dx = -4; dx <= 4; dx++) {
      const d = Math.hypot(dx, dy);
      const x = c.x + dx;
      const y = c.y + dy;
      const stack = board.get(x, y, c.z);
      if (d > RING_CLEAR || !stack) continue;
      if (d >= RING_INNER && d <= RING_OUTER && isGround(x, y, c.z)) {
        board.set(x, y, c.z, [...stack.filter((p) => !isFlower(p)), tile(colour)]);
      } else if (stack.some(isFlower)) {
        board.set(
          x,
          y,
          c.z,
          stack.filter((p) => !isFlower(p)),
        );
      }
    }
}

function hashName(name: string): number {
  let h = 2166136261;
  for (let k = 0; k < name.length; k++) h = Math.imul(h ^ name.charCodeAt(k), 16777619);
  return h >>> 0;
}
