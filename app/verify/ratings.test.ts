import { describe, expect, it } from "vitest";
import statusesJson from "../../data/statuses.json";
import tilesJson from "../../data/tiles.json";
import { fightingStats, resolveBattler } from "../lib/battler";
import { resolveItem } from "../lib/item";
import { statusesById } from "../lib/status";
import { normalizeTiles } from "../lib/types";
import { type BattleOptions, runBattle } from "./battle";
import { evenLevel, heaviestBlow, playerAtLevel } from "./ratings";
import { parseSide } from "./sides";

const tiles = normalizeTiles(tilesJson as unknown[]);
const catalogue = {
  tilesById: Object.fromEntries(tiles.map((tile) => [tile.id, tile])),
  statusDefs: statusesById(statusesJson as unknown[]),
};

const OPTIONS: BattleOptions = {
  seeds: 40,
  seed: 1,
  statuses: true,
  kit: "rolled",
  maxSeconds: 60,
};

function outcomesAt(creature: string, level: number) {
  const sides = {
    A: parseSide(playerAtLevel(level), catalogue.tilesById),
    B: parseSide(creature, catalogue.tilesById),
  };
  return runBattle(sides, catalogue, OPTIONS).outcomes;
}

describe("playerAtLevel", () => {
  it("holds the sword of the highest rung the level has reached", () => {
    expect(playerAtLevel(9)).not.toContain("weapon=");
    expect(playerAtLevel(10)).toContain("weapon=iron-sword");
    expect(playerAtLevel(32)).toContain("weapon=knights-sword");
    expect(playerAtLevel(33)).toContain("weapon=tempered-longsword");
  });
});

describe("evenLevel", () => {
  it("finds the level a player first holds its own at, and loses one below", () => {
    const even = evenLevel("wolf", catalogue, OPTIONS)!;
    expect(even).toBeGreaterThan(1);

    const at = outcomesAt("wolf", even);
    const below = outcomesAt("wolf", even - 1);
    expect(at.wins.count).toBeGreaterThanOrEqual(at.losses.count);
    expect(below.wins.count).toBeLessThan(below.losses.count);
  });
});

describe("heaviestBlow", () => {
  it("counts the heaviest weapon a kit can put in a hand, not only the natural one", () => {
    const sword = catalogue.tilesById["knights-sword"]!;
    const wolf = resolveBattler(catalogue.tilesById.wolf!)!;
    const item = resolveItem(sword);
    if (item?.type !== "weapon") throw new Error("knights-sword is not a weapon");
    const armed = { ...wolf, kit: [{ slot: "weapon" as const, tileId: sword.id, chance: 10 }] };

    expect(heaviestBlow(wolf, catalogue.tilesById)).toBe(
      fightingStats(wolf, wolf.naturalWeapon).damage,
    );
    expect(heaviestBlow(armed, catalogue.tilesById)).toBe(fightingStats(wolf, item).damage);
  });
});
