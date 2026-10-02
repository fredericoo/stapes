import { describe, expect, it } from "bun:test";
import tilesJson from "../data/tiles.json";
import statusesJson from "../data/statuses.json";
import { emptyEquipment, type Equipment } from "../app/game/equipment";
import { resolveBattler } from "../app/lib/battler";
import { rating } from "../app/lib/mastery";
import { statusesById } from "../app/lib/status";
import { normalizeTileDef, type TileDef } from "../app/lib/types";
import { tilesByIdFromList } from "../app/lib/validation";
import { choosePrey, creaturesAround, healingFood, type PreyChoice, type Rated } from "./combat";
import { bodyOf } from "./gear";
import { fightOdds, swingsOf, type Fighter } from "./odds";
import { DEFAULT_TEMPERAMENT } from "./temperament";

const tilesById = tilesByIdFromList((tilesJson as TileDef[]).map(normalizeTileDef));
const statusDefs = statusesById(statusesJson as unknown[]);

function body(tileId: string, x = 0): Rated {
  const battler = resolveBattler(tilesById[tileId]!)!;
  return { id: `${tileId}@${x}`, tileId, x, y: 0, z: 0, hp: 10, rating: rating(battler.masteries) };
}

const newcomer = { ...body("player"), id: "self" };

const newcomerSwings = swingsOf(
  bodyOf(tilesById, {})!,
  { ...emptyEquipment(), weapon: { id: "sword", tileId: "rusty-sword" } },
  { tileId: "player", hp: null, maxHp: null, statuses: [] },
  tilesById,
  statusDefs,
);

const fresh: Fighter = { tileId: "player", hp: null, maxHp: null, statuses: [] };

function foe(tileId: string): Fighter {
  return { tileId, hp: null, maxHp: null, statuses: [] };
}

/** The margin a new character with a rusty sword expects against these foes, at full health. */
function margin(...tileIds: string[]): number {
  return fightOdds(newcomerSwings, fresh, tileIds.map(foe), tilesById, statusDefs)!.margin;
}

const firstChoice: PreyChoice<Rated> = {
  margin: (prey) => margin(prey.tileId),
  courage: DEFAULT_TEMPERAMENT.courage,
  choices: 1,
  random: () => 0,
  skipped: () => false,
  shared: () => false,
};

describe("creaturesAround", () => {
  it("leaves out townsfolk, who are battlers with a dialog", () => {
    const around = [body("town-guard", 1), body("beggar", 2), body("wolf", 3)];
    expect(creaturesAround(newcomer, around, tilesById).map((a) => a.tileId)).toEqual(["wolf"]);
  });
});

describe("fightOdds", () => {
  it("has a new character with a sword expect to beat a rat and lose to a wolf", () => {
    expect(margin("rat")).toBeGreaterThan(DEFAULT_TEMPERAMENT.courage);
    expect(margin("wolf")).toBeLessThan(DEFAULT_TEMPERAMENT.dread);
  });

  it("is never afraid of a creature with no way to hurt anybody", () => {
    expect(margin("rabbit")).toBe(Infinity);
  });

  it("weighs two creatures fighting together as worse than either alone", () => {
    expect(margin("cat", "cat")).toBeLessThan(margin("cat") / 2);
  });

  it("weighs a snake's poison and constriction against it", () => {
    const snake = tilesById.snake!;
    const battler = snake.interactions!.battler!;
    const harmless: TileDef = {
      ...snake,
      id: "harmless-snake",
      interactions: {
        ...snake.interactions,
        battler: {
          ...battler,
          naturalWeapon: { ...battler.naturalWeapon, statuses: [] },
          spells: [],
        },
      },
    };
    const withHarmless = { ...tilesById, [harmless.id]: harmless };
    const odds = (tileId: string) =>
      fightOdds(newcomerSwings, fresh, [foe(tileId)], withHarmless, statusDefs)!.margin;
    expect(odds("snake")).toBeLessThan(odds("harmless-snake") * 0.8);
  });

  it("counts the poison already in the bot against the fight ahead", () => {
    const poisoned = {
      ...fresh,
      statuses: [{ defId: "poison", durationMs: 60_000, remainingMs: 60_000, sinceEffectMs: 0 }],
    };
    const odds = (self: typeof fresh) =>
      fightOdds(newcomerSwings, self, [foe("cat")], tilesById, statusDefs)!.margin;
    expect(odds(poisoned)).toBeLessThan(odds(fresh));
  });

  it("expects a fight to go better with other players beside the bot", () => {
    const wolf = [foe("wolf")];
    const alone = fightOdds(newcomerSwings, fresh, wolf, tilesById, statusDefs)!;
    const together = fightOdds(newcomerSwings, fresh, wolf, tilesById, statusDefs, 1, 0, 2)!;
    expect(together.killSeconds).toBeLessThan(alone.killSeconds);
    expect(together.margin).toBeGreaterThan(alone.margin);
  });
});

describe("choosePrey", () => {
  it("passes over a nearer creature it does not expect to beat for prey further off", () => {
    const prey = choosePrey(newcomer, [body("wolf", 1), body("rabbit", 5)], tilesById, firstChoice);
    expect(prey?.tileId).toBe("rabbit");
  });

  it("takes prey that teaches something before nearer prey that does not", () => {
    const tiny = { ...body("deer", 1), rating: newcomer.rating! / 4 };
    const prey = choosePrey(newcomer, [tiny, body("deer", 6)], tilesById, firstChoice);
    expect(prey?.x).toBe(6);
  });

  it("joins prey another player is beside before nearer prey nobody is", () => {
    const far = body("deer", 8);
    const prey = choosePrey(newcomer, [body("deer", 1), far], tilesById, {
      ...firstChoice,
      shared: (p) => p.id === far.id,
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

  it("counts a berry, which heals only through the status it gives", () => {
    expect(healingFood(bagOf("raw-meat", "berry"), tilesById, statusDefs)).toBe(1);
  });
});
