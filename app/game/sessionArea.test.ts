import { describe, expect, it } from "vitest";
import { maxHpFrom } from "../lib/battler";
import { emptyMap, replaceStack } from "../lib/mapData";
import { statusesById } from "../lib/status";
import { FRAME, tile } from "../lib/testTile";
import type { Coord, MapFile, PlacedTile, TileDef } from "../lib/types";
import { squareSlot } from "./casting";
import { TICK_MS } from "./constants";
import { GameSession } from "./GameSession";

const FIXTURE_BASE_HP = 8;
const TOUGHNESS = 40;
const MAX_HP = maxHpFrom(FIXTURE_BASE_HP, TOUGHNESS);
const FIXTURE_BODY_HEIGHT = 4;

const FIELD_SIZE = 11;
const CENTRE: Coord = { x: 5, y: 5, z: 0 };
const RADIUS = 2;
const AREA_DAMAGE = 20;
const AREA_HEIGHT = 2;
const WINDUP_MS = 1_000;
const BURST_RATE_PER_SECOND = 84;
const CIRCLE_CELLS = 21;
const LETHAL_DAMAGE = 999;
const FLEE_WATCH_MS = 2_000;

/** Flees from whatever last hurt it, so a body that was told it was attacked walks off. */
const SKITTISH_BRAIN = {
  initial: "grazing",
  states: {
    grazing: { do: [{ action: "hold" }] },
    fleeing: {
      do: [{ action: "step_away_from", of: { type: "slot", data: { name: "spooked" } } }],
    },
  },
  transitions: [
    {
      from: "any",
      if: { cond: "attacked" },
      bind: { spooked: { type: "attacker" } },
      to: "fleeing",
    },
  ],
};

function body(id: string, extra: Record<string, unknown> = {}, kit: string[] = []): TileDef {
  return tile({
    id,
    height: FIXTURE_BODY_HEIGHT,
    kind: "battler",
    directional: true,
    walkable: false,
    affectedByGravity: true,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
    interactions: {
      battler: {
        baseHp: FIXTURE_BASE_HP,
        masteries: { toughness: TOUGHNESS },
        naturalWeapon: {
          type: "weapon",
          damage: 1,
          def: 0,
          accuracy: 0,
          variance: 0,
          spd: 1,
          mastery: "fist",
        },
        ...(kit.length
          ? { kit: kit.map((tileId) => ({ slot: "weapon", tileId, chance: 100 })) }
          : {}),
      },
    },
    ...extra,
  });
}

function skittishRat(): TileDef {
  const rat = body("skittish-rat", { actor: true });
  return { ...rat, interactions: { ...rat.interactions, brain: SKITTISH_BRAIN } } as TileDef;
}

function stone(id: string, item: Record<string, unknown>): TileDef {
  return tile({
    id,
    kind: "item",
    lightPassing: true,
    intangible: true,
    affectedByGravity: true,
    interactions: { item: { type: "stone", cooldownMs: 10_000, ...item } },
  });
}

const ring = {
  shape: "circle",
  radius: RADIUS,
  height: AREA_HEIGHT,
  affects: "others",
  throughWalls: false,
  damage: AREA_DAMAGE,
};

const DUST = {
  durationMs: 500,
  particles: {
    ratePerSecond: BURST_RATE_PER_SECOND,
    ttlFromMs: 200,
    ttlToMs: 400,
    spawnRadiusCells: 0.4,
    spawnElevFrom: 0,
    spawnElevTo: 1,
    riseFrom: 1,
    riseTo: 2,
    driftCellsPerSecond: 0.5,
    gravity: -2,
    radiusFromPx: 1,
    radiusToPx: 1,
    alphaFrom: 1,
    alphaTo: 0,
    ramp: [{ at: 0, color: "#a08060" }],
  },
};

const STONES: TileDef[] = [
  stone("stomp-stone", { effect: { kind: "bolt", on: "caster", area: ring } }),
  stone("quake-stone", {
    effect: { kind: "bolt", on: "caster", area: { ...ring, throughWalls: true } },
  }),
  stone("selfish-stone", {
    effect: { kind: "bolt", on: "caster", area: { ...ring, affects: "both" } },
  }),
  stone("brand-ring-stone", {
    effect: {
      kind: "bolt",
      on: "caster",
      area: { ...ring, damage: undefined, statuses: [{ id: "burned", chance: 100 }] },
    },
  }),
  stone("dusty-stone", {
    effect: { kind: "bolt", on: "caster", area: { ...ring, burst: DUST } },
    castTimeMs: WINDUP_MS,
  }),
  stone("lethal-splash-stone", {
    effect: {
      kind: "bolt",
      on: "target",
      damage: LETHAL_DAMAGE,
      area: { ...ring, radius: 1 },
    },
    reach: { cells: 8, height: 2 },
  }),
  stone("splash-stone", {
    effect: { kind: "bolt", on: "target", area: { ...ring, radius: 1, affects: "both" } },
    reach: { cells: 8, height: 2 },
  }),
];

