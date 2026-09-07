/**
 * Raises the wilderness north of the city, and the goblin camp at the end of it.
 *
 *   bun scripts/raise-goblin-camp.ts            # raise it, then check it
 *   bun scripts/raise-goblin-camp.ts --verify   # only check what is there
 *
 * The world used to stop at the wall on `y = -38`: an unbroken run of brick
 * from `x = -39` to `x = 47` with no gate in it, and nothing but void beyond.
 * This opens a way through and puts two hundred cells of wilderness on the
 * other side — a track that wanders north through woodland, with snakes and
 * rats along it and one wolf somewhere in the middle — ending in an open field
 * where the goblins have made a camp.
 *
 * ## The distance is the point
 *
 * The camp was fifteen cells beyond the gate to begin with, which made it a
 * part of town that happened to have goblins in it. Two hundred cells is long
 * enough that getting there is a journey you decide to make: you pass things on
 * the way, you can be worn down before you arrive, and turning back is a real
 * choice rather than three steps.
 *
 * That is also why the wilderness is a *track* and not a field. Two hundred
 * rows at the width of the town wall would be eleven thousand cells of nothing,
 * most of which nobody would ever walk on. A winding corridor with woodland
 * either side is a fraction of that and reads as further, because you cannot
 * see where it ends.
 *
 * ## Why a script rather than the editor
 *
 * Seven thousand cells is not a thing to place by hand, but that is not the
 * reason. The reason is that the place has *rules* — the wood is a border, the
 * track is continuous, nothing stands in the water, the wildlife keeps clear of
 * the fire — and rules written down are checkable. `--verify` re-runs every one
 * of them against whatever is on disk, so an afternoon of hand-editing in the
 * in-game editor can be checked rather than trusted, and a regenerate is a diff
 * rather than a mystery.
 *
 * It follows `carve-caves.ts` in that and in nearly everything else. What it
 * does *not* follow is the cellular automaton: a cave is a shape nobody chose
 * and a road is a thing somebody laid, so this is named regions and a wandering
 * centre-line rather than noise plus a flood.
 *
 * ## The two rules it exists to keep
 *
 * **Everything is reachable from the gate.** The whole of it is flooded from
 * the gate cell after it is drawn, and anything the flood does not reach is a
 * mistake — a hut whose door opens into a tree, a stretch of track pinched shut
 * by its own woodland, a rat in a pocket of forest. The flood runs before a
 * single body is placed, and bodies are only ever put on cells it reached.
 *
 * **Nothing is placed on top of anything.** Every write goes through
 * {@link ground}, which replaces the whole stack rather than pushing onto it,
 * so running this twice is the same as running it once. That is what makes
 * `--verify` worth anything: a second run that stacked a second tree on every
 * tree would pass every check while doubling the map.
 */
import { chunkifyMap, serializeMap } from "../app/lib/mapData";
import { coordKey, normalizeTileDef } from "../app/lib/types";
import type { Direction, TileDef } from "../app/lib/types";
import { tilesByIdFromList } from "../app/lib/validation";

type Placed = { tileId: string; direction?: Direction };
type Flat = { version: 1; levels: Record<string, Record<string, Placed[]>> };

const MAP_PATH = "data/map.json";
const TILES_PATH = "data/tiles.json";
const verifyOnly = process.argv.includes("--verify");

// ---------------------------------------------------------------------------
// The place
// ---------------------------------------------------------------------------

/**
 * The track out of the city, and everything about how it is drawn.
 *
 * Up here rather than spread through the code for `carve-caves.ts`'s reason:
 * the next one of these should be a change to this block and not a second copy
 * of the file.
 */
