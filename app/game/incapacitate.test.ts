import { describe, expect, it } from "vitest";
import { emptyMap, replaceStack } from "../lib/mapData";
import { statusesById } from "../lib/status";
import type { Direction, MapFile, TileDef } from "../lib/types";
import { FRAME, tile } from "../lib/testTile";
import { TICK_MS, WALK_DURATION_MS } from "./constants";
import { GameSession } from "./GameSession";

const TICKS_PER_STEP = Math.ceil(WALK_DURATION_MS / TICK_MS) + 1;
const TICKS_PER_SECOND = Math.round(1_000 / TICK_MS);
const SLEEP_MS = 10_000;
const BURN_MS = 3_000;

function body(id: string, extra: Record<string, unknown> = {}): TileDef {
  return tile({
    id,
    height: 4,
    kind: "battler",
    directional: true,
    walkable: false,
    affectedByGravity: true,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
    interactions: {
      battler: {
        baseHp: 20,
        masteries: { toughness: 50 },
        naturalWeapon: {
          type: "weapon",
          damage: 5,
          def: 0,
          accuracy: 100,
          variance: 0,
          spd: 100,
          mastery: "fist",
        },
      },
    },
    ...extra,
  });
}

const tiles: TileDef[] = [
  tile({ id: "grass" }),
  body("player"),
  body("deer", { actor: true }),
  tile({
    id: "bed",
    height: 2,
    interactions: { addStatus: { trigger: "interact", statusId: "sleep" } },
  }),
  tile({
    id: "stool",
    height: 2,
    interactions: { addStatus: { trigger: "interact", statusId: "daze" } },
  }),
  tile({ id: "fire", interactions: { addStatus: { trigger: "step", statusId: "burned" } } }),
];

const catalogue = statusesById([
  {
    id: "sleep",
    name: "Asleep",
    description: "Healing fast.",
    tone: "good",
    fromMs: SLEEP_MS,
    toMs: SLEEP_MS,
    stacks: false,
    maxMs: SLEEP_MS,
    everyMs: 1_000,
    effects: { hp: "2" },
    incapacitates: true,
    endsOnDamage: true,
  },
  {
    id: "daze",
    name: "Dazed",
    description: "Still.",
    tone: "bad",
    fromMs: SLEEP_MS,
    toMs: SLEEP_MS,
    stacks: false,
    maxMs: SLEEP_MS,
    incapacitates: true,
  },
  {
    id: "burned",
    name: "Burned",
    description: "Searing.",
    tone: "bad",
    fromMs: BURN_MS,
    toMs: BURN_MS,
    stacks: false,
    maxMs: BURN_MS,
    everyMs: 1_000,
    effects: { hp: "0 - 1" },
  },
]);

const BED = { x: 1, y: 0, z: 0, stackIndex: 1 };
const STOOL = { x: 0, y: 1, z: 0, stackIndex: 1 };
const DEER_ID = "npc:-1,0,0,1";

function world(): MapFile {
  let map = emptyMap();
  const put = (x: number, y: number, tileId: string) => {
    map = replaceStack(map, x, y, 0, [{ tileId: "grass" }, { tileId, direction: "s" }]);
  };
  put(0, 0, "player");
  put(1, 0, "bed");
  put(0, 1, "stool");
  put(-1, 0, "deer");
  map = replaceStack(map, 0, -1, 0, [{ tileId: "grass" }]);
  put(0, -2, "fire");
  return map;
}

function session(): GameSession {
  return new GameSession(world(), tiles, { statuses: catalogue });
}

function run(play: GameSession, ticks: number) {
  for (let i = 0; i < ticks; i++) play.tick(TICK_MS);
}

function walk(play: GameSession, direction: Direction, cells: number) {
  for (let i = 0; i < cells; i++) {
    play.setInput({ directions: [direction] });
    play.tick(TICK_MS);
    play.setInput({ directions: [] });
    run(play, TICKS_PER_STEP);
  }
}