const statuses = statusesById([
  {
    id: "burned",
    name: "Burned",
    description: "Searing.",
    tone: "bad",
    fromMs: 4_000,
    toMs: 4_000,
    everyMs: 1_000,
    effects: { hp: "0 - 1" },
  },
]);

function field(): MapFile {
  let map = emptyMap();
  for (let y = 0; y < FIELD_SIZE; y++) {
    for (let x = 0; x < FIELD_SIZE; x++) map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
  }
  return put(map, CENTRE, [{ tileId: "player", direction: "e" }]);
}

function put(map: MapFile, at: Coord, above: PlacedTile[], under: PlacedTile[] = []): MapFile {
  return replaceStack(map, at.x, at.y, at.z, [{ tileId: "grass" }, ...under, ...above]);
}

function withRat(map: MapFile, at: Coord, under: PlacedTile[] = []): MapFile {
  return put(map, at, [{ tileId: "rat", direction: "w", owner: ratId(at) }], under);
}

function ratId(at: Coord): string {
  return `npc:${at.x},${at.y},${at.z}`;
}

function session(stoneId: string, map: MapFile): GameSession {
  const tiles = [
    tile({ id: "grass" }),
    tile({ id: "wall", height: 4, lightPassing: false }),
    body("rat", { actor: true }),
    skittishRat(),
    body("player", {}, [stoneId]),
    ...STONES,
  ];
  return new GameSession(map, tiles, { statuses });
}

function hpOf(play: GameSession, id: string): number | null {
  return play.actorSnapshots().find((a) => a.id === id)?.hp ?? null;
}

function hurt(play: GameSession, at: Coord): boolean {
  return (hpOf(play, ratId(at)) ?? MAX_HP) < MAX_HP;
}

function castNow(play: GameSession) {
  expect(play.cast(squareSlot("weapon"))).toBe(true);
}

const INSIDE: Coord = { x: CENTRE.x + 2, y: CENTRE.y + 1, z: 0 };
const CORNER: Coord = { x: CENTRE.x + 2, y: CENTRE.y + 2, z: 0 };
const BEYOND: Coord = { x: CENTRE.x + 3, y: CENTRE.y, z: 0 };

describe("an area around its caster", () => {
  it("hits every body inside the shape and nobody outside it", () => {
    let map = field();
    for (const at of [INSIDE, CORNER, BEYOND]) map = withRat(map, at);
    const play = session("stomp-stone", map);

    castNow(play);

    expect(hurt(play, INSIDE)).toBe(true);
    expect(hurt(play, CORNER)).toBe(false);
    expect(hurt(play, BEYOND)).toBe(false);
  });

  it("spares its caster when it is for others, and not when it is for both", () => {
    const spared = session("stomp-stone", withRat(field(), INSIDE));
    castNow(spared);
    expect(hpOf(spared, "local")).toBe(MAX_HP);

    const both = session("selfish-stone", withRat(field(), INSIDE));
    castNow(both);
    expect(hpOf(both, "local")).toBeLessThan(MAX_HP);
    expect(hurt(both, INSIDE)).toBe(true);
  });

  it("stops at a wall unless it is meant to go through", () => {
    const behind: Coord = { x: CENTRE.x + 2, y: CENTRE.y, z: 0 };
    const wall: Coord = { x: CENTRE.x + 1, y: CENTRE.y, z: 0 };
    const walled = (stoneId: string) =>
      session(stoneId, put(withRat(field(), behind), wall, [{ tileId: "wall" }]));

    const blocked = walled("stomp-stone");
    castNow(blocked);
    expect(hurt(blocked, behind)).toBe(false);

    const through = walled("quake-stone");
    castNow(through);
    expect(hurt(through, behind)).toBe(true);
  });

  it("does not reach a body standing higher than its height", () => {
    const raised: Coord = { x: CENTRE.x + 1, y: CENTRE.y, z: 0 };
    const play = session("quake-stone", withRat(field(), raised, [{ tileId: "wall" }]));

    castNow(play);

    expect(hurt(play, raised)).toBe(false);
  });

  it("leaves its statuses on everybody it reaches", () => {
    const play = session("brand-ring-stone", withRat(withRat(field(), INSIDE), BEYOND));

    castNow(play);

    const burnsOf = (at: Coord) => (play.statusesOf(ratId(at)) ?? []).map((s) => s.defId);
    expect(burnsOf(INSIDE)).toEqual(["burned"]);
    expect(burnsOf(BEYOND)).toEqual([]);
  });
});

