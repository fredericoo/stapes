import { describe, expect, it } from "vitest";
import { emptyMap, replaceStack } from "../lib/mapData";
import { MASTERIES, xpForLevel } from "../lib/mastery";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { MASTERY_COMMAND_USAGE, isCommand, parseCommand } from "./commands";
import { displayNameFor } from "./displayName";
import { GameSession } from "./GameSession";

/**
 * Instructions typed where speech goes.
 *
 * Two halves that fail differently, and the second is the one worth having. The
 * grammar below is a pure function of a string and is wrong in ways you can
 * read. The session tests after it are about whether any of it is connected to
 * anything: that a mastery genuinely moves, that the body built from it is
 * rebuilt, that the change is queued for the wire, and — the whole reason a
 * refusal exists — that a line the parser could not understand comes back as a
 * sentence rather than as silence.
 */

describe("reading a typed line", () => {
  it("tells an instruction from something said", () => {
    expect(isCommand("/mastery blade 10")).toBe(true);
    expect(isCommand("hello")).toBe(false);
    // A slash *inside* a sentence is a sentence. Only the first character sorts.
    expect(isCommand("and/or")).toBe(false);
  });

  it("reads a mastery, a level, and nobody in particular", () => {
    expect(parseCommand("/mastery blade 10")).toEqual({
      ok: true,
      command: { name: "mastery", mastery: "blade", level: 10, target: null },
    });
  });

  it("reads self as the same nobody in particular", () => {
    // Two spellings of one request, so the session has one case to handle.
    expect(parseCommand("/mastery blade 10 self")).toEqual(
      parseCommand("/mastery blade 10"),
    );
  });

  it("carries a player id through untouched", () => {
    const id = "8f1d4c2e-0000-4000-8000-000000000001";
    expect(parseCommand(`/mastery arcane 42 ${id}`)).toEqual({
      ok: true,
      command: { name: "mastery", mastery: "arcane", level: 42, target: id },
    });
  });

  it("forgives capitals and doubled spaces", () => {
    // A phone capitalises the first word of everything, and neither of these is
    // a mistake anybody made on purpose.
    expect(parseCommand("  /Mastery   Toughness  7  ")).toEqual({
      ok: true,
      command: {
        name: "mastery",
        mastery: "toughness",
        level: 7,
        target: null,
      },
    });
  });

  it("names the command it has never heard of", () => {
    expect(parseCommand("/fly")).toEqual({
      ok: false,
      refusal: { kind: "unknownCommand", typed: "/fly" },
    });
    // A bare slash is a command with no name, which is the same answer.
    expect(parseCommand("/")).toEqual({
      ok: false,
      refusal: { kind: "unknownCommand", typed: "/" },
    });
  });

  it("asks for the arguments it is short of, and the ones it is over", () => {
    expect(parseCommand("/mastery")).toEqual({
      ok: false,
      refusal: { kind: "badArguments" },
    });
    expect(parseCommand("/mastery blade")).toEqual({
      ok: false,
      refusal: { kind: "badArguments" },
    });
    // The target is the last argument there is, so a fifth word is a typo
    // rather than something to ignore.
    expect(parseCommand("/mastery blade 10 self please")).toEqual({
      ok: false,
      refusal: { kind: "badArguments" },
    });
  });

  it("names the mastery it does not have", () => {
    expect(parseCommand("/mastery blad 10")).toEqual({
      ok: false,
      refusal: { kind: "unknownMastery", typed: "blad" },
    });
  });

  it("accepts every mastery there is", () => {
    // The list and the parser come from one place, and this is what says so: a
    // mastery added to `../lib/mastery` is settable without anybody remembering.
    for (const mastery of MASTERIES) {
      expect(parseCommand(`/mastery ${mastery} 1`)).toMatchObject({
        ok: true,
        command: { mastery },
      });
    }
  });

  it("refuses anything that is not a whole level on the scale", () => {
    for (const typed of ["ten", "10.5", "-1", "101", "10abc", ""]) {
      expect(parseCommand(`/mastery blade ${typed}`)).toMatchObject({
        ok: false,
        refusal: { kind: expect.stringMatching(/badLevel|badArguments/) },
      });
    }
    // Both ends of the scale are levels, not edge cases.
    expect(parseCommand("/mastery blade 0")).toMatchObject({ ok: true });
    expect(parseCommand("/mastery blade 100")).toMatchObject({ ok: true });
  });
});

/**
 * The same commands against a world, because the grammar proves nothing about
 * whether anything happens.
 *
 * The fixtures are `./notices.test.ts`'s, cut to what a command needs: two
 * people who can be told apart, and one creature to be refused.
 */

const frame = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

function tile(
  partial: Record<string, unknown> & Pick<TileDef, "id" | "height">,
): TileDef {
  const interactions = partial.interactions as { battler?: unknown } | undefined;
  return normalizeTileDef({
    name: partial.id,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    kind: interactions?.battler ? "battler" : "prop",
    ...partial,
  });
}