const WILD = {
  /**
   * Where the wall is opened, and how wide.
   *
   * Immediately west of the stream that already crosses it, so the way north is
   * the bank of a river you can see rather than a hole in a wall you have to
   * find. Three cells: wide enough to read as a gate from a distance, narrow
   * enough that the wall still reads as a wall.
   */
  gate: { x: -3, cells: 3, wallY: -38 },

  /** The track's first row and its last, inclusive. Two hundred cells of it. */
  fromY: -39,
  toY: -238,

  /**
   * How far the walkable track reaches either side of its centre, and how far
   * the woodland reaches beyond that.
   *
   * The track is wide enough to fight on and narrow enough that the trees are
   * always in view. What is *drawn* is the track plus its margins, so the
   * corridor is `(open + wood) * 2` cells across and everything outside it is
   * void the player never reaches — which is what keeps two hundred rows
   * affordable.
   */
  open: 7,
  wood: 5,

  /** How far the centre-line may wander from the gate, either way. */
  wanderTo: 26,

  /** Trees loose on the track itself, as a fraction of its cells. */
  scatter: 0.03,

  /**
   * The pools the stream leaves along the way.
   *
   * The stream that crosses the wall is not carried the whole two hundred
   * cells: a river running beside a track for its entire length is a wall with
   * water in it, and every crossing would have to be authored. It appears as
   * standing water instead, in a few places the track happens to pass.
   */
  pools: 5,
  poolRadius: 4,
} as const;

/**
 * The camp at the end of it, as an open field with the fire at its centre.
 *
 * The huts stand on a ring around the fire, and that is the one arrangement
 * worth being explicit about: the first version put them at authored
 * coordinates and the fire wherever was left over, and it ended up against a
 * doorway. A ring puts the fire in the middle by construction.
 */
const CAMP = {
  /** The clearing's first row and last, north of where the track ends. */
  fromY: -239,
  toY: -288,
  /** How far the clearing reaches either side of the track's last centre. */
  halfWidth: 24,
  /** Bare trodden ground within this many cells of the fire. */
  trodden: 14,
  /** How far the huts stand from the fire. */
  hutRing: 9,
  huts: 6,
  /** Woodland round the clearing's edge, as cells deep. */
  wood: 5,
} as const;

/** How many of each body, and the three places they belong. */
const BODIES = {
  goblins: 9,
  /**
   * One, and that is what makes it the thing on this road worth being afraid
   * of rather than a hazard. A pack would be a wall across the middle of the
   * walk; a wolf you *might* meet is a reason to keep looking at the trees.
   */
  wolves: 1,
  snakes: 6,
  rats: 8,
  deer: 4,
  rabbits: 6,
} as const;

/**
 * One seed per decision that takes dice, so adding trees cannot move the
 * animals. The same reason `carve-caves.ts` carries a seed per floor.
 */
const SEEDS = {
  track: 0x57a1,
  wood: 0x60b1,
  scatter: 0x71ee,
  pools: 0x9004,
  bodies: 0xb0d1,
} as const;

/** How far from the fire a deer or a rabbit is willing to graze. */
const WILDLIFE_KEEPS_AWAY = 18;

/** How far from the fire the goblins themselves are scattered. */
const GOBLINS_KEEP_TO = 13;

/** How far down the track the wolf is put, as a fraction of its length. */
const WOLF_AT = 0.5;

/** How far past the gate the track is left empty, so leaving town is not a fight. */
const QUIET_AFTER_GATE = 12;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const map: Flat = JSON.parse(await Bun.file(MAP_PATH).text());
const tiles: TileDef[] = (
  JSON.parse(await Bun.file(TILES_PATH).text()) as unknown[]
).map((raw) => normalizeTileDef(raw));
const tilesById = tilesByIdFromList(tiles);

const level = (z: number) => (map.levels[String(z)] ??= {});
const stackAt = (z: number, x: number, y: number): Placed[] =>
  level(z)[coordKey(x, y)] ?? [];

/**
 * Put a stack down, replacing whatever was there.
 *
 * Replacing rather than appending is the whole of why this script is safe to
 * run twice. @see the note at the top of the file.
 */
function ground(z: number, x: number, y: number, stack: Placed[]) {
  if (stack.length === 0) delete level(z)[coordKey(x, y)];
  else level(z)[coordKey(x, y)] = stack;
}

