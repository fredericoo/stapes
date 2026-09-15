import { describe, expect, it } from "vitest";
import { maxHpFrom } from "../lib/battler";
import { ATTACKER_SELECTOR, slot } from "../lib/brain";
import { engravedName } from "../lib/engraving";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import { statusesById } from "../lib/status";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { TICK_MS } from "./constants";
import { displayNameFor } from "./displayName";
import { GameSession, LOCAL_ACTOR_ID } from "./GameSession";

/**
 * What a person leaves behind.
 *
 * A skull is engraved with whose it is and described by what finished them off,
 * so what is asserted here is the two halves of that line arriving from the
 * three directions harm comes from — a blow, a condition, and something eaten —
 * plus the one body that leaves none.
 */

/** What the bodies below are authored to leave. */
const SKULL = "bone-skull";

const frame = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

function tile(
  partial: Record<string, unknown> & Pick<TileDef, "id">,
): TileDef {
  return normalizeTileDef({
    name: partial.id,
    height: 0,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    kind: "prop",
    ...partial,
  });
}

/**
 * Small enough that a burn or a couple of blows finishes it inside the bound
 * below — these tests are about what is left on the floor, not about how long
 * a fight takes.
 */
const BASE_HP = 8;
const FRAIL = 1;
const FRAIL_MAX_HP = maxHpFrom(BASE_HP, FRAIL);

const CERTAIN = { accuracy: 100, spd: 100, variance: 0 };

/** A creature that swings at whoever hit it and never stops. */
const brawlerBrain = {
  initial: "idle",
  states: {
    idle: { do: [{ action: "hold" as const }] },
    fighting: {
      do: [
        { action: "attack" as const, of: slot("foe") },
        { action: "hold" as const },
      ],
    },
  },
  transitions: [
    {
      from: "any",
      if: { cond: "attacked" as const },
      bind: { foe: ATTACKER_SELECTOR },
      to: "fighting",
    },
  ],
};

const BURN_MS = 4_000;

const catalogue = statusesById([
  {
    id: "burned",
    name: "Burned",
    description: "Searing. Hurts fast, and is over fast.",
    tone: "bad",
    fromMs: BURN_MS,
    toMs: BURN_MS,
    stacks: true,
    maxMs: BURN_MS * 3,
    everyMs: 1_000,
    effects: { hp: "0 - max(4, ceil(MAX_HP / 10))" },
  },
]);

const tiles: TileDef[] = [
  tile({ id: "grass" }),
  tile({
    id: "player",
    name: "Player",
    height: 4,
    kind: "battler",
    directional: true,
    walkable: false,
    lightPassing: true,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
    interactions: {
      battler: {
        baseHp: BASE_HP,
        masteries: { toughness: FRAIL },
        naturalWeapon: {
          type: "weapon",
          name: "Bare hands",
          damage: 1,
          def: 0,
          mastery: "fist",
          ...CERTAIN,
        },
        remains: SKULL,
      },
    },
  }),
  // The motivating creature: it hits back, and what it hits back with has a
  // name of its own — there is no tile to read one off.
  tile({
    id: "wolf",
    name: "Wolf",
    height: 2,
    kind: "battler",
    actor: true,
    walkable: false,
    interactions: {
      battler: {
        baseHp: BASE_HP,
        masteries: { toughness: FRAIL },
        naturalWeapon: {
          type: "weapon",
          name: "Fangs",
          damage: FRAIL_MAX_HP,
          def: 0,
          mastery: "sharp",
          ...CERTAIN,
        },
      },
      brain: brawlerBrain,
    },
  }),
  // The same creature with nothing written on its teeth, which is every body
  // authored before a blow had to be named.
  tile({
    id: "nameless-wolf",
    name: "Wolf",
    height: 2,
    kind: "battler",
    actor: true,
    walkable: false,
    interactions: {
      battler: {
        baseHp: BASE_HP,
        masteries: { toughness: FRAIL },
        naturalWeapon: {
          type: "weapon",
          damage: FRAIL_MAX_HP,
          def: 0,
          mastery: "sharp",
          ...CERTAIN,
        },
      },
      brain: brawlerBrain,
    },
  }),
  // The case the field exists for: a creature worth remembering, which is not
  // most of them. Otherwise the wolf above, which leaves nothing.
  tile({
    id: "boss",
    name: "Troll",
    height: 2,
    kind: "battler",
    actor: true,
    walkable: false,
    interactions: {
      battler: {
        baseHp: BASE_HP,
        masteries: { toughness: FRAIL },
        naturalWeapon: {
          type: "weapon",
          name: "Fists",
          damage: FRAIL_MAX_HP,
          def: 0,
          mastery: "blunt",
          ...CERTAIN,
        },
        remains: SKULL,
      },
    },
  }),
  tile({
    id: "hearth",
    name: "Hearth",
    interactions: { addStatus: { trigger: "step", statusId: "burned" } },
  }),
  tile({
    id: SKULL,
    name: "%s's skull",
    kind: "item",
    interactions: { item: { type: "artifact" } },
  }),
];

/** Everything but the skull, for the world whose catalogue never had one. */
const boneless = tiles.filter((def) => def.id !== SKULL);

