import { describe, expect, it } from "vitest";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import { MASTERIES, xpForLevel } from "../lib/mastery";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import {
  COMMAND_USAGE,
  MAX_COMMAND_HP,
  isCommand,
  parseCommand,
} from "./commands";
import { displayNameFor } from "./displayName";
import { NO_VFX } from "../lib/statusVfx";
import type { StatusDef } from "../lib/status";
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
      refusal: { kind: "badArguments", command: "mastery" },
    });
    expect(parseCommand("/mastery blade")).toEqual({
      ok: false,
      refusal: { kind: "badArguments", command: "mastery" },
    });
    // The target is the last argument there is, so a fifth word is a typo
    // rather than something to ignore.
    expect(parseCommand("/mastery blade 10 self please")).toEqual({
      ok: false,
      refusal: { kind: "badArguments", command: "mastery" },
    });
  });


  it("reads a status by the id it was written with", () => {
    // Not lower-cased, unlike a mastery: a status id is a key out of an authored
    // file rather than a word from a list this module owns, and folding its case
    // would refuse a perfectly good `Poison`.
    expect(parseCommand("/status Poison")).toEqual({
      ok: true,
      command: { name: "status", statusId: "Poison", target: null },
    });
    expect(parseCommand("/status burned somebody")).toEqual({
      ok: true,
      command: { name: "status", statusId: "burned", target: "somebody" },
    });
    expect(parseCommand("/status burned self")).toEqual({
      ok: true,
      command: { name: "status", statusId: "burned", target: null },
    });
  });

  it("reads clear as taking everything off, whatever its case", () => {
    for (const line of ["/status clear", "/status CLEAR"]) {
      expect(parseCommand(line)).toEqual({
        ok: true,
        command: { name: "status", statusId: null, target: null },
      });
    }
  });

  it("hands back the status grammar for a status line, not the mastery one", () => {
    expect(parseCommand("/status")).toEqual({
      ok: false,
      refusal: { kind: "badArguments", command: "status" },
    });
    expect(parseCommand("/status burned me please")).toEqual({
      ok: false,
      refusal: { kind: "badArguments", command: "status" },
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

  it("reads a tile named with nowhere in particular as here", () => {
    // Three relative zeroes rather than a fourth shape meaning "unset": the
    // session resolves one kind of cell, and "here" is a cell like any other.
    expect(parseCommand("/tile apple")).toEqual({
      ok: true,
      command: {
        name: "tile",
        tileId: "apple",
        at: {
          x: { kind: "relative", offset: 0 },
          y: { kind: "relative", offset: 0 },
          z: { kind: "relative", offset: 0 },
        },
      },
    });
  });

  it("reads a sign as a step from where you stand", () => {
    expect(parseCommand("/tile apple +1")).toMatchObject({
      ok: true,
      command: { at: { x: { kind: "relative", offset: 1 } } },
    });
    expect(parseCommand("/tile apple -1")).toMatchObject({
      ok: true,
      command: { at: { x: { kind: "relative", offset: -1 } } },
    });
  });

  it("reads a bare number as a cell of the map", () => {
    expect(parseCommand("/tile apple 0 0 0")).toMatchObject({
      ok: true,
      command: {
        at: {
          x: { kind: "absolute", value: 0 },
          y: { kind: "absolute", value: 0 },
          z: { kind: "absolute", value: 0 },
        },
      },
    });
  });

  it("lets the axes disagree about which kind they are", () => {
    // Each axis is read on its own, so "the column I am in, two rows north, on
    // level 3" is one line rather than arithmetic done in the player's head.
    expect(parseCommand("/tile apple +0 -2 3")).toMatchObject({
      ok: true,
      command: {
        at: {
          x: { kind: "relative", offset: 0 },
          y: { kind: "relative", offset: -2 },
          z: { kind: "absolute", value: 3 },
        },
      },
    });
  });

  it("names the word that is not a coordinate", () => {
    for (const typed of ["east", "1.5", "1e3", "12px", "++1"]) {
      expect(parseCommand(`/tile apple ${typed}`)).toEqual({
        ok: false,
        refusal: { kind: "badCoordinate", typed },
      });
    }
  });

  it("asks for the arguments the tile command is short of, and over", () => {
    expect(parseCommand("/tile")).toEqual({
      ok: false,
      refusal: { kind: "badArguments", command: "tile" },
    });
    // There are three axes, so a fourth number is a typo rather than something
    // to ignore.
    expect(parseCommand("/tile apple 1 2 3 4")).toEqual({
      ok: false,
      refusal: { kind: "badArguments", command: "tile" },
    });
  });

  it("forgives capitals in a tile key too", () => {
    // Tile keys are kebab-case, and a phone capitalises the word after a space
    // as readily as the first one.
    expect(parseCommand("/Tile Apple")).toMatchObject({
      ok: true,
      command: { tileId: "apple" },
    });
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
    id: "apple",
    name: "Apple",
    height: 0,
    kind: "item",
    interactions: { item: { type: "consumable", label: "Eat", hp: 1 } },
  }),
  tile({
    id: "player",
    height: 4,
    directional: true,
    walkable: false,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
    interactions: { battler: { masteries: AUTHORED, naturalWeapon: claws } },
  }),
  tile({
    id: "deer",
    name: "Deer",
    height: 2,
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

/** A world that has a status to hand out. @see statusWorld */
const BURN: StatusDef = {
  id: "burned",
  name: "Burned",
  description: "Searing.",
  tone: "bad",
  fromMs: 10_000,
  toMs: 10_000,
  stacks: false,
  maxMs: 10_000,
  everyMs: 0,
  effects: {},
  modifiers: {},
  vfx: NO_VFX,
};

function statusWorld() {
  return new GameSession(field(), tiles, {
    actorIds: ["me"],
    seed: 1,
    statuses: { burned: BURN },
  });
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
    expect(session.drainNotices("me")).toEqual([
      `Say ${COMMAND_USAGE.mastery}`,
    ]);
  });

  it("says which word it did not understand", () => {
    const session = world();
    session.runCommand("/mastery blad 10", "me");
    expect(session.drainNotices("me")[0]).toContain('"blad"');
  });
});


/**
 * The same again for the tile command, where "did anything happen" is a
 * question about the board rather than about a number on a body.
 *
 * The fixture is a five-by-five field of grass with the player standing on
 * `0,0` and a deer on `1,0`, so every case below is one line from that: a cell
 * of your own, a cell one step away, and a cell named outright.
 */

function stackAt(session: GameSession, x: number, y: number, z: number) {
  return getStack(session.getMap(), x, y, z);
}

describe("what a command does to the board", () => {
  it("puts a thing at your feet when you name nowhere", () => {
    const session = world();
    session.runCommand("/tile apple", "me");

    // Under the body rather than on top of it: appending would balance the
    // apple on the summoner's head and carry it around the map.
    expect(stackAt(session, 0, 0, 0).map((placed) => placed.tileId)).toEqual([
      "grass",
      "apple",
      "player",
    ]);
  });

  it("reads your own cell as your feet however it was named", () => {
    const session = world();
    // The long spelling of "here". Landing somewhere else than `/tile apple`
    // does would make the shorthand a different command.
    session.runCommand("/tile apple +0 +0 +0", "me");
    expect(stackAt(session, 0, 0, 0).map((placed) => placed.tileId)).toEqual([
      "grass",
      "apple",
      "player",
    ]);
  });

  it("gives a summoned item an identity", () => {
    const session = world();
    session.runCommand("/tile apple", "me");

    // Minted here rather than left to the load sweep: nothing between now and
    // the next load would hand it one, and an anonymous item is one the client
    // cannot parse out of a container.
    expect(stackAt(session, 0, 0, 0)[1]?.itemId).toMatch(/^itm_/);
  });

  it("steps east and west from where you stand", () => {
    const session = world();
    session.runCommand("/tile apple +1", "me");
    session.runCommand("/tile apple -1", "me");

    // Somebody else's cell is not special-cased — an admin putting an apple on
    // a deer asked for exactly that — so this lands on top of the stack.
    expect(stackAt(session, 1, 0, 0).map((placed) => placed.tileId)).toEqual([
      "grass",
      "deer",
      "apple",
    ]);
    expect(stackAt(session, -1, 0, 0).map((placed) => placed.tileId)).toEqual([
      "grass",
      "apple",
    ]);
  });

  it("takes a cell of the map when the sign is left off", () => {
    const session = world();
    session.runCommand("/tile apple 2 -2 0", "me");
    expect(stackAt(session, 2, -2, 0).map((placed) => placed.tileId)).toEqual([
      "grass",
      "apple",
    ]);
  });

  it("gives a summoned body somebody to drive it", () => {
    const session = world();
    const before = session.actorIds();
    session.runCommand("/tile deer 0 1 0", "me");

    // Placing the tile is the whole of putting a creature in the world, and
    // this is what makes that true of a summoned one as well as an authored
    // one: without the runtime it is scenery shaped like a deer.
    const summoned = session
      .actorIds()
      .filter((id) => !before.includes(id));
    expect(summoned).toEqual(["npc:0,1,0,1"]);
    expect(session.isResident("npc:0,1,0,1")).toBe(true);
    expect(stackAt(session, 0, 1, 0)[1]?.owner).toBe("npc:0,1,0,1");
  });

  it("never names two bodies the same thing", () => {
    const session = world();
    // The name is the cell and the slot, so it comes free the moment its body
    // walks off. Taken here the short way rather than by waiting for a deer to
    // wander: what matters is that the name is already spoken for.
    session.spawn("npc:0,1,0,1");
    session.runCommand("/tile deer 0 1 0", "me");

    // Two bodies under one owner is the shape nothing recovers from: `despawn`
    // removes a single tile, and the other would stand there for ever.
    const owner = stackAt(session, 0, 1, 0)[1]?.owner;
    expect(owner).not.toBe("npc:0,1,0,1");
    expect(session.isResident(owner!)).toBe(true);
  });

  it("says what appeared and where", () => {
    const session = world();
    session.runCommand("/tile apple 2 -2 0", "me");

    // Said even though the thing is on the board, because an absolute cell is
    // very likely off screen — and because it is the only confirmation that a
    // step went the way the player thought it did.
    expect(session.drainNotices("me")).toEqual(["Apple appears at 2, -2, 0"]);
  });

  it("names the tile the catalogue does not have", () => {
    const session = world();
    session.runCommand("/tile aple", "me");
    expect(session.drainNotices("me")).toEqual(['No tile called "aple"']);
  });

  it("refuses the tile that marks where the world starts", () => {
    const session = world();
    session.runCommand("/tile player", "me");

    // A map is allowed exactly one, and a second is a world that cannot be
    // opened again — see `requireSinglePlayer`, which throws rather than
    // choosing.
    expect(session.drainNotices("me")[0]).toContain("where the world starts");
    expect(stackAt(session, 0, 0, 0)).toHaveLength(2);
  });

  it("says where nothing will fit", () => {
    const session = world();
    // Grass and a body already fill the level, and the deer is a whole unit
    // tall. The editor's own fit check answers this, on the same terms.
    session.runCommand("/tile deer", "me");

    expect(session.drainNotices("me")).toEqual(["Nothing will fit at 0, 0, 0"]);
    expect(stackAt(session, 0, 0, 0)).toHaveLength(2);
  });

  it("hands back the grammar when the line was not one", () => {
    const session = world();
    session.runCommand("/tile", "me");
    expect(session.drainNotices("me")).toEqual([`Say ${COMMAND_USAGE.tile}`]);
  });
});

/**
 * The debugging door.
 *
 * There is no other way to see an effect without earning it — every real route
 * to a status is something that happens to you — so these assert the one thing
 * that makes it worth having: that it is a *real* application, through the same
 * function eating a berry goes through, and not a special case that could come
 * to disagree with one.
 */
describe("putting a status on by hand", () => {
  it("puts it on, with a real rolled duration", () => {
    const session = statusWorld();
    session.runCommand("/status burned", "me");

    const [running] = session.getSnapshot("me").self.statuses;
    expect(running?.defId).toBe("burned");
    // Rolled from the def's own range rather than set to some debug constant,
    // which is what makes this the same event a flame produces.
    expect(running?.durationMs).toBe(BURN.fromMs);
    expect(session.drainNotices("me")).toEqual(["Burned."]);
  });

  it("takes everything off again", () => {
    const session = statusWorld();
    session.runCommand("/status burned", "me");
    session.drainNotices("me");

    session.runCommand("/status clear", "me");
    expect(session.getSnapshot("me").self.statuses).toEqual([]);
    expect(session.drainNotices("me")).toEqual(["Nothing is on you now."]);
  });

  it("names the ids it does have when it does not have that one", () => {
    const session = statusWorld();
    session.runCommand("/status frozen", "me");
    const [notice = ""] = session.drainNotices("me");
    expect(notice).toContain('"frozen"');
    // The alternatives, on the terms the mastery refusal names its own: a player
    // re-reading their line to find the wrong word is what both of these avoid.
    expect(notice).toContain("burned");
  });

  it("says so rather than nothing when the world authored no statuses", () => {
    const session = world();
    session.runCommand("/status burned", "me");
    expect(session.drainNotices("me")).toHaveLength(1);
  });

  it("names the id nobody answers to, before looking at the status", () => {
    const session = statusWorld();
    session.runCommand("/status burned nobody", "me");
    expect(session.drainNotices("me")).toEqual([
      'Nobody here answers to "nobody"',
    ]);
  });

  it("hands back the status grammar when the line was not one", () => {
    const session = statusWorld();
    session.runCommand("/status", "me");
    expect(session.drainNotices("me")).toEqual([`Say ${COMMAND_USAGE.status}`]);
  });

  it("reaches somebody else by their id", () => {
    const session = new GameSession(field(), tiles, {
      actorIds: ["me", "you"],
      seed: 1,
      statuses: { burned: BURN },
    });
    session.runCommand("/status burned you", "me");

    expect(session.getSnapshot("you").self.statuses[0]?.defId).toBe("burned");
    // And not on the person who typed it, which is the whole point of a target.
    expect(session.getSnapshot("me").self.statuses).toEqual([]);
  });
});

describe("moving health by hand", () => {
  it("reads a bare figure as a place to put somebody", () => {
    expect(parseCommand("/health 12")).toEqual({
      ok: true,
      command: { name: "health", health: { kind: "set", hp: 12 }, target: null },
    });
  });

  it("reads a sign as a thing to do to them", () => {
    // The distinction `Number` cannot make: "+10" and "10" are the same ten, and
    // the difference between them is the difference between healing somebody
    // and moving them.
    expect(parseCommand("/health +10")).toEqual({
      ok: true,
      command: { name: "health", health: { kind: "shift", by: 10 }, target: null },
    });
    expect(parseCommand("/health -10")).toEqual({
      ok: true,
      command: { name: "health", health: { kind: "shift", by: -10 }, target: null },
    });
  });

  it("carries a target the way every other command does", () => {
    expect(parseCommand("/health +5 somebody")).toEqual({
      ok: true,
      command: { name: "health", health: { kind: "shift", by: 5 }, target: "somebody" },
    });
    expect(parseCommand("/health +5 self")).toEqual(parseCommand("/health +5"));
  });

  it("refuses anything that is not plainly a number", () => {
    // `Number` alone takes all of these, and one of them is a thousand.
    for (const typed of ["1e3", "0x10", "ten", "", "1.5"]) {
      expect(parseCommand(`/health ${typed}`).ok).toBe(false);
    }
  });

  it("refuses a figure past the sanity bound", () => {
    expect(parseCommand(`/health ${MAX_COMMAND_HP + 1}`)).toEqual({
      ok: false,
      refusal: { kind: "badHealth", typed: String(MAX_COMMAND_HP + 1) },
    });
  });

  it("puts a body exactly where it was asked for", () => {
    const session = world();
    const max = session.getSnapshot("me").self.maxHp!;
    session.runCommand("/health 3", "me");

    expect(session.getSnapshot("me").self.hp).toBe(3);
    expect(session.drainNotices("me")).toEqual([`3/${max} health.`]);
  });

  it("caps a set at the most that body can have", () => {
    const session = world();
    const max = session.getSnapshot("me").self.maxHp!;
    // Not a refusal: "full health" is what somebody typing a big number meant,
    // and making them look the ceiling up first is a worse debugging tool.
    session.runCommand("/health 9999", "me");
    expect(session.getSnapshot("me").self.hp).toBe(max);
  });

  it("heals up to the ceiling and no further", () => {
    const session = world();
    const max = session.getSnapshot("me").self.maxHp!;
    session.runCommand("/health 1", "me");
    session.drainNotices("me");

    session.runCommand("/health +2", "me");
    expect(session.getSnapshot("me").self.hp).toBe(3);

    session.runCommand(`/health +${max}`, "me");
    expect(session.getSnapshot("me").self.hp).toBe(max);
  });

  it("takes hit points off through the same door a blow uses", () => {
    const session = world();
    const before = session.getSnapshot("me").self.hp!;
    session.runCommand("/health -2", "me");
    expect(session.getSnapshot("me").self.hp).toBe(before - 2);
  });

  it("kills a body taken to nothing", () => {
    const session = world();
    expect(session.actorSnapshots().some((a) => a.id === "me")).toBe(true);

    session.runCommand("/health 0", "me");
    // Off the board entirely rather than standing at zero. A death by command
    // and a death by blows must not be two codepaths to keep alive, and this is
    // what proves it went through the same door: `kill` takes the runtime out,
    // so there is no longer anybody in this world by that name.
    expect(session.actorSnapshots().some((a) => a.id === "me")).toBe(false);
  });

  it("reaches somebody else by their id", () => {
    const session = world(["me", "you"]);
    session.runCommand("/health 4 you", "me");
    expect(session.getSnapshot("you").self.hp).toBe(4);
    expect(session.getSnapshot("me").self.hp).not.toBe(4);
  });

  it("names the id nobody answers to", () => {
    const session = world();
    session.runCommand("/health 4 nobody", "me");
    expect(session.drainNotices("me")).toEqual([
      'Nobody here answers to "nobody"',
    ]);
  });

  it("hands back the health grammar when the line was not one", () => {
    const session = world();
    session.runCommand("/health", "me");
    expect(session.drainNotices("me")).toEqual([`Say ${COMMAND_USAGE.health}`]);
  });
});