/** Deterministic PRNG, on `carve-caves.ts`'s terms: this is a pure function of its seeds. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STEP: Record<Direction, { x: number; y: number }> = {
  n: { x: 0, y: -1 },
  e: { x: 1, y: 0 },
  s: { x: 0, y: 1 },
  w: { x: -1, y: 0 },
};

// ---------------------------------------------------------------------------
// Drawing it
// ---------------------------------------------------------------------------

/**
 * The track's centre, one x per row, wandering north.
 *
 * A drunk walk with a leash: it turns about a third of the time and is held
 * within {@link WILD.wanderTo} of the gate, so the track bends often enough to
 * hide its own end and never wanders so far that the camp is somewhere else
 * entirely.
 */
function trackCourse(): Map<number, number> {
  const random = mulberry32(SEEDS.track);
  const course = new Map<number, number>();
  let x = WILD.gate.x;
  for (let y = WILD.fromY; y >= CAMP.toY; y--) {
    course.set(y, x);
    const roll = random();
    if (roll < 0.17) x -= 1;
    else if (roll < 0.34) x += 1;
    x = Math.max(
      WILD.gate.x - WILD.wanderTo,
      Math.min(WILD.gate.x + WILD.wanderTo, x),
    );
  }
  return course;
}

/** Where the clearing's fire is: the last thing the track leads to. */
function fireAt(course: Map<number, number>): { x: number; y: number } {
  const y = Math.round((CAMP.fromY + CAMP.toY) / 2);
  return { x: course.get(y) ?? WILD.gate.x, y };
}

/** The pools along the track, as centres. */
function poolCentres(course: Map<number, number>): { x: number; y: number }[] {
  const random = mulberry32(SEEDS.pools);
  const out: { x: number; y: number }[] = [];
  const span = WILD.fromY - WILD.toY;
  for (let i = 0; i < WILD.pools; i++) {
    // Spread down the length rather than placed at random, so no stretch of the
    // walk is all water and none of it is all dry.
    const y = WILD.fromY - Math.round(((i + 0.5) / WILD.pools) * span);
    const centre = course.get(y) ?? WILD.gate.x;
    // Off to one side, so a pool never sits astride the track and cuts it.
    const side = random() < 0.5 ? -1 : 1;
    out.push({ x: centre + side * (WILD.open - 1), y });
  }
  return out;
}

/**
 * What this cell is: open ground, woodland, or nowhere at all.
 *
 * One function for both regions, because everything downstream — the flood, the
 * checks, the scatter — wants "is this somewhere I drew" and not "which half".
 */
function bounds(
  course: Map<number, number>,
  x: number,
  y: number,
): { open: boolean; wood: boolean } | null {
  // `>` and not `>=`: `fromY` is the track's own first row, not the first row
  // south of it.
  if (y > WILD.fromY) return null;
  const centre = course.get(y);
  if (centre === undefined) return null;
  const fromX = Math.abs(x - centre);

  if (y >= CAMP.fromY) {
    return { open: fromX <= WILD.open, wood: fromX <= WILD.open + WILD.wood };
  }
  // In the clearing the woodland is a border round all of it rather than two
  // banks, so the depth is measured from whichever edge is nearest.
  const fromEdge = Math.min(CAMP.halfWidth - fromX, y - CAMP.toY);
  return {
    open: fromX <= CAMP.halfWidth && fromEdge >= CAMP.wood,
    wood: fromX <= CAMP.halfWidth && y >= CAMP.toY,
  };
}

