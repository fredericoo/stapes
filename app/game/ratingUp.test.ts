import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { emptyMap, replaceStack } from "../lib/mapData";
import { transitionSchema } from "../lib/tileTransition";
import type { MapFile, TileDef } from "../lib/types";
import { FRAME, tile } from "../lib/testTile";
import { TICK_MS } from "./constants";
import { GameSession } from "./GameSession";
import { RATING_UP_EFFECT } from "./ratingUp";

const claws = {
  type: "weapon" as const,
  damage: 6,
  def: 0,
  accuracy: 100,
  variance: 0,
  spd: 90,
  mastery: "fist" as const,
};

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({
    id: "player",
    kind: "battler",
    height: 4,
    directional: true,
    walkable: false,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
    interactions: {
      battler: {
        baseHp: 40,
        masteries: { fist: 1, toughness: 1, agility: 1 },
        naturalWeapon: claws,
      },
    },
  }),
  tile({
    id: "dummy",
    kind: "battler",
    height: 2,
    actor: true,
    walkable: false,
    interactions: {
      battler: {
        baseHp: 400,
        masteries: { fist: 1, toughness: 1, agility: 1 },
        naturalWeapon: claws,
      },
    },
  }),
];

function field(): MapFile {
  let map = emptyMap();
  for (let x = -2; x <= 2; x++) {
    for (let y = -2; y <= 2; y++) map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
  }
  map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "player", direction: "e" }]);
  return replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "dummy" }]);
}

function rating(session: GameSession): number {
  return session.actorSnapshots().find((a) => a.id === "me")!.rating!;
}

function spar() {
  const session = new GameSession(field(), tiles, { actorIds: ["me"], seed: 1 });
  const foe = session.actorIds().find((id) => id !== "me")!;
  session.setTarget(foe, "me");
  session.setAttackMode(true, "me");
  return session;
}

describe("a rating that rises", () => {
  it("is told to the player and burst on their body", () => {
    const session = spar();
    const start = rating(session);
    const notices: string[] = [];
    const bursts: { x: number; y: number }[] = [];
    for (let elapsed = 0; elapsed < 120_000 && rating(session) === start; elapsed += TICK_MS) {
      session.tick(TICK_MS);
      notices.push(...session.drainNotices("me"));
      bursts.push(...session.drainTransitions().filter((n) => n.casterEffect === RATING_UP_EFFECT));
    }
    expect(rating(session)).toBe(start + 1);
    expect(notices.filter((text) => text.includes("rating"))).toEqual([
      `Your rating is now ${start + 1}`,
    ]);
    expect(bursts).toMatchObject([{ x: 0, y: 0 }]);
  });
});

describe("the burst", () => {
  it("is a transition the client accepts", () => {
    expect(v.safeParse(transitionSchema, RATING_UP_EFFECT).issues).toBeUndefined();
  });
});
