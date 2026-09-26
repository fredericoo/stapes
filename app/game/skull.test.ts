import { describe, expect, it } from "vitest";
import { maxHpFrom } from "../lib/battler";
import { ATTACKER_SELECTOR, slot } from "../lib/brain";
import { engravedName } from "../lib/engraving";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import { statusesById } from "../lib/status";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";
import { TICK_MS } from "./constants";
import { GameSession, LOCAL_ACTOR_ID } from "./GameSession";
import { FRAME, tile } from "../lib/testTile";

const SKULL = "bone-skull";

const BASE_HP = 8;
const FRAIL = 1;
const FRAIL_MAX_HP = maxHpFrom(BASE_HP, FRAIL);

const CERTAIN = { accuracy: 100, spd: 100, variance: 0 };

const brawlerBrain = {
  initial: "idle",
  states: {
    idle: { do: [{ action: "hold" as const }] },
    fighting: {
      do: [{ action: "attack" as const, of: slot("foe") }, { action: "hold" as const }],
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
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
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

const boneless = tiles.filter((def) => def.id !== SKULL);

function field(stack: PlacedTile[] = [{ tileId: "grass" }]): MapFile {
  let map = emptyMap();
  for (let x = -2; x <= 2; x++) {
    for (let y = -2; y <= 2; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
    }
  }
  map = replaceStack(map, 0, 0, 0, [...stack, { tileId: "player", direction: "e" }]);
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

const LONG_ENOUGH_TO_KILL_MS = 60_000;

function advanceUntilDead(session: GameSession, id = LOCAL_ACTOR_ID) {
  for (let ms = 0; ms < LONG_ENOUGH_TO_KILL_MS; ms += TICK_MS) {
    if (!session.actorIds().includes(id)) return;
    session.tick(TICK_MS);
  }
  throw new Error("nobody died");
}

function skullAt(session: GameSession, x: number, y: number) {
  const stack = getStack(session.getMap(), x, y, 0);
  return stack.find((placed) => placed.tileId === SKULL) ?? null;
}

function fight(session: GameSession, targetId: string) {
  session.setTarget(targetId);
  session.setAttackMode(true);
}

describe("a player who dies", () => {
  it("leaves a skull engraved with who they were", () => {
    const session = new GameSession(field([{ tileId: "hearth" }]), tiles, {
      statuses: catalogue,
      names: { [LOCAL_ACTOR_ID]: "Arthur" },
    });

    advanceUntilDead(session);

    const skull = skullAt(session, 0, 0);
    expect(skull?.engraved).toBe("Arthur");
    expect(engravedName("%s's skull", skull?.engraved)).toBe("Arthur's skull");
  });

  it("says what the condition was and what was burning them", () => {
    const session = new GameSession(field([{ tileId: "hearth" }]), tiles, {
      statuses: catalogue,
    });

    advanceUntilDead(session);

    expect(skullAt(session, 0, 0)?.description).toBe("Cause of death: Burned by Hearth");
  });

  it("writes the cause where nobody walking past recites it", () => {
    const session = new GameSession(field([{ tileId: "hearth" }]), tiles, {
      statuses: catalogue,
    });

    advanceUntilDead(session);

    expect(skullAt(session, 0, 0)?.inscription).toBeUndefined();
  });

  it("says which blow it was and who swung it", () => {
    const session = new GameSession(withBody(field(), 1, 0, "wolf"), tiles);
    const wolf = session.actorSnapshots().find((a) => a.tileId === "wolf")!;
    fight(session, wolf.id);

    advanceUntilDead(session);

    expect(skullAt(session, 0, 0)?.description).toBe("Cause of death: Fangs by Wolf");
  });

  it("names an unnamed blow something rather than nothing", () => {
    const session = new GameSession(withBody(field(), 1, 0, "nameless-wolf"), tiles);
    const wolf = session.actorSnapshots().find((a) => a.tileId === "nameless-wolf")!;
    fight(session, wolf.id);

    advanceUntilDead(session);

    expect(skullAt(session, 0, 0)?.description).toBe("Cause of death: A blow by Wolf");
  });

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

  it("leaves what its tile says, named after the creature", () => {
    const session = new GameSession(
      withBody(field(), 1, 0, "boss", [{ tileId: "hearth" }]),
      tiles,
      { statuses: catalogue },
    );
    const boss = session.actorSnapshots().find((a) => a.tileId === "boss")!;

    advanceUntilDead(session, boss.id);

    const skull = skullAt(session, 1, 0);
    expect(skull?.engraved).toBe("Troll");
    expect(skull?.description).toBe("Cause of death: Burned by Hearth");
  });
});