function held(play: GameSession, id = "local"): string[] {
  return (play.statusesOf(id) ?? []).map((instance) => instance.defId);
}

function snapshotOf(play: GameSession, id: string) {
  return play.actorSnapshots().find((actor) => actor.id === id);
}

function playerOf(play: GameSession) {
  return play.actorSnapshots().find((actor) => actor.tileId === "player")!;
}

function sleep(play: GameSession) {
  expect(play.interact(BED)).toBe(true);
  expect(held(play)).toContain("sleep");
}

describe("a body that cannot act", () => {
  it("takes no step and no turn", () => {
    const play = session();
    sleep(play);
    const before = playerOf(play);
    play.setInput({ directions: ["n"] });
    run(play, TICKS_PER_STEP);
    const after = playerOf(play);
    expect({ x: after.x, y: after.y, direction: after.direction }).toEqual({
      x: before.x,
      y: before.y,
      direction: before.direction,
    });
  });

  it("walks again once the status runs out", () => {
    const play = session();
    sleep(play);
    run(play, (SLEEP_MS / 1000 + 1) * TICKS_PER_SECOND);
    expect(held(play)).toEqual([]);
    walk(play, "n", 1);
    expect(playerOf(play).y).toBe(-1);
  });

  it("presses nothing, picks nothing up and moves nothing", () => {
    const play = session();
    sleep(play);
    expect(play.canInteract(STOOL)).toBe(false);
    expect(play.interact(STOOL)).toBe(false);
    expect(play.canPickUp(STOOL)).toBe(false);
    expect(play.consume({ kind: "floor", ref: STOOL })).toBe(false);
    expect(held(play)).toEqual(["sleep"]);
  });

  it("swings, awake, at the same target", () => {
    const play = session();
    const deerHp = snapshotOf(play, DEER_ID)!.hp!;
    play.setTarget(DEER_ID);
    play.setAttackMode(true);
    run(play, 3 * TICKS_PER_SECOND);
    expect(snapshotOf(play, DEER_ID)!.hp).toBeLessThan(deerHp);
  });

  it("swings at nothing, even with a target and attack mode on", () => {
    const play = session();
    const deerHp = snapshotOf(play, DEER_ID)!.hp;
    sleep(play);
    play.setTarget(DEER_ID);
    play.setAttackMode(true);
    run(play, 3 * TICKS_PER_SECOND);
    expect(snapshotOf(play, DEER_ID)!.hp).toBe(deerHp);
  });

  it("refuses a step a client says it has already taken", () => {
    const play = session();
    expect(play.interact(STOOL)).toBe(true);
    expect(held(play)).toEqual(["daze"]);
    expect(play.requestStep("local", "n")).toBe("refused");
  });
});

describe("sleep", () => {
  it("heals while it runs", () => {
    const play = session();
    walk(play, "n", 2);
    walk(play, "s", 2);
    run(play, (BURN_MS / 1000 + 1) * TICKS_PER_SECOND);
    expect(held(play)).not.toContain("burned");
    const hurt = playerOf(play).hp!;
    expect(hurt).toBeLessThan(playerOf(play).maxHp!);

    sleep(play);
    run(play, 2 * TICKS_PER_SECOND);
    expect(playerOf(play).hp).toBeGreaterThan(hurt);
  });

  it("ends on the first damage taken, and the damage still lands", () => {
    const play = session();
    walk(play, "n", 2);
    expect(held(play)).toContain("burned");
    const burning = playerOf(play).hp!;

    play.runCommand("/status sleep");
    expect(held(play).sort()).toEqual(["burned", "sleep"]);
    run(play, TICKS_PER_SECOND);
    expect(held(play)).not.toContain("sleep");
    expect(playerOf(play).hp).toBeLessThan(burning);
  });
});

describe("a status that only incapacitates", () => {
  it("outlasts damage", () => {
    const play = session();
    walk(play, "n", 2);
    play.runCommand("/status daze");
    run(play, TICKS_PER_SECOND);
    expect(held(play)).toContain("daze");
  });
});
