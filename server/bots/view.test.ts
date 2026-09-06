import { describe, expect, it } from "bun:test";
import { displayNameFor } from "../../app/game/displayName";
import { emptyEquipment } from "../../app/game/equipment";
import type { ActorSnapshot, GameSnapshot } from "../../app/game/GameSession";
import { emptyMap, getStack, replaceStack } from "../../app/lib/mapData";
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
 * The claims worth pinning are the ones a reader of the prompt has to be able to
 * trust: that every glyph in the grid is explained, that a cell says whether a
 * body the bot's size could stand in it, that a cell with something in the way of
 * it reads as unknown rather than as ground, that a body in the grid is the same
 * body as the one in the list, and that a coordinate read off the ruler names the
 * cell it appears to name. The last is the one that would fail silently and
 * expensively: `walk_to` takes those numbers, and a ruler off by one is a body
 * walking somewhere nobody asked for — and cells of more than one character each
 * are a fresh way for it to go wrong.
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
  /**
   * The same two units, walkable: a step up in the open and a shelf with no
   * headroom under a roof. The tile the standing marker exists for.
   */
  tile({ id: "ledge", height: 2 }),
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
  /**
   * Tall and made of nothing, which is the case that separates `terrainHeight`
   * from the authored `TileDef.height`: you walk straight through it, so the
   * view must not tell a bot it is two units in the way.
   */
  tile({ id: "mist", height: 2, intangible: true }),
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

function put(map: MapFile, x: number, y: number, ...tileIds: string[]): MapFile {
  return replaceStack(map, x, y, 0, [
    { tileId: "grass" },
    ...tileIds.map((tileId) => ({ tileId })),
  ]);
}

/** A roof of full-level blocks over a rectangle, on the level above the ground. */
function roof(
  map: MapFile,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): MapFile {
  let out = map;
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      out = replaceStack(out, x, y, 1, [{ tileId: "block" }]);
    }
  }
  return out;
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

/** The cell the view has at a world coordinate, marker and bodies and all. */
function cellAt(view: BotView, x: number, y: number): string {
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
  // wrong reason. Standing on whatever is already there rather than replacing
  // it, because a body in a cell does not remove the cell.
  const withOthers = [self, ...others].reduce(
    (acc, body) =>
      replaceStack(acc, body.x, body.y, 0, [
        ...getStack(acc, body.x, body.y, 0),
        { tileId: body.tileId, owner: body.id },
      ]),
    map,
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
  it("covers every glyph the grid draws", () => {
    let map = field(6);
    map = put(map, 2, 0, "wall");
    map = put(map, -2, -2, "crate");
    map = put(map, 3, 3, "block");
    map = put(map, -4, 1, "crate", "mist");
    const view = viewOf(map, [actor("rat-1", "rat", 0, -3, 4)]);

    const named = new Set([
      "@",
      "?",
      ".",
      // The standing marker, which the legend explains in a sentence rather
      // than as an entry of its own — it stands for a fact about the cell and
      // not for a thing in it.
      "#",
      ...view.legend.map((entry) => entry.glyph),
      ...view.bodies.map((body) => body.glyph),
    ]);
    for (const row of view.rows) {
      for (const cell of row) {
        for (const glyph of cell) expect(named.has(glyph)).toBe(true);
      }
    }
  });

  it("says what the standing marker means, where the model reads it", () => {
    // A character in the grid the prompt never explains is one the model has to
    // guess at, and this one is the difference between a route and a refusal.
    let map = field(6);
    map = put(map, 2, 0, "crate");
    const view = viewOf(map);
    const text = renderBotView(view);

    expect(cellAt(view, 2, 0)).toContain("#");
    expect(text).toContain("# after it means");
  });

  it("names only what is in this view", () => {
    // `block` is on the board but outside the window, so it must not be named.
    let map = field(20);
    map = put(map, 15, 0, "block");
    const view = viewOf(map, [], 3);

    expect(view.legend.map((entry) => entry.tileId)).toEqual(["grass"]);
  });
});

describe("a cell is the top of it, and whether you fit", () => {
  it("writes the tile on top and nothing under it", () => {
    let map = field(6);
    map = put(map, 1, 0, "crate", "crate");
    const view = viewOf(map);

    expect(cellAt(view, 1, 0)).toBe(`${glyphFor(view, "crate")}#`);
    expect(cellAt(view, 0, 3)).toBe(glyphFor(view, "grass"));
  });

  it("reads one tile as somewhere to stand in the open and nowhere under a floor", () => {
    // The case the marker exists for, and the one an elevation cannot express:
    // the ledge is two units high in both cells, a step up outdoors and a shelf
    // with no headroom indoors.
    let map = field(6);
    map = put(map, -3, 0, "ledge");
    map = put(map, 2, 0, "ledge");
    // Over the bot as well as over the ledge, so the roof cut lifts it and the
    // room below is what the bot is shown.
    map = roof(map, -1, -1, 3, 1);
    const view = viewOf(map);

    expect(cellAt(view, -3, 0)).toBe(glyphFor(view, "ledge"));
    expect(cellAt(view, 2, 0)).toBe(`${glyphFor(view, "ledge")}#`);
    // The floor of the same room still reads as somewhere to stand, so the
    // marker is about headroom rather than about being indoors.
    expect(cellAt(view, 1, 1)).toBe(glyphFor(view, "grass"));
  });

  it("marks a cell whose surface nothing can stand on", () => {
    let map = field(6);
    map = put(map, 1, 0, "wall");
    map = put(map, -1, 0, "crate");
    const view = viewOf(map);

    expect(cellAt(view, 1, 0)).toBe(`${glyphFor(view, "wall")}#`);
    expect(cellAt(view, -1, 0)).toBe(`${glyphFor(view, "crate")}#`);
  });

  it("counts an intangible tile for the nothing the board counts it for", () => {
    let map = field(6);
    map = put(map, 1, 0, "mist");
    const view = viewOf(map);

    // Two units of it, and you walk straight through: the cell is somewhere to
    // stand, exactly as the bare grass beside it is.
    expect(tilesById.mist!.height).toBe(2);
    expect(cellAt(view, 1, 0)).toBe(glyphFor(view, "mist"));
  });

  it("stands a body on the cell rather than over it", () => {
    let map = field(6);
    map = put(map, 1, 0, "block");
    const view = viewOf(map, [actor("rat-1", "rat", 1, 0, 4)]);

    // The cell somebody is standing in is the one you most want the ground of,
    // so the body goes on the end and the tile under it survives. A creature is
    // solid — the board refuses a step into one — so the cell reads as no room.
    expect(cellAt(view, 1, 0)).toBe(`${glyphFor(view, "block")}#A`);
  });

  it("does not count people as in each other's way", () => {
    // People walk through each other and nothing else does, which is
    // `app/game/movement.ts`'s rule. Without it the bot's own body would make
    // the one cell it is certainly standing in read as nowhere it can be.
    const view = viewOf(field(6), [actor("them", "player", 2, 0)]);

    expect(cellAt(view, 0, 0)).toBe(`${glyphFor(view, "grass")}@`);
    expect(cellAt(view, 2, 0)).toBe(`${glyphFor(view, "grass")}A`);
  });
});