/** Lay the ground, the woodland, the pools and the trees. */
function raiseGround(course: Map<number, number>): Set<string> {
  const woodRandom = mulberry32(SEEDS.wood);
  const scatterRandom = mulberry32(SEEDS.scatter);
  const pools = poolCentres(course);
  const open = new Set<string>();

  const spanX = CAMP.halfWidth + WILD.wanderTo + 2;
  for (let y = CAMP.toY; y <= WILD.fromY; y++) {
    for (let x = WILD.gate.x - spanX; x <= WILD.gate.x + spanX; x++) {
      const where = bounds(course, x, y);
      if (!where?.wood) continue;
      const base: Placed = { tileId: "grass-2" };

      const inPool = pools.some(
        (p) => (p.x - x) ** 2 + (p.y - y) ** 2 <= WILD.poolRadius ** 2,
      );
      if (inPool && where.open) {
        ground(0, x, y, [base, { tileId: "water" }]);
        continue;
      }

      // Both dice are rolled for every cell whatever lands, so moving the
      // woodland's edge cannot move every tree on the track. The same rule a
      // kit row is under. @see docs/notes.md, "Every row costs exactly one draw"
      const wooded = !where.open && woodRandom() < 0.82;
      const scattered = scatterRandom() < WILD.scatter;
      if (wooded || (where.open && scattered)) {
        ground(0, x, y, [base, { tileId: "tree" }]);
        continue;
      }
      ground(0, x, y, [base]);
      open.add(coordKey(x, y));
    }
  }
  return open;
}

/**
 * Knock the gate through the wall and lay a track through it.
 *
 * The wall is two `brick-slab` on level 0 and more on level 1, which together
 * come to more than a body can climb — so opening it means clearing both
 * levels, not just the one you can see.
 */
function openGate(open: Set<string>) {
  const { x, cells, wallY } = WILD.gate;
  for (let i = 0; i < cells; i++) {
    const gx = x + i;
    ground(0, gx, wallY, [{ tileId: "dirt" }]);
    ground(1, gx, wallY, []);
    open.add(coordKey(gx, wallY));
    // A short run of track either side, so the gate reads as a way somebody
    // uses rather than as a hole somebody made.
    for (let dy = 1; dy <= 2; dy++) {
      ground(0, gx, wallY + dy, [{ tileId: "grass-2" }, { tileId: "dirt" }]);
      ground(0, gx, wallY - dy, [{ tileId: "grass-2" }, { tileId: "dirt" }]);
      open.add(coordKey(gx, wallY - dy));
    }
  }
}

/**
 * One goblin hut: a ring of wall on a floor, a door, and planks over the top.
 *
 * The town's grammar at the smallest size that still has an inside, with one
 * deliberate difference. A town house is roofed with `roof-2` — tiled, pitched,
 * plainly built by somebody with a trade — and a hut roofed the same way read
 * as a cottage that goblins had moved into. `wooden-floor` laid flat over the
 * walls reads as planks thrown across, which is what these are.
 */
function raiseHut(
  at: { x: number; y: number },
  doorFacing: Direction,
  open: Set<string>,
) {
  const SIZE = 4;
  const last = SIZE - 1;
  // Off-centre, and which side it sits varies with where the hut is, so six of
  // them on a ring do not all have their door in the same place.
  const offset = 1 + (Math.abs(at.x + at.y) % 2);
  const door =
    doorFacing === "n"
      ? { x: at.x + offset, y: at.y }
      : doorFacing === "s"
        ? { x: at.x + offset, y: at.y + last }
        : doorFacing === "w"
          ? { x: at.x, y: at.y + offset }
          : { x: at.x + last, y: at.y + offset };

  for (let dy = 0; dy < SIZE; dy++) {
    for (let dx = 0; dx < SIZE; dx++) {
      const x = at.x + dx;
      const y = at.y + dy;
      const edge = dx === 0 || dy === 0 || dx === last || dy === last;
      if (x === door.x && y === door.y) {
        ground(0, x, y, [
          { tileId: "dirt" },
          { tileId: "wooden-floor" },
          { tileId: "door-closed" },
        ]);
        open.add(coordKey(x, y));
      } else if (edge) {
        ground(0, x, y, [
          { tileId: "dirt" },
          { tileId: "wooden-floor" },
          { tileId: "sw2" },
        ]);
        open.delete(coordKey(x, y));
      } else {
        ground(0, x, y, [{ tileId: "wooden-floor" }]);
        open.add(coordKey(x, y));
      }
      // **Planks laid flat, and deliberately not a filled storey.** The town's
      // houses fill the level above with `plaster` and cap it with `roof-2`,
      // which is what makes them read as built. Filling this one — two
      // `wooden-box` and a plank on top — was tried and is worse: a hut with
      // something *in* the level above the player is caught by the roof-cut and
      // drawn translucent, so six huts became six ghosts. A height-0 lid sits
      // on the walls and stays solid.
      ground(1, x, y, [{ tileId: "wooden-floor" }]);
    }
  }
}

