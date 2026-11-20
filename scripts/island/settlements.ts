import { tile } from "./board";
import { footprint } from "./landmarks";
import type { Builder, Building, Rect } from "./build";
import type { Site } from "./plan";
import { RECT, Town, type Point } from "./town";

type Person = { tileId: string; name: string; work: string };

const P = (name: string, work: string): Person => ({
  tileId: name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]+/g, "-"),
  name,
  work,
});

function settle(b: Builder, home: Building, who: Person, work: Building | null, z = home.z) {
  b.bedFor(
    home,
    {
      tileId: who.tileId,
      name: who.name,
      work: who.work,
      workCell: work ? b.workCell(work) : null,
    },
    z,
  );
}

function entriesOf(b: Builder, site: Site): Point[] {
  return b.plan.entries.get(site.id) ?? [];
}

/** The square's edge cell nearest `p`, so a lane leaves the square towards it. */
function edgeToward(square: Rect, p: Point): Point {
  const cx = (square.x0 + square.x1) >> 1;
  const cy = (square.y0 + square.y1) >> 1;
  const dx = p.x - cx;
  const dy = p.y - cy;
  if (Math.abs(dx) > Math.abs(dy)) return { x: dx > 0 ? square.x1 : square.x0, y: cy };
  return { x: cx, y: dy > 0 ? square.y1 : square.y0 };
}

