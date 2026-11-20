import { describe, expect, it } from "vitest";
import statusesJson from "../../data/statuses.json";
import tilesJson from "../../data/tiles.json";
import traitsJson from "../../data/traits.json";
import { emptyMap, replaceStack } from "../lib/mapData";
import { statusesById } from "../lib/status";
import { traitsById } from "../lib/traits";
import type { MapFile } from "../lib/types";
import { normalizeTiles } from "../lib/types";
import { TICK_MS } from "./constants";
import { GameSession, LOCAL_ACTOR_ID } from "./GameSession";

const tiles = normalizeTiles(tilesJson as unknown[]);
const traits = traitsById(traitsJson as unknown[]);
const statuses = statusesById(statusesJson as unknown[]);

const HALF = 12;
const MORNING = 10 * 60;

function field(
  bodies: [x: number, y: number, tileId: string][],
  player: [number, number] = [0, 0],
) {
  let map: MapFile = emptyMap();
  for (let x = -HALF; x <= HALF; x++) {
    for (let y = -HALF; y <= HALF; y++) map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
  }
  map = replaceStack(map, player[0], player[1], 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "e" },
  ]);
  for (const [x, y, tileId] of bodies) {
    map = replaceStack(map, x, y, 0, [{ tileId: "grass" }, { tileId, direction: "s" }]);
  }
  return map;
}

function world(map: MapFile, clock: { minutes: number }) {
  return new GameSession(map, tiles, {
    actorIds: [LOCAL_ACTOR_ID],
    statuses,
    traits,
    clock: () => clock.minutes,
  });
}

function run(session: GameSession, ms: number): string[] {
  const said: string[] = [];
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
    session.tick(TICK_MS);
    for (const bubble of session.drainSpeech()) said.push(bubble.text);
  }
  return said;
}

const body = (session: GameSession, tileId: string) =>
  session.actorSnapshots().find((a) => a.tileId === tileId)!;
const me = (session: GameSession) => session.actorSnapshots().find((a) => a.id === LOCAL_ACTOR_ID)!;
const apart = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

function strike(session: GameSession, tileId: string) {
  session.setTarget(body(session, tileId).id);
  session.setAttackMode(true);
  run(session, 1_500);
  session.setAttackMode(false);
}

describe("a cat", () => {
  it("fights back against a weaker player who hits it", () => {
    const session = world(field([[1, 0, "cat-soot"]]), { minutes: MORNING });
    const hpBefore = me(session).hp!;

    strike(session, "cat-soot");
    run(session, 3_000);

    expect(me(session).hp).toBeLessThan(hpBefore);
  });

  it("runs from a stronger player who hits it", () => {
    const session = world(field([[1, 0, "cat-soot"]]), { minutes: MORNING });
    for (const mastery of ["sharp", "toughness", "agility"]) {
      session.runCommand(`/mastery ${mastery} 40`);
    }

    strike(session, "cat-soot");
    run(session, 3_000);

    expect(apart(body(session, "cat-soot"), me(session))).toBeGreaterThan(3);
  });

  it("comes to a player who says psps", () => {
    const session = world(field([[4, 0, "cat-soot"]]), { minutes: MORNING });

    session.hear(LOCAL_ACTOR_ID, "psps");
    run(session, 4_000);

    expect(apart(body(session, "cat-soot"), me(session))).toBeLessThanOrEqual(2);
  });

  it("hunts a rat it sees", () => {
    const session = world(
      field(
        [
          [0, 0, "cat-soot"],
          [4, 0, "rat"],
        ],
        [-HALF, -HALF],
      ),
      {
        minutes: MORNING,
      },
    );
    const ratHp = body(session, "rat").hp!;

    run(session, 6_000);

    const rat = body(session, "rat");
    expect(rat === undefined || rat.hp! < ratHp).toBe(true);
  });
});

describe("a townsperson", () => {
  it("walks to a bed at bedtime, sleeps, and is back at their post by morning", () => {
    const clock = { minutes: 21 * 60 };
    let map = field([[0, 0, "brannoc-hale"]], [-HALF, -HALF]);
    map = replaceStack(map, 6, 0, 0, [{ tileId: "grass" }, { tileId: "bed" }]);
    const session = world(map, clock);

    run(session, 2_000);
    expect(body(session, "brannoc-hale").x).toBe(0);

    clock.minutes = 22 * 60 + 30;
    run(session, 8_000);
    const abed = body(session, "brannoc-hale");
    expect(abed.x).toBeGreaterThanOrEqual(4);
    expect(abed.statuses.map((s) => s.defId)).toContain("sleep");

    clock.minutes = 7 * 60;
    run(session, 40_000);
    expect(apart(body(session, "brannoc-hale"), { x: 0, y: 0 })).toBeLessThanOrEqual(1);
  });

  it("calls out to a player who comes near, and not to an empty street", () => {
    const quiet = world(field([[0, 0, "pell-marrow"]], [-HALF, -HALF]), { minutes: 9 * 60 });
    expect(run(quiet, 70_000)).not.toContain("Bread off a Flame rune! Pies!");

    const busy = world(field([[0, 0, "pell-marrow"]], [3, 0]), { minutes: 9 * 60 });
    expect(run(busy, 70_000)).toContain("Bread off a Flame rune! Pies!");
  });
});
