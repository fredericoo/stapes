import { describe, expect, it } from "vitest";
import statusesJson from "../../data/statuses.json";
import tilesJson from "../../data/tiles.json";
import { statusesById } from "../lib/status";
import { normalizeTiles } from "../lib/types";
import { type BattleOptions, runBattle } from "./battle";
import { parseSide, SideError } from "./sides";

const tiles = normalizeTiles(tilesJson as unknown[]);
const catalogue = {
  tilesById: Object.fromEntries(tiles.map((tile) => [tile.id, tile])),
  statusDefs: statusesById(statusesJson as unknown[]),
};

const side = (text: string) => parseSide(text, catalogue.tilesById);

const OPTIONS: BattleOptions = { seeds: 100, seed: 1, statuses: true, kit: "none", maxSeconds: 60 };

describe("parseSide", () => {
  it("reads masteries by name and equipment by slot, with none emptying a slot", () => {
    expect(side("player:sharp=15, weapon=knights-sword ,offhand=none")).toEqual({
      text: "player:sharp=15, weapon=knights-sword ,offhand=none",
      tileId: "player",
      masteries: { sharp: 15 },
      equipment: { weapon: "knights-sword", offhand: null },
    });
  });

  it.each([
    ["a tile nobody defines", "wolf-pup"],
    ["a tile with no battler block", "grass"],
    ["a key that is neither a mastery nor a slot", "player:strength=3"],
    ["a mastery past the top of the scale", "player:sharp=101"],
    ["a slot given something it does not take", "player:armor=knights-sword"],
  ])("refuses %s", (_, text) => {
    expect(() => side(text)).toThrow(SideError);
  });
});

describe("runBattle", () => {
  it("scores a mirror match evenly, because every seed is fought both ways round", () => {
    const wolves = { A: side("wolf"), B: side("wolf") };
    const report = runBattle(wolves, catalogue, OPTIONS);
    const { wins, losses, draws, undecided } = report.outcomes;

    expect(report.fights).toBe(2 * OPTIONS.seeds);
    expect(wins.count + losses.count + draws.count + undecided.count).toBe(report.fights);
    expect(wins.count).toBe(losses.count);
    expect(runBattle(wolves, catalogue, OPTIONS)).toEqual(report);
  });

  it("puts each swing on the hand that threw it", () => {
    const report = runBattle(
      {
        A: side("player:sharp=15,ranged=15,weapon=knights-sword,offhand=simple-bow"),
        B: side("training-dummy"),
      },
      catalogue,
      { ...OPTIONS, seeds: 50, statuses: false },
    );
    const hands = report.hands.filter((hand) => hand.side === "A");

    expect(hands.map((hand) => hand.hand).sort()).toEqual(["Knight's Sword", "Simple Bow"]);
    expect(Math.abs(hands[0]!.swings - hands[1]!.swings)).toBeLessThanOrEqual(report.fights);
    for (const hand of hands) {
      for (const rate of ["hit", "missed", "dodged", "absorbed"] as const) {
        expect(Math.abs(hand.sampled[rate] - hand.closedForm[rate])).toBeLessThan(0.04);
      }
    }
  });
});