export function buildDruids(b: Builder, site: Site) {
  const town = new Town(b, site);
  const c = town.centre;
  const square = RECT(c.x - 9, c.y - 4, 19, 13);
  town.fillStreet(square);
  for (const e of entriesOf(b, site))
    town.lane(edgeToward(square, e), e, 3, Math.abs(e.y - c.y) > Math.abs(e.x - c.x));
  const mainWest = { x: site.x0 + 12, y: c.y + 2 };
  town.lane({ x: square.x0, y: c.y + 2 }, mainWest, 3);

  const temple = b.house(
    "rune-temple",
    "Rune temple",
    RECT(c.x - 7, square.y0 - 12, 15, 11),
    town.z,
    "s",
    {
      roof: "blue",
      wall: "brick-wall",
      floor: "slate-floor",
      window: "window-2",
    },
  );
  for (let y = temple.rect.y0; y <= temple.rect.y1; y++)
    for (let x = temple.rect.x0; x <= temple.rect.x1; x++) town.mark(x, y, 2);
  const { x0, y0, x1 } = temple.rect;
  for (const [px, py] of [
    [x0 + 2, y0 + 2],
    [x1 - 2, y0 + 2],
    [x0 + 2, y0 + 7],
    [x1 - 2, y0 + 7],
  ] as const) {
    b.board.push(px, py, town.z, tile("marble-pillar-bottom"), tile("marble-pillar-middle"));
  }
  const mid = (x0 + x1) >> 1;
  b.put(mid - 3, y0 + 3, town.z, "bone-forge");
  b.put(mid, y0 + 3, town.z, "crystal-forge");
  b.put(mid + 3, y0 + 3, town.z, "obsidian-forge");
  b.put(mid, y0 + 5, town.z, "table");
  b.put(mid + 3, temple.rect.y1 - 2, town.z, "counter-top");
  b.put(mid + 4, temple.rect.y1 - 2, town.z, "wooden-shelf");
  const carving = b.world(mid, y0 + 6, town.z);
  const clerk = b.world(mid + 3, temple.rect.y1 - 3, town.z);

  const council = town.place(
    "council-house",
    "Council house",
    11,
    8,
    { x: square.x0, y: square.y0 },
    { storeys: 2, roof: "red" },
  );
  const wardens = town.place(
    "wardens-house",
    "Wardens' house",
    7,
    6,
    { x: council.rect.x0 - 6, y: council.rect.y0 },
    { roof: "red" },
  );
  const weaving = town.place(
    "weaving-house",
    "Weaving house",
    8,
    7,
    { x: square.x1, y: square.y0 },
    { storeys: 2, roof: "yellow" },
  );
  const bakehouse = town.place(
    "bakehouse",
    "Bakehouse",
    8,
    7,
    { x: square.x1, y: square.y1 },
    { roof: "yellow" },
  );
  const apothecary = town.place(
    "apothecary",
    "Apothecary",
    8,
    7,
    { x: bakehouse.rect.x1 + 6, y: bakehouse.rect.y0 },
    { storeys: 2, roof: "blue" },
  );
  const ledger = town.place(
    "ledger-house",
    "Ledger house",
    8,
    7,
    { x: square.x0, y: square.y1 },
    { storeys: 2, roof: "red" },
  );
  const granary = town.place(
    "granary",
    "Granary",
    9,
    7,
    { x: c.x + 14, y: temple.rect.y0 },
    { roof: "yellow", window: null },
  );
  const cell = town.place(
    "hesper-cell",
    "Hesper's cell behind the temple",
    5,
    5,
    { x: c.x, y: temple.rect.y0 - 4 },
    { roof: "blue", wall: "brick-wall" },
  );
  const longHouse = town.place("long-house", "Long house", 12, 6, mainWest, { roof: "red" });
  const gardenAt = { x: site.x0 + 6, y: c.y + 14 };
  const cottage = town.place("suvi-cottage", "Suvi's cottage by the garden plots", 6, 5, gardenAt, {
    roof: "yellow",
  });
  const dagny = town.place(
    "dagny-house",
    "Dagny's house",
    6,
    5,
    { x: c.x + 4, y: square.y1 + 10 },
    { roof: "blue" },
  );
  garden(b, town, { x: cottage.rect.x1 + 3, y: cottage.rect.y0 }, 14, 12);

  b.furnish(council, ["table", "chair", "chair", "chair", "wooden-shelf"]);
  b.stairsUp(council);
  b.furnish(wardens, ["wooden-box"]);
  b.furnish(weaving, ["table", "wooden-shelf", "sack", "sack"]);
  b.stairsUp(weaving);
  b.furnish(bakehouse, ["stone-forge", "table", "sack", "sack", "barrel"]);
  b.furnish(apothecary, ["counter-top", "wooden-shelf", "wooden-shelf", "barrel"]);
  b.stairsUp(apothecary);
  b.furnish(ledger, ["table", "wooden-shelf", "wooden-shelf", "chair"]);
  b.stairsUp(ledger);
  b.furnish(granary, ["sack", "sack", "sack", "sack", "barrel", "barrel", "wooden-box"]);
  b.furnish(longHouse, ["table", "wooden-box", "wooden-box", "anvil"]);

  const t = (name: string, work: string) => P(name, work);
  settle(b, council, t("Iolanthe Sarno", "Council house"), council, council.z + 1);
  b.bedFor(cell, {
    ...t("Hesper Vaun", "Rune temple, the carving table between the forges"),
    workCell: carving,
  });
  b.bedFor(dagny, {
    ...t("Dagny Rook", "Rune temple, the clerk's desk by the door"),
    workCell: clerk,
  });
  settle(b, weaving, t("Amaru Quispe", "Weaving house"), weaving, weaving.z + 1);
  settle(b, apothecary, t("Noor Halabi", "Apothecary"), apothecary);
  settle(b, bakehouse, t("Pell Marrow", "Bakehouse"), bakehouse);
  b.bedFor(cottage, {
    ...t("Suvi Kallio", "Garden plots on the town's west side"),
    workCell: b.world(cottage.rect.x1 + 6, cottage.rect.y0 + 5, town.z),
  });
  b.bedFor(
    apothecary,
    {
      ...t("Casimir Wren", "The streets: lamplighter"),
      workCell: b.world(square.x0, square.y1 + 1, town.z),
    },
    apothecary.z + 1,
  );
  settle(b, granary, t("Mina Dross", "Granary"), granary);
  settle(b, ledger, t("Rosalind Peake", "Ledger house"), ledger);
  settle(b, longHouse, t("Orrin Fask", "Long house"), longHouse);
  b.bedFor(
    ledger,
    {
      ...t("Fen Achterberg", "Rune temple steps"),
      workCell: b.world(temple.door.x + 1, temple.door.y + 1, town.z),
    },
    ledger.z + 1,
  );
  b.bedFor(wardens, {
    ...t("Taavi Kask", "Rune temple door (day warden)"),
    workCell: b.world(temple.door.x - 1, temple.door.y + 1, town.z),
  });
  b.bedFor(wardens, {
    ...t("Nadia Ferreira", "The streets at night (night warden)"),
    workCell: b.world(c.x, c.y, town.z),
  });

  b.put(c.x, c.y + 3, town.z, "respawn-point");
  town.lampPosts("Casimir Wren · druids' town streets", 9);
}