describe("an area that winds up", () => {
  it("names its shape while it winds up, so the cells can be marked", () => {
    const play = session("dusty-stone", field());

    castNow(play);

    expect(play.getSnapshot().self.casting?.area).toEqual({
      shape: "circle",
      radius: RADIUS,
      height: AREA_HEIGHT,
      on: "caster",
    });
  });

  it("bursts on every cell it covers when it lands, sharing the burst's particles", () => {
    const play = session("dusty-stone", field());
    castNow(play);

    let bursts: ReturnType<GameSession["drainAreaBursts"]> = [];
    for (let elapsed = 0; elapsed <= WINDUP_MS && bursts.length === 0; elapsed += TICK_MS) {
      play.tick(TICK_MS);
      bursts = play.drainAreaBursts();
    }

    expect(bursts).toHaveLength(1);
    expect(bursts[0]!.cells).toHaveLength(CIRCLE_CELLS);
    const effects = play.getSnapshot().flightEffects;
    expect(effects).toHaveLength(CIRCLE_CELLS);
    expect(effects[0]!.transition.particles?.ratePerSecond).toBe(
      BURST_RATE_PER_SECOND / CIRCLE_CELLS,
    );
  });
});

describe("an area on a bolt cast at somebody", () => {
  it("is centred where the bolt lands, not on the caster", () => {
    const target: Coord = { x: CENTRE.x + 4, y: CENTRE.y, z: 0 };
    const beside: Coord = { x: target.x + 1, y: target.y, z: 0 };
    const play = session("splash-stone", withRat(withRat(field(), target), beside));
    play.setTarget(ratId(target));

    castNow(play);

    expect(hurt(play, target)).toBe(true);
    expect(hurt(play, beside)).toBe(true);
    expect(hpOf(play, "local")).toBe(MAX_HP);
  });
});

describe("an area on a bolt that kills its target", () => {
  it("still lands around where the target stood", () => {
    const target: Coord = { x: CENTRE.x + 4, y: CENTRE.y, z: 0 };
    const beside: Coord = { x: target.x + 1, y: target.y, z: 0 };
    const play = session("lethal-splash-stone", withRat(withRat(field(), target), beside));
    play.setTarget(ratId(target));

    castNow(play);

    expect(hpOf(play, ratId(target))).toBeNull();
    expect(hurt(play, beside)).toBe(true);
  });
});

describe("who an area may hurt", () => {
  const NEIGHBOUR: Coord = { x: CENTRE.x + 1, y: CENTRE.y, z: 0 };

  it("leaves a player who has not agreed to fight alone", () => {
    const play = session("stomp-stone", field());
    play.spawn("bystander", { at: NEIGHBOUR });

    castNow(play);

    expect(hpOf(play, "bystander")).toBe(MAX_HP);
  });

  it("hurts a player once both have agreed to fight", () => {
    const play = session("stomp-stone", field());
    play.spawn("bystander", { at: NEIGHBOUR, pvp: true });
    play.setPvp(true);

    castNow(play);

    expect(hpOf(play, "bystander")).toBeLessThan(MAX_HP);
  });

  it("tells a creature it hurt who attacked it", () => {
    const skittish: Coord = { x: CENTRE.x + 2, y: CENTRE.y, z: 0 };
    const map = put(field(), skittish, [
      { tileId: "skittish-rat", direction: "w", owner: ratId(skittish) },
    ]);
    const play = session("stomp-stone", map);

    castNow(play);
    for (let elapsed = 0; elapsed < FLEE_WATCH_MS; elapsed += TICK_MS) play.tick(TICK_MS);

    const fled = play.actorSnapshots().find((a) => a.id === ratId(skittish))!;
    expect(fled.x).toBeGreaterThan(skittish.x);
  });
});