describe("what can be seen", () => {
  it("reads a cell behind a wall as unknown", () => {
    let map = field(6);
    for (let y = -6; y <= 6; y++) map = put(map, 2, y, "wall");
    const view = viewOf(map);

    // The wall itself is looked *at*, so it is named.
    expect(view.legend.map((e) => e.tileId)).toContain("wall");
    expect(cellAt(view, 2, 0)).toBe(`${glyphFor(view, "wall")}#`);
    // Everything behind it is not.
    expect(cellAt(view, 3, 0)).toBe("?");
    expect(cellAt(view, 5, 2)).toBe("?");
  });

  it("reads a column with nothing in it as nothing, not as unknown", () => {
    // A gap in the floor is the case `step` exists for: the model has to be able
    // to tell "I cannot see into this" from "there is no ground here".
    let map = field(6);
    map = replaceStack(map, -2, 0, 0, []);
    const view = viewOf(map);

    expect(cellAt(view, -2, 0)).toBe(".");
  });

  it("leaves a body it cannot see out of the grid and out of the list", () => {
    let map = field(6);
    for (let y = -6; y <= 6; y++) map = put(map, 2, y, "wall");
    const hidden = actor("rat-1", "rat", 4, 0, 4);
    const view = viewOf(map, [hidden]);

    expect(view.bodies).toEqual([]);
    expect(cellAt(view, 4, 0)).toBe("?");
  });
});

describe("the grid and the body list", () => {
  it("put every body in both, under one glyph", () => {
    const rat = actor("rat-1", "rat", 1, -2, 4);
    const deer = actor("deer-1", "rat", -3, 1, 6);
    const view = viewOf(field(6), [rat, deer]);

    expect(view.bodies).toHaveLength(2);
    for (const body of view.bodies) {
      expect(cellAt(view, body.x, body.y).endsWith(body.glyph)).toBe(true);
    }
    expect(view.bodies.map((b) => b.glyph)).toEqual(["A", "B"]);
    expect(view.bodies[0]!.distance).toBe(2);
  });

  it("draws the bot itself, whatever is standing with it", () => {
    const view = viewOf(field(6));

    expect(cellAt(view, 0, 0)).toBe(`${glyphFor(view, "grass")}@`);
    expect(view.self).toMatchObject({ x: 0, y: 0, z: 0 });
  });
});

describe("the bot's own name", () => {
  it("is in the view and in the rendered prompt", () => {
    const view = viewOf(field(6));

    // The same name everybody else's tag shows, so a bot can recognise itself
    // in a notice or in something somebody says to it.
    expect(view.self.name).toBe(displayNameFor("me"));
    expect(renderBotView(view)).toContain(`you are ${displayNameFor("me")}`);
  });
});

describe("the ruler", () => {
  it("names the cell it appears to name", () => {
    let map = field(6);
    map = put(map, -5, 3, "crate");
    map = put(map, 5, -4, "wall");
    // Cells of every width the grid has in one view, which is what makes the
    // columns worth checking at all: a marked cell, a body, an unknown and a
    // hole are one, two and three characters.
    map = put(map, -1, 2, "crate");
    map = replaceStack(map, 4, 4, 0, []);
    const view = viewOf(map, [actor("rat-1", "rat", 0, 5, 4)]);
    const read = readRendered(renderBotView(view));

    for (let y = view.bounds.minY; y <= view.bounds.maxY; y++) {
      for (let x = view.bounds.minX; x <= view.bounds.maxX; x++) {
        expect(read(x, y)).toBe(cellAt(view, x, y));
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
 * for, finds the cell a labelled tick points at, and counts cells along from
 * there. Cells are whatever the spaces separate, which is all a reader has to
 * go on. Anything cleverer would be re-deriving the layout from the code under
 * test, and the point of this is that a reader with only the text in front of
 * them lands on the same cell.
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

  return (x, y) => {
    // The first and last runs on the line are the `y` written down each edge.
    const runs = [...rows.get(y)!.matchAll(/\S+/g)].slice(1, -1);
    const anchor = runs.findIndex((run) => run.index === anchorColumn);
    expect(anchor).toBeGreaterThanOrEqual(0);
    return runs[anchor + (x - anchorX)]![0];
  };
}
