import { describe, expect, it } from "bun:test";
import { emptyEquipment } from "../../app/game/equipment";
import type { ActorSnapshot, GameSnapshot } from "../../app/game/GameSession";
import { emptyMap, replaceStack } from "../../app/lib/mapData";
import {
  HEIGHT_PER_LEVEL,
  normalizeTileDef,
  type MapFile,
  type TileDef,
} from "../../app/lib/types";
import { buildBotView, renderBotView, type BotView } from "./view";

/**
 * What a bot is shown.
 *
 * A synthetic catalogue and a board built by hand, on the terms every other
 * pure-geometry suite here is written under — heights and `lightPassing` are
 * what this reasons about, and six named tiles say what a case is about where a
 * real catalogue would leave the reader guessing which of a hundred fields
 * mattered.
 *
 * The four claims worth pinning are the ones a reader of the prompt has to be
 * able to trust: that every character in the grid is in the legend, that a cell
 * with something in the way of it reads as unknown rather than as ground, that a
 * body in the grid is the same body as the one in the list, and that a
 * coordinate read off the ruler names the cell it appears to name. The last is
 * the one that would fail silently and expensively: `walk_to` takes those
 * numbers, and a ruler off by one is a body walking somewhere nobody asked for.
 */

const frame = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

function tile(
  partial: Record<string, unknown> & Pick<TileDef, "id" | "height">,
): TileDef {
  return normalizeTileDef({
    name: partial.id,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    ...partial,
  });
}

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "wall", height: HEIGHT_PER_LEVEL, walkable: false }),
  tile({ id: "crate", height: 2, walkable: false }),
  /** A full level you can stand on, so the level above it has a floor. */
  tile({ id: "block", height: HEIGHT_PER_LEVEL }),
  /** Light-passing, as every body in this game is, so it never walls itself in. */
  tile({
    id: "player",
    // A shade under a full level, so a roof leaves room to stand on a stool.
    height: 3,
    actor: true,
    walkable: false,
    lightPassing: true,
  }),
  tile({
    id: "rat",
    height: 1,
    actor: true,
    walkable: false,
    lightPassing: true,
  }),
];

const tilesById = Object.fromEntries(tiles.map((def) => [def.id, def]));