/** Tread the clearing bare, ring it with huts and light the fire in the middle. */
function raiseCamp(course: Map<number, number>, open: Set<string>) {
  const fire = fireAt(course);

  for (let y = fire.y - CAMP.trodden; y <= fire.y + CAMP.trodden; y++) {
    for (let x = fire.x - CAMP.trodden; x <= fire.x + CAMP.trodden; x++) {
      if (!bounds(course, x, y)?.open) continue;
      if ((x - fire.x) ** 2 + (y - fire.y) ** 2 > CAMP.trodden ** 2) continue;
      // Trodden earth, which also clears the trees the scatter put here: a camp
      // is a place somebody cut back.
      ground(0, x, y, [{ tileId: "grass-2" }, { tileId: "dirt" }]);
      open.add(coordKey(x, y));
    }
  }

  for (let i = 0; i < CAMP.huts; i++) {
    const angle = (i / CAMP.huts) * Math.PI * 2;
    const hut = {
      x: Math.round(fire.x + Math.cos(angle) * CAMP.hutRing) - 2,
      y: Math.round(fire.y + Math.sin(angle) * CAMP.hutRing) - 2,
    };
    // Doors face the fire, which is what makes the ring read as a camp rather
    // than as six sheds that happen to be near each other.
    const facing: Direction =
      Math.abs(Math.cos(angle)) > Math.abs(Math.sin(angle))
        ? Math.cos(angle) > 0
          ? "w"
          : "e"
        : Math.sin(angle) > 0
          ? "n"
          : "s";
    raiseHut(hut, facing, open);
  }

  // Which they do not cook on. It is a fire in a camp, and the only thing out
  // here that gives off light after dark.
  ground(0, fire.x, fire.y, [
    { tileId: "grass-2" },
    { tileId: "dirt" },
    { tileId: "flame" },
  ]);
  open.delete(coordKey(fire.x, fire.y));
}

// ---------------------------------------------------------------------------
// Checking it, then filling it
// ---------------------------------------------------------------------------

/**
 * Everywhere a body can walk to from the gate.
 *
 * Run before anything is placed, because a body on a cell the flood never
 * reached is a body nobody will ever meet — and, worse, a goblin that cannot
 * get out of the wood it spawned in. On a track two hundred cells long with a
 * wandering centre this is the check that earns its keep: a bend that pinches
 * shut against its own woodland is invisible in the config and obvious here.
 *
 * The walk is the crude one on purpose: level 0 only, and a cell is passable
 * when the tile on top of it is one a body fits on. Everything here is flat, so
 * the climb rules `canWalk` applies have nothing to say.
 */
function reachableFromGate(course: Map<number, number>): Set<string> {
  const start = coordKey(WILD.gate.x, WILD.gate.wallY);
  const seen = new Set<string>([start]);
  const queue = [{ x: WILD.gate.x, y: WILD.gate.wallY }];

  const passable = (x: number, y: number) => {
    if (y !== WILD.gate.wallY && !bounds(course, x, y)) return false;
    const stack = stackAt(0, x, y);
    if (stack.length === 0) return false;
    // A body is not terrain — `docs/notes.md` says so and the walk loop agrees,
    // so a goblin standing in a doorway is somewhere a route goes through
    // rather than a wall across it. Without this the flood stops at every body
    // it meets, and then reports the cell that body is standing on as one it
    // could not reach, which is the most confusing way possible to say nothing.
    const terrain = stack.filter(
      (placed) => tilesById[placed.tileId]?.kind !== "battler",
    );
    const top = terrain[terrain.length - 1];
    if (!top) return false;
    return tilesById[top.tileId]?.walkable !== false;
  };

  while (queue.length > 0) {
    const here = queue.pop()!;
    for (const dir of ["n", "e", "s", "w"] as Direction[]) {
      const x = here.x + STEP[dir].x;
      const y = here.y + STEP[dir].y;
      const key = coordKey(x, y);
      if (seen.has(key) || !passable(x, y)) continue;
      seen.add(key);
      queue.push({ x, y });
    }
  }
  return seen;
}

