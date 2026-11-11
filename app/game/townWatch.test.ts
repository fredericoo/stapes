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

const PLAYER = "Mallory";

function street(bodies: [x: number, y: number, tileId: string][]): MapFile {
  let map = emptyMap();
  for (let x = -4; x <= 26; x++) {
    for (let y = -4; y <= 4; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "e" }]);
  for (const [x, y, tileId] of bodies) {
    map = replaceStack(map, x, y, 0, [{ tileId: "grass" }, { tileId, direction: "s" }]);
  }
  return map;
}

function town(bodies: [x: number, y: number, tileId: string][]): GameSession {
  return new GameSession(street(bodies), tiles, {
    actorIds: [LOCAL_ACTOR_ID],
    names: { [LOCAL_ACTOR_ID]: PLAYER },
    statuses,
    traits,
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

function strikeOnce(session: GameSession, x: number, y: number): string[] {
  const victim = session.actorSnapshots().find((a) => a.x === x && a.y === y)!;
  session.setPvp(true);
  session.setTarget(victim.id);
  session.setAttackMode(true);
  const said = run(session, 1_500);
  session.setAttackMode(false);
  return said;
}

describe("the town", () => {
  it("runs to a guard who is out of sight, and the guard hunts the culprit down", () => {
    const session = town([
      [1, 0, "beggar"],
      [3, 2, "pie-maker"],
      [22, 0, "east-gate-guard"],
    ]);

    const said = [...strikeOnce(session, 1, 0), ...run(session, 20_000)];

    expect(said).toContain("Guards! Guards!");
    expect(said).toContain(`It was ${PLAYER}! Stop them!`);
    expect(said).toContain(`Halt, ${PLAYER}!`);
    const deaths = session.drainDeaths();
    expect(deaths.map((death) => death.id)).toEqual([LOCAL_ACTOR_ID]);
    const guard = session.actorSnapshots().find((a) => a.tileId === "east-gate-guard")!;
    expect(deaths[0]?.blame?.byId).toBe(guard.id);
    expect(session.isWanted(LOCAL_ACTOR_ID)).toBe(false);
  });

  it("does not care about a blow on the training dummy", () => {
    const session = town([
      [1, 0, "training-dummy"],
      [3, 2, "pie-maker"],
      [6, 0, "east-gate-guard"],
    ]);

    const dummy = session.actorSnapshots().find((a) => a.tileId === "training-dummy")!;
    const said = strikeOnce(session, 1, 0);
    const struck = session.actorSnapshots().find((a) => a.id === dummy.id)!;
    expect(struck.hp).toBeLessThan(dummy.hp!);
    said.push(...run(session, 5_000));

    expect(said).not.toContain("Guards! Guards!");
    expect(said).not.toContain(`Halt, ${PLAYER}!`);
    expect(session.isWanted(LOCAL_ACTOR_ID)).toBe(false);
  });
});