/** Flat grass over a square, and nothing standing on any of it. */
function field(half: number): MapFile {
  let map = emptyMap();
  for (let x = -half; x <= half; x++) {
    for (let y = -half; y <= half; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  return map;
}

function put(map: MapFile, x: number, y: number, tileId: string): MapFile {
  return replaceStack(map, x, y, 0, [{ tileId: "grass" }, { tileId }]);
}

function actor(
  id: string,
  tileId: string,
  x: number,
  y: number,
  hp: number | null = null,
): ActorSnapshot {
  return {
    id,
    tileId,
    x,
    y,
    z: 0,
    stackIndex: 1,
    direction: "s",
    walk: null,
    fall: null,
    walkProgress: 0,
    fallProgress: 0,
    slide: null,
    slideProgress: 0,
    strike: null,
    strikeProgress: 0,
    hp,
    maxHp: hp === null ? null : 6,
    rating: null,
    statuses: [],
    carriedLights: [],
  };
}

function snapshotOf(map: MapFile, actors: ActorSnapshot[]): GameSnapshot {
  return {
    map,
    self: actors[0]!,
    actors,
    targetId: null,
    attacking: false,
    damage: [],
    projectiles: [],
    equipment: emptyEquipment(),
    tags: [],
    conversation: null,
    extracting: null,
    masteryXp: {},
    chats: [],
    noises: [],
  };
}

/** The glyph the view has at a world coordinate. */
function glyphAt(view: BotView, x: number, y: number): string {
  return view.rows[y - view.bounds.minY]![x - view.bounds.minX]!;
}

/** A board with the bot at the origin, and whatever else is asked for. */
function viewOf(
  map: MapFile,
  others: ActorSnapshot[] = [],
  radius = 6,
): BotView {
  const self = actor("me", "player", 0, 0);
  // Every body on the board carries an owner, which is what the board's own
  // rule for "this is somebody" reads — see `app/game/actors`. Placing them
  // without one would make them scenery, and the grid would be right for the
  // wrong reason.
  const board = replaceStack(map, 0, 0, 0, [
    { tileId: "grass" },
    { tileId: "player", owner: self.id },
  ]);
  const withOthers = others.reduce(
    (acc, other) =>
      replaceStack(acc, other.x, other.y, 0, [
        { tileId: "grass" },
        { tileId: other.tileId, owner: other.id },
      ]),
    board,
  );
  return buildBotView({
    map: withOthers,
    tilesById,
    snapshot: snapshotOf(withOthers, [self, ...others]),
    events: [],
    radius,
  });
}

describe("the legend", () => {
  it("covers every character the grid draws", () => {
    let map = field(6);
    map = put(map, 2, 0, "wall");
    map = put(map, -2, -2, "crate");
    map = put(map, 3, 3, "block");
    const view = viewOf(map, [actor("rat-1", "rat", 0, -3, 4)]);

    const named = new Set([
      "@",
      "?",
      ".",
      ...view.legend.map((entry) => entry.glyph),
      ...view.bodies.map((body) => body.glyph),
    ]);
    for (const row of view.rows) {
      for (const glyph of row) {
        expect(named.has(glyph)).toBe(true);
      }
    }
  });

  it("names only what is in this view", () => {
    // `block` is on the board but outside the window, so it must not be named.
    let map = field(20);
    map = put(map, 15, 0, "block");
    const view = viewOf(map, [], 3);

    expect(view.legend.map((entry) => entry.tileId)).toEqual(["grass"]);
  });
});

describe("what can be seen", () => {
  it("reads a cell behind a wall as unknown", () => {
    let map = field(6);
    for (let y = -6; y <= 6; y++) map = put(map, 2, y, "wall");
    const view = viewOf(map);

    // The wall itself is looked *at*, so it is named.
    expect(view.legend.map((e) => e.tileId)).toContain("wall");
    expect(glyphAt(view, 2, 0)).toBe(glyphFor(view, "wall"));
    // Everything behind it is not.
    expect(glyphAt(view, 3, 0)).toBe("?");
    expect(glyphAt(view, 5, 2)).toBe("?");
  });

  it("reads a column with nothing in it as nothing, not as unknown", () => {
    // A gap in the floor is the case `step` exists for: the model has to be able
    // to tell "I cannot see into this" from "there is no ground here".
    let map = field(6);
    map = replaceStack(map, -2, 0, 0, []);
    const view = viewOf(map);

    expect(glyphAt(view, -2, 0)).toBe(".");
  });

  it("leaves a body it cannot see out of the grid and out of the list", () => {
    let map = field(6);
    for (let y = -6; y <= 6; y++) map = put(map, 2, y, "wall");
    const hidden = actor("rat-1", "rat", 4, 0, 4);
    const view = viewOf(map, [hidden]);

    expect(view.bodies).toEqual([]);
    expect(glyphAt(view, 4, 0)).toBe("?");
  });
});

describe("the grid and the body list", () => {
  it("put every body in both, under one glyph", () => {
    const rat = actor("rat-1", "rat", 1, -2, 4);
    const deer = actor("deer-1", "rat", -3, 1, 6);
    const view = viewOf(field(6), [rat, deer]);

    expect(view.bodies).toHaveLength(2);
    for (const body of view.bodies) {
      expect(glyphAt(view, body.x, body.y)).toBe(body.glyph);
    }
    expect(view.bodies.map((b) => b.glyph)).toEqual(["A", "B"]);
    expect(view.bodies[0]!.distance).toBe(2);
  });

  it("draws the bot itself, whatever is standing with it", () => {
    const view = viewOf(field(6));

    expect(glyphAt(view, 0, 0)).toBe("@");
    expect(view.self).toMatchObject({ x: 0, y: 0, z: 0 });
  });
});

describe("the ruler", () => {
  it("names the cell it appears to name", () => {
    let map = field(6);
    map = put(map, -5, 3, "crate");
    map = put(map, 5, -4, "wall");
    const view = viewOf(map, [actor("rat-1", "rat", 0, 5, 4)]);
    const read = readRendered(renderBotView(view));

    for (let y = view.bounds.minY; y <= view.bounds.maxY; y++) {
      for (let x = view.bounds.minX; x <= view.bounds.maxX; x++) {
        expect(read(x, y)).toBe(glyphAt(view, x, y));
      }
    }
  });
});

function glyphFor(view: BotView, tileId: string): string {
  return view.legend.find((entry) => entry.tileId === tileId)!.glyph;
}

/**
 * Read the rendered prompt back the way the model has to read it.
 *
 * Deliberately naive: it finds the row whose left-hand label is the `y` asked
 * for, finds the column by looking up the `x` on the tick ruler above the grid,
 * and takes the character there. Anything cleverer would be re-deriving the
 * layout from the code under test, and the point of this is that a reader with
 * only the text in front of them lands on the same cell.
 */
function readRendered(text: string): (x: number, y: number) => string {
  const lines = text.split("\n");
  const start = lines.indexOf("## What you can see") + 1;
  const labelLine = lines[start]!;
  const tickLine = lines[start + 1]!;

  // Where each labelled tick sits, read off the two ruler rows.
  const columnOf = new Map<number, number>();
  for (let i = 0; i < tickLine.length; i++) {
    if (tickLine[i] !== "|") continue;
    const label = labelLine.slice(i).match(/^-?\d+/)![0];
    columnOf.set(Number(label), i);
  }
  const [anchorX, anchorColumn] = [...columnOf][0]!;

  const rows = new Map<number, string>();
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i]!;
    const label = line.match(/^\s*(-?\d+) /);
    if (!label) break;
    rows.set(Number(label[1]), line);
  }

  return (x, y) => rows.get(y)![anchorColumn + (x - anchorX)]!;
}