type Body = { tileId: string; x: number; y: number };

/**
 * Scatter the bodies over cells the flood reached.
 *
 * Three populations with three rules. Goblins keep near their fire; the
 * wildlife keeps well away from it, because a deer authored inside the camp is
 * a deer that spends its life fleeing; and what lives on the track lives on the
 * track. `home` is the cell a body is authored on, so where a body starts is
 * where it comes back to for the rest of the world's life. @see `residentHome`
 */
function populate(course: Map<number, number>, reachable: Set<string>): Body[] {
  const random = mulberry32(SEEDS.bodies);
  const fire = fireAt(course);
  const taken = new Set<string>();
  const bodies: Body[] = [];

  const toFire = (x: number, y: number) =>
    Math.abs(x - fire.x) + Math.abs(y - fire.y);

  const place = (
    tileId: string,
    fromY: number,
    toY: number,
    wants: (x: number, y: number) => boolean = () => true,
  ) => {
    // Bounded rather than looping until it lands: a rule nothing satisfies must
    // fail the run rather than hang it.
    for (let tries = 0; tries < 6000; tries++) {
      const y = toY + Math.floor(random() * (fromY - toY + 1));
      const centre = course.get(y);
      if (centre === undefined) continue;
      const reach = CAMP.halfWidth;
      const x = centre - reach + Math.floor(random() * (reach * 2 + 1));
      const key = coordKey(x, y);
      if (taken.has(key) || !reachable.has(key) || !wants(x, y)) continue;
      taken.add(key);
      bodies.push({ tileId, x, y });
      return;
    }
    throw new Error(`nowhere left to put a ${tileId}`);
  };

  for (let i = 0; i < BODIES.goblins; i++) {
    place("goblin", CAMP.fromY, CAMP.toY, (x, y) => toFire(x, y) <= GOBLINS_KEEP_TO);
  }
  for (let i = 0; i < BODIES.deer; i++) {
    place("deer", CAMP.fromY, CAMP.toY, (x, y) => toFire(x, y) >= WILDLIFE_KEEPS_AWAY);
  }
  for (let i = 0; i < BODIES.rabbits; i++) {
    place("rabbit", CAMP.fromY, CAMP.toY, (x, y) => toFire(x, y) >= WILDLIFE_KEEPS_AWAY);
  }

  // The track's own, kept off the first stretch beyond the gate so that walking
  // out of the city is not immediately a fight.
  const trackFrom = WILD.fromY - QUIET_AFTER_GATE;
  for (let i = 0; i < BODIES.snakes; i++) place("snake", trackFrom, WILD.toY);
  for (let i = 0; i < BODIES.rats; i++) place("rat", trackFrom, WILD.toY);

  // The wolf, halfway. @see BODIES.wolves for why there is one of it.
  const wolfY = Math.round(WILD.fromY - (WILD.fromY - WILD.toY) * WOLF_AT);
  for (let i = 0; i < BODIES.wolves; i++) place("wolf", wolfY + 8, wolfY - 8);

  return bodies;
}

function placeBodies(bodies: readonly Body[]) {
  for (const body of bodies) {
    ground(0, body.x, body.y, [
      ...stackAt(0, body.x, body.y),
      { tileId: body.tileId, direction: "s" },
    ]);
  }
}