function garden(b: Builder, town: Town, at: Point, w: number, h: number) {
  const r = RECT(at.x, at.y, w, h);
  const cells = town.freeCells(r);
  if (cells.length < w * h * 0.8) return;
  town.yard(r);
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) {
      const edge = x === r.x0 || x === r.x1 || y === r.y0 || y === r.y1;
      const gate = y === r.y0 && x === (r.x0 + r.x1) >> 1;
      if (edge && !gate) b.board.set(x, y, town.z, [tile(b.base(x, y)), tile("fence")]);
      else if (!edge && (y - r.y0) % 3 === 0)
        b.board.set(x, y, town.z, [tile(b.base(x, y)), tile("dirt"), tile("small-bush")]);
      else if (!edge && (y - r.y0) % 3 === 1)
        b.board.set(x, y, town.z, [tile(b.base(x, y)), tile("dirt")]);
    }
  }
  b.put(r.x1 - 2, r.y1 - 2, town.z, "apple-tree");
}

export function buildWarriors(b: Builder, site: Site) {
  const town = new Town(b, site);
  const z = town.z;
  const c = town.centre;
  const inset = 8;
  const wall = {
    x0: site.x0 + inset,
    y0: site.y0 + inset,
    x1: site.x1 - inset,
    y1: site.y1 - inset,
  };
  const gates = {
    n: { x: c.x, y: wall.y0 },
    e: { x: wall.x1, y: c.y },
    s: { x: c.x, y: wall.y1 },
    w: { x: wall.x0, y: c.y },
  };
  const isGate = (x: number, y: number) =>
    (Math.abs(x - gates.n.x) <= 1 && (y === wall.y0 || y === wall.y0 + 1)) ||
    (Math.abs(x - gates.s.x) <= 1 && (y === wall.y1 || y === wall.y1 - 1)) ||
    (Math.abs(y - gates.e.y) <= 1 && (x === wall.x1 || x === wall.x1 - 1)) ||
    (Math.abs(y - gates.w.y) <= 1 && (x === wall.x0 || x === wall.x0 + 1));
  for (let y = wall.y0; y <= wall.y1; y++) {
    for (let x = wall.x0; x <= wall.x1; x++) {
      const ring = x <= wall.x0 + 1 || x >= wall.x1 - 1 || y <= wall.y0 + 1 || y >= wall.y1 - 1;
      if (!ring || isGate(x, y)) continue;
      town.mark(x, y, 3);
      b.board.set(x, y, z, [tile(b.base(x, y)), tile("stone-wall")]);
      b.board.set(x, y, z + 1, [tile("flagstone-floor")]);
    }
  }
  const outside = {
    n: { x: c.x, y: wall.y0 - 3 },
    e: { x: wall.x1 + 3, y: c.y },
    s: { x: c.x, y: wall.y1 + 3 },
    w: { x: wall.x0 - 3, y: c.y },
  };
  const square = RECT(c.x - 8, c.y - 6, 17, 13);
  town.fillStreet(square);
  for (const side of ["n", "e", "s", "w"] as const) {
    town.lane(outside[side], edgeToward(square, outside[side]), 3, side === "n" || side === "s");
  }
  for (const e of entriesOf(b, site)) {
    const near = (["n", "e", "s", "w"] as const)
      .map((side) => ({ side, d: Math.hypot(outside[side].x - e.x, outside[side].y - e.y) }))
      .sort((a, d) => a.d - d.d)[0]!.side;
    town.lane(e, outside[near], 3, near === "e" || near === "w");
  }
  wallStairs(b, town, { x: gates.n.x + 4, y: wall.y0 + 2 }, "n");
  wallStairs(b, town, { x: wall.x1 - 2, y: gates.e.y + 4 }, "e");
  wallStairs(b, town, { x: gates.s.x - 4, y: wall.y1 - 2 }, "s");

  const drill = RECT(square.x0 - 18, square.y1 - 4, 14, 12);
  town.lane({ x: square.x0, y: square.y1 - 2 }, { x: drill.x1 + 1, y: square.y1 - 2 }, 3);
  town.yard(drill, "dirt");
  for (const [dx, dy] of [
    [3, 3],
    [6, 3],
    [9, 3],
    [3, 7],
    [9, 7],
  ] as const) {
    b.put(drill.x0 + dx, drill.y0 + dy, z, "training-dummy");
  }
  for (const dx of [2, 3, 4]) b.put(drill.x0 + dx, drill.y1 - 1, z, "stool");
  const drillCentre = { x: (drill.x0 + drill.x1) >> 1, y: (drill.y0 + drill.y1) >> 1 };

  const longhall = town.place(
    "longhall",
    "Longhall",
    16,
    9,
    { x: c.x, y: square.y0 - 6 },
    { roof: "red", wall: "brick-wall" },
  );
  const smithy = town.place(
    "smithy",
    "Smithy",
    9,
    7,
    { x: square.x1 + 4, y: square.y0 },
    { storeys: 2, roof: "red", wall: "brick-wall" },
  );
  const armoury = town.place(
    "armoury",
    "Armoury",
    9,
    7,
    { x: square.x1 + 4, y: square.y1 },
    { roof: "red", wall: "brick-wall" },
  );
  const absalom = town.place(
    "absalom-house",
    "Absalom's house beside the drill yard",
    6,
    5,
    { x: drillCentre.x, y: drill.y0 - 4 },
    { roof: "yellow" },
  );
  const barracks = town.place(
    "barracks",
    "Barracks by the drill yard",
    10,
    6,
    { x: drill.x0, y: drill.y1 + 4 },
    { roof: "red" },
  );
  const spear = town.place(
    "spear-shed",
    "Spear shed by the drill yard",
    6,
    5,
    { x: drill.x1 + 2, y: drill.y1 + 4 },
    { roof: "yellow", window: null },
  );
  const store = town.place(
    "storehouse",
    "Storehouse by the drill yard",
    9,
    7,
    { x: drill.x0 - 2, y: drill.y0 - 4 },
    { roof: "yellow", window: null },
  );
  const bowyer = town.place(
    "bowyer",
    "Bowyer's shop by the east gate",
    7,
    6,
    { x: gates.e.x - 6, y: gates.e.y - 6 },
    { roof: "yellow" },
  );
  const eastGate = town.place(
    "east-gatehouse",
    "East gatehouse",
    5,
    5,
    { x: gates.e.x - 4, y: gates.e.y + 5 },
    { roof: "red", wall: "brick-wall" },
  );
  const northGate = town.place(
    "north-gatehouse",
    "North gatehouse",
    5,
    5,
    { x: gates.n.x - 6, y: gates.n.y + 4 },
    { roof: "red", wall: "brick-wall" },
  );
  const smokehouse = town.place(
    "smokehouse",
    "Smokehouse by the south gate",
    8,
    7,
    { x: gates.s.x + 7, y: gates.s.y - 5 },
    { roof: "red", window: null },
  );
  const cooperage = town.place(
    "cooperage",
    "Cooperage by the smokehouse",
    7,
    6,
    { x: gates.s.x + 16, y: gates.s.y - 6 },
    { roof: "yellow" },
  );
  const tobiah = town.place(
    "tobiah-house",
    "Tobiah's house by the south gate",
    5,
    5,
    { x: gates.s.x - 7, y: gates.s.y - 4 },
    { roof: "yellow" },
  );
  const trophy = town.place(
    "trophy-shed",
    "Trophy shed outside the north gate",
    6,
    5,
    { x: gates.n.x + 9, y: site.y0 + 3 },
    { roof: "yellow", window: null },
    1,
  );

  b.furnish(longhall, [
    "table",
    "table",
    "stool",
    "stool",
    "stool",
    "stool",
    "stone-forge",
    "barrel",
    "barrel",
  ]);
  b.furnish(smithy, ["anvil", "stone-forge", "barrel", "wooden-shelf"]);
  b.stairsUp(smithy);
  b.furnish(armoury, ["wooden-shelf", "wooden-shelf", "wooden-shelf", "counter-top"]);
  b.furnish(bowyer, ["table", "wooden-shelf"]);
  b.furnish(spear, ["wooden-shelf", "table"]);
  b.furnish(store, ["sack", "sack", "barrel", "barrel", "wooden-box", "counter-top"]);
  b.furnish(smokehouse, ["stone-forge", "barrel", "sack"]);
  b.furnish(cooperage, ["barrel", "barrel", "barrel", "table"]);
  b.furnish(trophy, ["wooden-shelf", "wooden-shelf"]);

  const t = P;
  settle(b, longhall, t("Ragna Holt", "Longhall"), longhall);
  b.bedFor(absalom, {
    ...t("Absalom Grieve", "Drill yard"),
    workCell: b.world(drillCentre.x, drillCentre.y, z),
  });
  settle(b, smithy, t("Brannoc Hale", "Smithy"), smithy, smithy.z + 1);
  settle(b, bowyer, t("Selin Arslan", "Bowyer's shop"), bowyer);
  settle(b, spear, t("Mateo Ferran", "Spear shed; the longhall at night"), spear);
  settle(b, armoury, t("Halina Brzeska", "Armoury"), armoury);
  settle(b, smokehouse, t("Bertha Oyelaran", "Smokehouse"), smokehouse);
  settle(b, trophy, t("Magda Fenwick", "Trophy shed"), trophy);
  b.bedFor(tobiah, {
    ...t("Tobiah Marsh", "The streets: lamplighter"),
    workCell: b.world(square.x0, square.y0 - 1, z),
  });
  settle(b, store, t("Rukmini Desai", "Storehouse"), store);
  b.bedFor(northGate, {
    ...t("Edda Kell", "North gate"),
    workCell: b.world(gates.n.x, gates.n.y + 2, z),
  });
  settle(b, cooperage, t("Aurelio Benedetti", "Cooperage"), cooperage);
  b.bedFor(smokehouse, {
    ...t("Sigrun Halde", "Bench at the drill yard"),
    workCell: b.world(drill.x0 + 3, drill.y1 - 2, z),
  });
  b.bedFor(eastGate, {
    ...t("Gideon Okafor", "East gate, facing the Red Waste"),
    workCell: b.world(gates.e.x - 2, gates.e.y, z),
  });
  b.bedFor(barracks, {
    ...t("Liv Sandvik", "The walls at night"),
    workCell: b.world(gates.n.x + 4, wall.y0, z + 1),
  });
  for (let k = 0; k < 3; k++)
    b.bedFor(barracks, { tileId: "", name: "(spare bunk)", work: "", workCell: null });

  b.put(c.x + 3, c.y, z, "respawn-point");
  town.lampPosts("Tobiah Marsh · warriors' town streets", 9);
}