function field(stack: PlacedTile[] = [{ tileId: "grass" }]): MapFile {
  let map = emptyMap();
  for (let x = -2; x <= 2; x++) {
    for (let y = -2; y <= 2; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  map = replaceStack(map, 0, 0, 0, [
    ...stack,
    { tileId: "player", direction: "e" },
  ]);
  return map;
}

function withBody(
  map: MapFile,
  x: number,
  y: number,
  tileId: string,
  under: PlacedTile[] = [{ tileId: "grass" }],
): MapFile {
  return replaceStack(map, x, y, 0, [...under, { tileId }]);
}

/** Long enough for any of these to finish, and a failure rather than a hang. */
const LONG_ENOUGH_TO_KILL_MS = 60_000;

function advanceUntilDead(session: GameSession, id = LOCAL_ACTOR_ID) {
  for (let ms = 0; ms < LONG_ENOUGH_TO_KILL_MS; ms += TICK_MS) {
    if (!session.actorIds().includes(id)) return;
    session.tick(TICK_MS);
  }
  throw new Error("nobody died");
}

/** The skull lying in one cell, or null where none is. */
function skullAt(session: GameSession, x: number, y: number) {
  const stack = getStack(session.getMap(), x, y, 0);
  return stack.find((placed) => placed.tileId === SKULL) ?? null;
}

/** Swing at whatever is standing beside the player until somebody falls. */
function fight(session: GameSession, targetId: string) {
  session.setTarget(targetId);
  session.setAttackMode(true);
}

describe("a player who dies", () => {
  it("leaves a skull engraved with who they were", () => {
    const session = new GameSession(field([{ tileId: "hearth" }]), tiles, {
      statuses: catalogue,
    });

    advanceUntilDead(session);

    const skull = skullAt(session, 0, 0);
    expect(skull?.engraved).toBe(displayNameFor(LOCAL_ACTOR_ID));
    expect(engravedName("%s's skull", skull?.engraved)).toBe(
      `${displayNameFor(LOCAL_ACTOR_ID)}'s skull`,
    );
  });

  it("says what the condition was and what was burning them", () => {
    const session = new GameSession(field([{ tileId: "hearth" }]), tiles, {
      statuses: catalogue,
    });

    advanceUntilDead(session);

    expect(skullAt(session, 0, 0)?.description).toBe("Burned by Hearth");
  });

  it("says which blow it was and who swung it", () => {
    const session = new GameSession(withBody(field(), 1, 0, "wolf"), tiles);
    const wolf = session.actorSnapshots().find((a) => a.tileId === "wolf")!;
    fight(session, wolf.id);

    advanceUntilDead(session);

    // Named after its tile rather than out of the name generator, which is what
    // `./displayName` already decides for everything a creature is called.
    expect(skullAt(session, 0, 0)?.description).toBe("Fangs by Wolf");
  });

  /**
   * A body whose teeth nobody named still killed somebody, and the line has to
   * read as a sentence rather than trail off into the attribution.
   */
  it("names an unnamed blow something rather than nothing", () => {
    const session = new GameSession(
      withBody(field(), 1, 0, "nameless-wolf"),
      tiles,
    );
    const wolf = session
      .actorSnapshots()
      .find((a) => a.tileId === "nameless-wolf")!;
    fight(session, wolf.id);

    advanceUntilDead(session);

    expect(skullAt(session, 0, 0)?.description).toBe("A blow by Wolf");
  });

  /**
   * Minted on the way out like anything else entering the world, so two skulls
   * from two deaths are two things rather than one that exists twice.
   */
  it("mints the skull an identity", () => {
    const session = new GameSession(field([{ tileId: "hearth" }]), tiles, {
      statuses: catalogue,
    });

    advanceUntilDead(session);

    expect(skullAt(session, 0, 0)?.itemId).toMatch(/^itm_/);
  });

  it("leaves none where the catalogue has no skull", () => {
    const session = new GameSession(field([{ tileId: "hearth" }]), boneless, {
      statuses: catalogue,
    });

    advanceUntilDead(session);

    expect(skullAt(session, 0, 0)).toBeNull();
  });
});

/**
 * Not a rule about people any more, but still the default: what a body leaves
 * is authored, and almost nothing authors it. A world where every rat leaves a
 * keepsake is knee-deep in rats' skulls by the evening.
 *
 * Both of these die burned where they stand rather than being killed, because
 * a creature the player can beat is a creature that cannot kill the player in
 * the tests above.
 */
describe("a creature that dies", () => {
  it("leaves nothing when its tile says nothing", () => {
    const session = new GameSession(
      withBody(field(), 1, 0, "wolf", [{ tileId: "hearth" }]),
      tiles,
      { statuses: catalogue },
    );
    const wolf = session.actorSnapshots().find((a) => a.tileId === "wolf")!;

    advanceUntilDead(session, wolf.id);

    expect(skullAt(session, 1, 0)).toBeNull();
  });

  /** The case the field exists for. */
  it("leaves what its tile says, named after the creature", () => {
    const session = new GameSession(
      withBody(field(), 1, 0, "boss", [{ tileId: "hearth" }]),
      tiles,
      { statuses: catalogue },
    );
    const boss = session.actorSnapshots().find((a) => a.tileId === "boss")!;

    advanceUntilDead(session, boss.id);

    const skull = skullAt(session, 1, 0);
    // Its tile's name, which is what `./displayName` calls every creature —
    // so an author picks the art and the world writes on it.
    expect(skull?.engraved).toBe("Troll");
    expect(skull?.description).toBe("Burned by Hearth");
  });
});