/** Everything that must be true of it on disk. */
function verify(course: Map<number, number>): string[] {
  const problems: string[] = [];
  const reachable = reachableFromGate(course);
  const fire = fireAt(course);

  let cells = 0;
  const bodies = new Map<string, number>();
  const spanX = CAMP.halfWidth + WILD.wanderTo + 2;
  for (let y = CAMP.toY; y <= WILD.fromY; y++) {
    for (let x = WILD.gate.x - spanX; x <= WILD.gate.x + spanX; x++) {
      if (!bounds(course, x, y)?.wood) continue;
      const stack = stackAt(0, x, y);
      if (stack.length === 0) {
        problems.push(`hole at ${x},${y}`);
        continue;
      }
      cells++;
      for (const placed of stack) {
        if (!tilesById[placed.tileId]) {
          problems.push(`unknown tile "${placed.tileId}" at ${x},${y}`);
        }
        if (tilesById[placed.tileId]?.kind === "battler") {
          bodies.set(placed.tileId, (bodies.get(placed.tileId) ?? 0) + 1);
          if (!reachable.has(coordKey(x, y))) {
            problems.push(`${placed.tileId} at ${x},${y} is walled off from the gate`);
          }
        }
      }
      const ids = stack.map((p) => p.tileId);
      if (ids.includes("water") && ids.length > 2) {
        problems.push(`something is standing in the water at ${x},${y}`);
      }
    }
  }

  // The way in, and the way *along*. Without the second of these every other
  // check can pass on a track that pinches shut sixty cells up, which is the
  // failure a wandering centre-line is most likely to produce.
  if (!reachable.has(coordKey(WILD.gate.x, WILD.gate.wallY - 1))) {
    problems.push("the wilderness does not reach its own gate");
  }
  for (const [label, at] of [
    ["a quarter of the way", Math.round(WILD.fromY * 0.75 + WILD.toY * 0.25)],
    ["halfway", Math.round((WILD.fromY + WILD.toY) / 2)],
    ["the end of the track", WILD.toY],
    ["the camp", fire.y],
  ] as const) {
    const centre = course.get(at)!;
    const reached = Array.from({ length: WILD.open * 2 + 1 }).some((_, i) =>
      reachable.has(coordKey(centre - WILD.open + i, at)),
    );
    if (!reached) {
      problems.push(`the track does not carry on as far as ${label} (y ${at})`);
    }
  }
  if (!reachable.has(coordKey(fire.x, fire.y - 1))) {
    problems.push("the fire is not somewhere anybody can walk up to");
  }
  // The fire belongs to the camp rather than to one of its huts, which is what
  // went wrong the first time and is not a thing an eye should have to catch.
  for (const neighbour of Object.values(STEP)) {
    const beside = stackAt(0, fire.x + neighbour.x, fire.y + neighbour.y);
    if (beside.some((p) => p.tileId === "door-closed")) {
      problems.push("the fire is in a doorway");
    }
  }

  for (const [tileId, want] of [
    ["goblin", BODIES.goblins],
    ["wolf", BODIES.wolves],
    ["snake", BODIES.snakes],
    ["rat", BODIES.rats],
    ["deer", BODIES.deer],
    ["rabbit", BODIES.rabbits],
  ] as const) {
    const got = bodies.get(tileId) ?? 0;
    if (got !== want) problems.push(`${got} ${tileId} out there, expected ${want}`);
  }

  console.log(
    `${cells} cells, ${reachable.size} reachable, fire at ${fire.x},${fire.y}; ` +
      [...bodies]
        .sort()
        .map(([k, n]) => `${n} ${k}`)
        .join(", "),
  );
  return problems;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const course = trackCourse();

if (!verifyOnly) {
  const open = raiseGround(course);
  openGate(open);
  raiseCamp(course, open);
  const reachable = reachableFromGate(course);
  const bodies = populate(course, reachable);
  placeBodies(bodies);
  await Bun.write(MAP_PATH, serializeMap(chunkifyMap(map as never)));
  console.log(`raised it: ${open.size} open cells, ${bodies.length} bodies`);
}

const problems = verify(course);
if (problems.length > 0) {
  for (const problem of problems.slice(0, 20)) console.error(" !", problem);
  if (problems.length > 20) console.error(` ! …and ${problems.length - 20} more`);
  process.exit(1);
}
console.log("it checks out");
