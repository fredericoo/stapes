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

/** The cats `scripts/island/cast.ts` places beside a townsperson. */
const TOWN_CATS = ["cat-biscuit", "cat-soot", "cat-ghee", "cat-captain", "cat-nettle"];

function yard(bodies: [x: number, y: number, tileId: string][]): GameSession {
  let map: MapFile = emptyMap();
  for (let x = -4; x <= 12; x++) {
    for (let y = -4; y <= 4; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "e" }]);
  for (const [x, y, tileId] of bodies) {
    map = replaceStack(map, x, y, 0, [{ tileId: "grass" }, { tileId, direction: "s" }]);
  }
  return new GameSession(map, tiles, { actorIds: [LOCAL_ACTOR_ID], statuses, traits });
}

function idOf(session: GameSession, tileId: string): string {
  return session.actorSnapshots().find((a) => a.tileId === tileId)!.id;
}

function hpOf(session: GameSession, id: string): number {
  return session.actorSnapshots().find((a) => a.id === id)!.hp!;
}

type Run = { said: string[]; swung: string[] };

function run(session: GameSession, ms: number): Run {
  const said: string[] = [];
  const swung: string[] = [];
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
    session.tick(TICK_MS);
    for (const bubble of session.drainSpeech()) said.push(bubble.text);
    swung.push(...session.drainSwings());
  }
  return { said, swung };
}

function swingAt(session: GameSession, victimId: string, pvp: boolean): Run {
  session.setPvp(pvp);
  session.setTarget(victimId);
  session.setAttackMode(true);
  const done = run(session, 3_000);
  session.setAttackMode(false);
  return done;
}

describe("a townsperson's cat", () => {
  it.each(TOWN_CATS)("%s cannot be hurt by a player with PvP off", (cat) => {
    const session = yard([[1, 0, cat]]);
    const id = idOf(session, cat);
    const before = hpOf(session, id);

    swingAt(session, id, false);

    expect(hpOf(session, id)).toBe(before);
  });

  it("can be hurt by a player with PvP on", () => {
    const session = yard([[1, 0, "cat-biscuit"]]);
    const id = idOf(session, "cat-biscuit");
    const before = hpOf(session, id);

    swingAt(session, id, true);

    expect(hpOf(session, id)).toBeLessThan(before);
  });
});

describe("Ifeoma", () => {
  it("turns on whoever she sees strike Biscuit", () => {
    const session = yard([
      [1, 0, "cat-biscuit"],
      [3, 1, "ifeoma-nwachukwu"],
    ]);
    const ifeoma = idOf(session, "ifeoma-nwachukwu");

    const struck = swingAt(session, idOf(session, "cat-biscuit"), true);
    const after = run(session, 3_000);

    expect(struck.said).toContain("Get away from my Biscuit!");
    expect([...struck.swung, ...after.swung]).toContain(ifeoma);
  });

  it("stands her ground when the culprit hits her back", () => {
    const session = yard([
      [1, 0, "cat-biscuit"],
      [3, 1, "ifeoma-nwachukwu"],
    ]);
    const ifeoma = idOf(session, "ifeoma-nwachukwu");
    swingAt(session, idOf(session, "cat-biscuit"), true);

    const fought = swingAt(session, ifeoma, true);

    expect(fought.said).not.toContain("Please, don't hurt me!");
    expect(fought.swung).toContain(ifeoma);
  });

  it("leaves a blow on somebody else's cat to its owner", () => {
    const session = yard([
      [1, 0, "cat-soot"],
      [3, 1, "ifeoma-nwachukwu"],
    ]);
    const ifeoma = idOf(session, "ifeoma-nwachukwu");

    const struck = swingAt(session, idOf(session, "cat-soot"), true);
    const after = run(session, 3_000);

    expect(struck.said).not.toContain("Get away from my Biscuit!");
    expect([...struck.swung, ...after.swung]).not.toContain(ifeoma);
  });
});
