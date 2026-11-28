import { describe, expect, it } from "bun:test";
import { randomCharacterName } from "../app/lib/randomCharacterName";
import { accountFor, NAME_ATTEMPTS, nextMember, ROSTER_SIZE } from "./fleet";
import { seededRandom } from "./temperament";

const NAMES_LEFT = 0;
const NAMES_GONE = NAME_ATTEMPTS;

describe("accountFor", () => {
  it("keeps the pre-roster name for member 0, so existing characters stay in play", () => {
    expect(accountFor(3, 0, 1, "pw").character).toBe(randomCharacterName(seededRandom("bot-3-1")));
  });

  it("gives every member of a roster its own character", () => {
    const names = Array.from(
      { length: ROSTER_SIZE },
      (_, m) => accountFor(3, m, 0, "pw").character,
    );
    expect(new Set(names).size).toBe(ROSTER_SIZE);
  });
});

describe("nextMember", () => {
  it("never seats the member that just signed off while another is free", () => {
    const attempts = [NAMES_LEFT, NAMES_LEFT];
    for (const r of [0, 0.49, 0.5, 0.99]) expect(nextMember(() => r, attempts, 1)).toBe(0);
  });

  it("seats the same member again when it is the only one with a name left", () => {
    expect(nextMember(Math.random, [NAMES_GONE, NAMES_LEFT, NAMES_GONE], 1)).toBe(1);
  });

  it("gives up once every member's names are taken", () => {
    expect(nextMember(Math.random, [NAMES_GONE, NAMES_GONE], null)).toBeNull();
  });
});
