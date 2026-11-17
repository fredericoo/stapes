import { describe, expect, it } from "bun:test";
import { leadersOf, type Contender } from "./realm";

const older: Contender = { characterId: "a", name: "Maren", rating: 12, createdAt: 1 };
const younger: Contender = { characterId: "b", name: "Tobin", rating: 12, createdAt: 2 };

describe("ranking the realm's leaders", () => {
  it("puts the older character first on a tie", () => {
    expect(leadersOf([younger, older]).map((leader) => leader.name)).toEqual(["Maren", "Tobin"]);
  });

  it("puts a higher rating first", () => {
    const stronger = { ...younger, rating: 13 };
    expect(leadersOf([older, stronger])[0]).toEqual({ name: "Tobin", rating: 13 });
  });
});
