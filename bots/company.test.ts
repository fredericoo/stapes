import { describe, expect, it } from "bun:test";
import { PLAYER_TILE_ID } from "../app/game/constants";
import { alliesBeside, COMPANY_SEEK_CELLS, leaderOf } from "./company";

function player(id: string, x: number, z = 0, hp: number | null = null) {
  return { id, tileId: PLAYER_TILE_ID, x, y: 0, z, hp };
}

const self = player("m", 0);

describe("leaderOf", () => {
  it("follows the nearest player on its level whose id sorts before its own", () => {
    const actors = [
      self,
      player("a", 9),
      player("b", 4),
      player("c", 2, 1),
      player("z", 1),
      player("d", 2, 0, 0),
      { ...player("e", 1), tileId: "wolf" },
    ];
    expect(leaderOf(self, actors)?.id).toBe("b");
  });

  it("leaves a player out of reach alone", () => {
    expect(leaderOf(self, [self, player("a", COMPANY_SEEK_CELLS + 1)])).toBeNull();
  });

  it("gives every group one player who follows nobody", () => {
    const group = [player("a", 0), player("b", 3), player("c", 6)];
    const leaders = group.filter((member) => leaderOf(member, group) === null);
    expect(leaders.map((member) => member.id)).toEqual(["a"]);
  });
});

describe("alliesBeside", () => {
  it("counts live players near the bot or near the creature it fights", () => {
    const wolf = { x: 20, y: 0, z: 0 };
    const actors = [self, player("a", 2), player("b", 21), player("c", 11), player("d", 1, 0, 0)];
    expect(alliesBeside(self, actors, [wolf])).toBe(2);
  });
});
