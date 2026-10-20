import { describe, expect, it } from "bun:test";
import { rank, type Contender } from "./realm";

const older: Contender = { characterId: "a", name: "Maren I", rating: 12, createdAt: 1 };
const younger: Contender = { characterId: "b", name: "Tobin I", rating: 12, createdAt: 2 };

describe("ranking for the crown", () => {
  it("puts the older character first on a tie when nobody holds the crown", () => {
    expect(rank([younger, older], null).map((c) => c.name)).toEqual(["Maren I", "Tobin I"]);
  });

  it("keeps the crown with its holder on a tie", () => {
    expect(rank([older, younger], "b").map((c) => c.name)).toEqual(["Tobin I", "Maren I"]);
  });

  it("gives it up to a higher rating", () => {
    const stronger = { ...older, rating: 13 };
    expect(rank([stronger, younger], "b")[0]).toBe(stronger);
  });
});