const claws = {
  type: "weapon" as const,
  damage: 3,
  def: 0,
  accuracy: 90,
  variance: 20,
  spd: 90,
  mastery: "fist" as const,
};

const AUTHORED = { fist: 5, toughness: 5, agility: 5 };

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({
    id: "player",
    height: 2,
    directional: true,
    walkable: false,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
    interactions: { battler: { masteries: AUTHORED, naturalWeapon: claws } },
  }),
  tile({
    id: "deer",
    name: "Deer",
    height: 1,
    actor: true,
    walkable: false,
    interactions: { battler: { masteries: AUTHORED, naturalWeapon: claws } },
  }),
];

function field(): MapFile {
  let map = emptyMap();
  for (let x = -2; x <= 2; x++) {
    for (let y = -2; y <= 2; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  map = replaceStack(map, 0, 0, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "e" },
  ]);
  return replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "deer" }]);
}

function world(actorIds: string[] = ["me"]) {
  return new GameSession(field(), tiles, { actorIds, seed: 1 });
}

describe("what a command does to a body", () => {
  it("puts a mastery exactly where it was asked for", () => {
    const session = world();
    session.runCommand("/mastery blade 10", "me");

    // The experience is what is written, because the level is derived from it
    // and a second store of one would be a second answer.
    expect(session.getSnapshot("me").masteryXp.blade).toBe(xpForLevel(10));
    expect(session.drainNotices("me")).toEqual([
      "Your blade mastery is now 10",
    ]);
  });

  it("leaves every other mastery where the tile put it", () => {
    const session = world();
    session.runCommand("/mastery blade 10", "me");

    // The seeded block has to survive the write. A body that learnt Blade and
    // forgot how to stand up is what a missing seed looks like.
    expect(session.getSnapshot("me").masteryXp.toughness).toBe(xpForLevel(5));
  });

  it("counts for something in the body that fights", () => {
    const session = world();
    const before = session.ratingIn("me");
    session.runCommand("/mastery blade 60", "me");

    // Rating is read off the derived body, so this is the memo being dropped as
    // much as it is the number moving: a stale `earnedBody` would answer with
    // the old figure for ever.
    expect(session.ratingIn("me")).toBeGreaterThan(before ?? 0);
  });

  it("queues the change for whoever has to be told", () => {
    const session = world();
    session.runCommand("/mastery blade 10", "me");
    expect(session.drainMasteryChanges()).toContain("me");
  });

  it("says nothing out loud", () => {
    const session = world();
    session.runCommand("/mastery blade 10", "me");
    // A command is not speech, and the client sends it down a different message
    // for exactly this reason — nothing here should have a bubble to draw.
    expect(session.drainSpeech()).toEqual([]);
  });

  it("reaches somebody else by their id, and tells them both", () => {
    const session = world(["me", "you"]);
    session.runCommand("/mastery arcane 12 you", "me");

    expect(session.getSnapshot("you").masteryXp.arcane).toBe(xpForLevel(12));
    expect(session.getSnapshot("me").masteryXp.arcane).toBeUndefined();

    // Two sentences because they are two facts: what your mastery now reads,
    // and what I just did to it.
    expect(session.drainNotices("you")).toEqual([
      "Your arcane mastery is now 12",
    ]);
    expect(session.drainNotices("me")).toEqual([
      // Their handle, through the one function that decides what a body is
      // called — an id in a sentence is a serial number, not a person.
      `${displayNameFor("you")}'s arcane mastery is now 12`,
    ]);
  });

  it("says it once when the somebody else is you", () => {
    const session = world();
    session.runCommand("/mastery blade 10 self", "me");
    expect(session.drainNotices("me")).toHaveLength(1);
  });

  it("names the body that does not learn", () => {
    const session = world();
    const deer = session.actorIds().find((id) => id !== "me")!;
    session.runCommand(`/mastery blade 10 ${deer}`, "me");

    // A creature's masteries are authored and there is no runtime block to
    // write to. The refusal names the deer rather than explaining the engine.
    expect(session.drainNotices("me")).toEqual(["Deer does not learn"]);
    expect(session.drainMasteryChanges()).toEqual([]);
  });

  it("names the id nobody answers to", () => {
    const session = world();
    session.runCommand("/mastery blade 10 nobody", "me");
    expect(session.drainNotices("me")).toEqual([
      'Nobody here answers to "nobody"',
    ]);
  });

  it("hands back the grammar when the line was not one", () => {
    const session = world();
    session.runCommand("/mastery blade", "me");
    // The one thing this whole feature is for: a command typed blind that does
    // nothing is indistinguishable from a command that never arrived.
    expect(session.drainNotices("me")).toEqual([`Say ${MASTERY_COMMAND_USAGE}`]);
  });

  it("says which word it did not understand", () => {
    const session = world();
    session.runCommand("/mastery blad 10", "me");
    expect(session.drainNotices("me")[0]).toContain('"blad"');
  });
});