/**
 * A flight of `stone-stairs` up to the wall walk: two cells in a line away
 * from the wall, the upper one on a `brick-slab`, with nothing above either.
 */
function wallStairs(b: Builder, town: Town, against: Point, wall: "n" | "e" | "s" | "w") {
  const away: Record<string, [number, number]> = { n: [0, 1], s: [0, -1], e: [-1, 0], w: [1, 0] };
  const facing = { n: "s", s: "n", e: "w", w: "e" } as const;
  const [dx, dy] = away[wall]!;
  const high = against;
  const low = { x: high.x + dx, y: high.y + dy };
  for (const p of [high, low, { x: low.x + dx, y: low.y + dy }]) {
    if (town.at(p.x, p.y) !== 0) return;
  }
  const z = town.z;
  b.board.set(high.x, high.y, z, [
    tile(b.base(high.x, high.y)),
    tile("brick-slab"),
    tile("stone-stairs", facing[wall]),
  ]);
  b.board.set(low.x, low.y, z, [tile(b.base(low.x, low.y)), tile("stone-stairs", facing[wall])]);
  town.mark(high.x, high.y, 3);
  town.mark(low.x, low.y, 3);
  town.mark(low.x + dx, low.y + dy, 3);
}

export function buildCamp(b: Builder, site: Site) {
  const town = new Town(b, site, "dirt");
  const z = town.z;
  const c = town.centre;
  const yard = RECT(c.x - 4, c.y - 3, 9, 7);
  town.fillStreet(yard);
  const entries = entriesOf(b, site);
  for (const e of entries)
    town.lane(edgeToward(yard, e), e, 2, Math.abs(e.y - c.y) > Math.abs(e.x - c.x));
  b.board.set(c.x, c.y, z, [tile(b.base(c.x, c.y)), tile("campfire")]);
  for (const [dx, dy, id] of [
    [-2, 0, "stool"],
    [2, 0, "stool"],
    [0, 2, "stool"],
  ] as const) {
    b.board.push(c.x + dx, c.y + dy, z, tile(id));
  }
  footprint(b, { x: c.x - 3, y: c.y - 2 }, z, "fallen-log", 2, 1);
  const beachEnd = entries.reduce((best, e) => (e.y > best.y ? e : best), { x: c.x, y: site.y1 });

  const tove = town.place(
    "tove-lean-to",
    "Tove's lean-to at the beach end of the camp",
    6,
    5,
    { x: beachEnd.x, y: beachEnd.y - 5 },
    { roof: "yellow", window: null },
    1,
  );
  const idris = town.place(
    "idris-awning",
    "Idris's awning beside the path",
    6,
    5,
    { x: c.x + 8, y: c.y },
    { roof: "yellow", window: null },
    1,
  );
  const ifeoma = town.place(
    "ifeoma-tent",
    "Ifeoma's cook tent at the cookfire",
    6,
    5,
    { x: c.x - 7, y: c.y + 4 },
    { roof: "red", window: null },
    1,
  );
  const peregrine = town.place(
    "peregrine-tent",
    "Peregrine's tent and trap bench",
    6,
    5,
    { x: c.x - 9, y: c.y - 6 },
    { roof: "yellow", window: null },
    1,
  );
  const wenna = town.place(
    "wenna-shack",
    "Wenna's shack at the salvage pile",
    6,
    5,
    { x: c.x + 7, y: c.y + 7 },
    { roof: "red", window: null },
    1,
  );

  b.furnish(idris, ["table"]);
  b.furnish(ifeoma, ["barrel", "sack"]);
  b.furnish(peregrine, ["table"]);
  b.furnish(wenna, ["wooden-box"]);
  settle(b, tove, P("Tove Arnesdatter", "Wreck beach at dawn, the camp by day"), null);
  b.residents[b.residents.length - 1]!.workCell = b.world(c.x, c.y + 1, z);
  settle(b, idris, P("Idris Kaya", "Under the awning beside the path"), idris);
  settle(b, ifeoma, P("Ifeoma Nwachukwu", "The cookfire"), null);
  b.residents[b.residents.length - 1]!.workCell = b.world(c.x + 1, c.y, z);
  settle(b, peregrine, P("Peregrine Voss", "Trap bench by the salvage pile"), peregrine);

  const pile = { x: wenna.rect.x1 + 2, y: wenna.rect.y0 };
  let k = 0;
  for (const id of [
    "wreck-planks",
    "driftwood",
    "rope-coil",
    "barrel",
    "wooden-box",
    "wreck-planks",
    "driftwood",
  ]) {
    const x = pile.x + (k % 3);
    const y = pile.y + Math.floor(k / 3);
    k++;
    if (town.at(x, y) === 0) {
      b.put(x, y, z, id);
      town.mark(x, y, 3);
    }
  }
  settle(b, wenna, P("Wenna Pascoe", "The salvage pile and the wreck beach"), null);
  b.residents[b.residents.length - 1]!.workCell = b.world(pile.x, pile.y + 3, z);

  const jory = town.place(
    "jory-lean-to",
    "Jory's lean-to by his barrow",
    5,
    5,
    { x: c.x - 6, y: site.y0 + 2 },
    { roof: "yellow", window: null },
    1,
  );
  const { faces, ...seat } = barrow(b, town, jory);
  b.bedFor(jory, {
    ...P("Jory Thistlewood", "His barrow at the path's fork towards the two towns"),
    workCell: seat,
    faces,
  });
  b.put(c.x - 1, c.y + 2, z, "respawn-point");
}

