import { describe, expect, it } from "vitest";
import statusesJson from "../../data/statuses.json";
import tilesJson from "../../data/tiles.json";
import { emptyMap, replaceStack } from "../lib/mapData";
import { statusesById } from "../lib/status";
import type { MapFile } from "../lib/types";
import { normalizeTiles } from "../lib/types";
import { BRAIN_TICK_MS, TICK_MS } from "./constants";
import { GameSession } from "./GameSession";

const tiles = normalizeTiles(tilesJson as unknown[]);
const statuses = statusesById(statusesJson as unknown[]);

const FIELD_HALF_CELLS = 16;
const NEAR_CELLS = 3;
const FAR_CELLS = 15;
const SETTLE_TICKS = 10;

const atGate = (guard: string) => new GameSession(gateWith(guard), tiles, { statuses });

function gateWith(guard: string): MapFile {
  let map = emptyMap();
  for (let x = -FIELD_HALF_CELLS; x <= FIELD_HALF_CELLS; x++) {
    for (let y = -FIELD_HALF_CELLS; y <= FIELD_HALF_CELLS; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: guard, direction: "s" }]);
  return replaceStack(map, NEAR_CELLS, 0, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "w" },
  ]);
}

function heard(session: GameSession, ticks = SETTLE_TICKS): string[] {
  const said: string[] = [];
  for (let elapsed = 0; elapsed < ticks * BRAIN_TICK_MS; elapsed += TICK_MS) {
    session.tick(TICK_MS);
    for (const bubble of session.drainSpeech()) said.push(bubble.text);
  }
  return said;
}

const warnings = (said: string[]) => said.filter((text) => text.includes("I wouldn't go"));

describe("a gate guard", () => {
  it("warns a newcomer once, and again only after they have left and come back", () => {
    const session = atGate("north-gate-guard");

    expect(warnings(heard(session))).toEqual([expect.stringContaining("go north")]);
    expect(warnings(heard(session))).toEqual([]);

    session.runCommand(`/goto 0 ${FAR_CELLS} 0`);
    expect(warnings(heard(session))).toEqual([]);
    session.runCommand(`/goto ${NEAR_CELLS} 0 0`);
    expect(warnings(heard(session))).toHaveLength(1);
  });

  it("lets a player past who is rated high enough", () => {
    const session = atGate("north-gate-guard");
    for (const mastery of ["sharp", "toughness", "agility"]) {
      session.runCommand(`/mastery ${mastery} 40`);
    }
    expect(warnings(heard(session))).toEqual([]);
  });

  it("only hints on the beginner's road east", () => {
    const session = atGate("east-gate-guard");
    expect(warnings(heard(session))).toEqual([]);
  });
});
