import { describe, expect, it } from "bun:test";
import tilesJson from "../data/tiles.json";
import statusesJson from "../data/statuses.json";
import { emptyEquipment, type Equipment } from "../app/game/equipment";
import { resolveBattler } from "../app/lib/battler";
import { rating } from "../app/lib/mastery";
import { statusesById } from "../app/lib/status";
import { normalizeTileDef, type TileDef } from "../app/lib/types";
import { tilesByIdFromList } from "../app/lib/validation";
import { choosePrey, healingFood, isThreat, type PreyChoice, type Rated } from "./combat";
import { DEFAULT_TEMPERAMENT } from "./temperament";

const tilesById = tilesByIdFromList((tilesJson as TileDef[]).map(normalizeTileDef));
const statusDefs = statusesById(statusesJson as unknown[]);

function body(tileId: string, x = 0): Rated {
  const battler = resolveBattler(tilesById[tileId]!)!;
  return { id: `${tileId}@${x}`, tileId, x, y: 0, z: 0, hp: 10, rating: rating(battler.masteries) };
}

const newcomer = { ...body("player"), id: "self" };

const RATIO = DEFAULT_TEMPERAMENT.threatRatio;

const firstChoice: PreyChoice = {
  threatRatio: RATIO,
  choices: 1,
  random: () => 0,
  skipped: () => false,
  taken: () => false,
};

describe("isThreat", () => {
  it("is a creature rated above 125% of the bot that can hurt it", () => {
    expect(isThreat(newcomer, body("wolf"), tilesById, RATIO)).toBe(true);
    expect(
      isThreat(newcomer, { ...body("wolf"), rating: newcomer.rating! * 1.2 }, tilesById, RATIO),
    ).toBe(false);
  });

  it("is never a creature with no way to hurt anybody, however it is rated", () => {
    const rabbit = body("rabbit");
    expect(rabbit.rating!).toBeGreaterThan(newcomer.rating! * 1.25);
    expect(isThreat(newcomer, rabbit, tilesById, RATIO)).toBe(false);
  });
});

describe("choosePrey", () => {
  it("passes over a nearer threat for prey further off", () => {
    const prey = choosePrey(newcomer, [body("wolf", 1), body("rabbit", 5)], tilesById, firstChoice);
    expect(prey?.tileId).toBe("rabbit");
  });

  it("takes prey that teaches something before nearer prey that does not", () => {
    const tiny = { ...body("deer", 1), rating: newcomer.rating! / 4 };
    const prey = choosePrey(newcomer, [tiny, body("deer", 6)], tilesById, firstChoice);
    expect(prey?.x).toBe(6);
  });

  it("leaves prey somebody else is beside for prey nobody is", () => {
    const near = body("deer", 1);
    const prey = choosePrey(newcomer, [near, body("deer", 8)], tilesById, {
      ...firstChoice,
      taken: (p) => p.id === near.id,
    });
    expect(prey?.x).toBe(8);
  });
});

describe("healingFood", () => {
  function bagOf(...tileIds: string[]): Equipment {
    return {
      ...emptyEquipment(),
      bag: {
        id: "bag",
        tileId: "basic-bag",
        contents: tileIds.map((tileId, i) => ({ id: `item-${i}`, tileId })),
      },
    };
  }

  it("eats what heals most and never raw meat", () => {
    expect(healingFood(bagOf("raw-meat", "cheese", "cooked-meat"), tilesById, statusDefs)).toBe(2);
    expect(healingFood(bagOf("raw-meat"), tilesById, statusDefs)).toBeNull();
  });
});