/**
 * Jory's barrow, a box with a sack on it, against the lean-to's front wall
 * beside the doorway. Returns the cell beside it, where he sits by day facing
 * the path.
 */
function barrow(b: Builder, town: Town, shelter: Building) {
  const { x, y, wall } = shelter.door;
  const out: Record<string, [number, number]> = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] };
  const [ox, oy] = out[wall]!;
  const along: [number, number] = ox === 0 ? [1, 0] : [0, 1];
  for (const side of [2, -2, 3, -3]) {
    const box = { x: x + ox + along[0] * side, y: y + oy + along[1] * side };
    const sack = { x: box.x + along[0] * Math.sign(side), y: box.y + along[1] * Math.sign(side) };
    const seat = { x: box.x - along[0] * Math.sign(side), y: box.y - along[1] * Math.sign(side) };
    if ([box, sack, seat].some((p) => town.at(p.x, p.y) === 2)) continue;
    if (!b.put(box.x, box.y, town.z, "wooden-box")) continue;
    b.put(sack.x, sack.y, town.z, "sack");
    town.mark(box.x, box.y, 3);
    town.mark(sack.x, sack.y, 3);
    return { ...b.world(seat.x, seat.y, town.z), faces: wall };
  }
  throw new Error("no room for Jory's barrow beside his lean-to");
}

