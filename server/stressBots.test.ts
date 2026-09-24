import { describe, expect, it } from "bun:test";
import { characterNameProblem, normaliseCharacterName } from "../app/lib/characterName";
import { MAX_USERNAME_LENGTH, MIN_PASSWORD_LENGTH } from "../app/lib/account";
import { MAX_STRESS_BOTS, botIdentity } from "./stressBots";

describe("botIdentity", () => {
  it("names a bot the same way every time, so a higher count reuses the accounts it made", async () => {
    expect(await botIdentity(7, "secret")).toEqual(await botIdentity(7, "secret"));
    expect((await botIdentity(7, "secret")).username).toBe("stressbot_0007");
  });

  it("derives the password from the secret", async () => {
    const one = await botIdentity(7, "one");
    const two = await botIdentity(7, "two");
    expect(one.username).toBe(two.username);
    expect(one.password).not.toBe(two.password);
  });

  it("gives every bot up to the cap an account and a character the target will accept", async () => {
    const usernames = new Set<string>();
    const names = new Set<string>();
    for (let index = 1; index <= MAX_STRESS_BOTS; index++) {
      const bot = await botIdentity(index, "secret");
      expect(characterNameProblem(bot.characterName)).toBeNull();
      // Stored normalised, and a bot finds its character again by this name.
      expect(normaliseCharacterName(bot.characterName)).toBe(bot.characterName);
      expect(bot.username.length).toBeLessThanOrEqual(MAX_USERNAME_LENGTH);
      expect(bot.password.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
      usernames.add(bot.username);
      names.add(bot.characterName);
    }
    expect(usernames.size).toBe(MAX_STRESS_BOTS);
    expect(names.size).toBe(MAX_STRESS_BOTS);
  });
});