export function buildInn(b: Builder, site: Site) {
  const town = new Town(b, site, "dirt");
  const z = town.z;
  const c = town.centre;
  const yard = RECT(c.x - 10, c.y + 3, 21, 4);
  town.fillStreet(yard);
  for (const e of entriesOf(b, site)) town.lane(edgeToward(yard, e), e, 2);
  const inn = town.place(
    "inn",
    "Roadside inn",
    14,
    10,
    { x: c.x - 3, y: c.y - 3 },
    { storeys: 2, roof: "red" },
    1,
  );
  const stable = town.place(
    "stable",
    "Stable",
    9,
    7,
    { x: c.x + 10, y: c.y - 2 },
    { storeys: 2, roof: "yellow", window: null },
    1,
  );
  const bar = inn.rect.x0 + 2;
  for (let y = inn.rect.y0 + 2; y <= inn.rect.y0 + 4; y++) b.put(bar, y, z, "counter-top");
  b.furnish(inn, ["barrel", "barrel", "stone-forge", "wooden-shelf"]);
  for (const [dx, dy] of [
    [6, 3],
    [9, 3],
    [6, 6],
    [9, 6],
  ] as const) {
    if (b.put(inn.rect.x0 + dx, inn.rect.y0 + dy, z, "table")) {
      b.put(inn.rect.x0 + dx + 1, inn.rect.y0 + dy, z, "stool");
      b.put(inn.rect.x0 + dx - 1, inn.rect.y0 + dy, z, "stool");
    }
  }
  b.stairsUp(inn);
  b.stairsUp(stable);
  b.furnish(stable, ["sack", "sack", "barrel"]);
  b.bedFor(inn, {
    ...P("Margit Oslund", "Behind the bar"),
    home: "Roadside inn, the room behind the bar",
    workCell: b.world(bar + 1, inn.rect.y0 + 3, z),
  });
  b.bedFor(
    inn,
    {
      ...P("Kofi Asante", "The inn's kitchen and cellar"),
      home: "Roadside inn, the loft",
      workCell: b.workCell(inn),
    },
    z + 1,
  );
  b.bedFor(
    stable,
    {
      ...P("Rodrigo Vela", "The same table every night"),
      home: "The room over the stable",
      workCell: b.world(inn.rect.x0 + 6, inn.rect.y0 + 4, z),
    },
    z + 1,
  );
  b.bedFor(
    inn,
    {
      ...P("Hamid Sarraf", "The roads between the towns and the camp (pedlar)"),
      home: "Roadside inn, a guest bed",
      workCell: null,
    },
    z + 1,
  );
  b.bedFor(
    inn,
    {
      ...P("Anselm Quaye", "A circuit of the island's roads (pilgrim)"),
      home: "Roadside inn, a guest bed (assumed)",
      workCell: null,
    },
    z + 1,
  );
  b.bedFor(
    inn,
    {
      ...P("Yeva Kostenko", "The roads between the towns (courier)"),
      home: "Roadside inn, a guest bed; or either town at dusk",
      workCell: null,
    },
    z + 1,
  );
  b.bedFor(inn, { tileId: "", name: "(guest bed for players)", work: "", workCell: null }, z + 1);
}

export function buildWitch(b: Builder, site: Site) {
  const town = new Town(b, site, "dirt");
  const z = town.z;
  const c = town.centre;
  town.fillStreet(RECT(c.x - 2, c.y + 3, 5, 2));
  const house = town.place(
    "witch-house",
    "The witch's house on stilts at the bog's edge",
    7,
    6,
    { x: c.x, y: c.y - 2 },
    { roof: "blue" },
    1,
  );
  b.furnish(house, ["stone-forge", "wooden-shelf", "wooden-shelf", "barrel"]);
  settle(b, house, P("Morwen Teague", "Her house and the bog by night"), house);
  b.put(c.x + 3, c.y + 4, z, "campfire");
}
