import { describe, expect, it } from "vitest";
import { DEFAULT_PUSH } from "../lib/interactions";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import type { ActorSnapshot } from "./GameSession";
import {
  listInteractionOptions,
  type InteractionOption,
} from "./interactionOptions";

function tile(
  partial: Record<string, unknown> & Pick<TileDef, "id" | "height">,
): TileDef {
  return normalizeTileDef({
    name: partial.id,
    directional: false,
    variants: {
      default: [
        {
          sprite: {
            tilesetId: "basic",
            rect: { x: 0, y: 0, w: 1, h: 1 },
            base: { x: 0, y: 0 },
          },
          durationMs: 200,
        },
      ],
    },
    attributes: {},
    ...partial,
  });
}

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "rock", height: 1 }),
  tile({
    id: "crate",
    name: "Crate",
    height: 1,
    affectedByGravity: true,
    interactions: { push: DEFAULT_PUSH },
  }),
  tile({
    id: "door_shut",
    name: "Shut door",
    height: 2,
    walkable: false,
    interactions: {
      switch: { targetTileId: "door_open", actionName: "Open" },
    },
  }),
  tile({ id: "door_open", name: "Open door", height: 2 }),
  // A switch with no verb authored on it, which every switch in `data/` was
  // before the field existed.
  tile({
    id: "lever",
    name: "Lever",
    height: 1,
    interactions: { switch: { targetTileId: "door_open" } },
  }),
  // Both authored on one tile, which is what the single interact button
  // resolves by precedence — see `objectOptions`.
  tile({
    id: "lever_crate",
    name: "Lever crate",
    height: 1,
    affectedByGravity: true,
    interactions: { push: DEFAULT_PUSH, switch: { targetTileId: "door_open" } },
  }),
  tile({
    id: "deer",
    name: "Deer",
    height: 2,
    actor: true,
    interactions: {
      battler: { maxHp: 10, atk: 2, def: 0, acc: 50, flee: 0, spd: 50 },
    },
  }),
  // A body that is both shovable and fightable, as the player tile is: the one
  // thing that has to come back as two entries sharing a name.
  tile({
    id: "player",
    name: "Player",
    height: 2,
    actor: true,
    interactions: {
      push: DEFAULT_PUSH,
      battler: { maxHp: 10, atk: 2, def: 0, acc: 50, flee: 0, spd: 50 },
    },
  }),
];

const tilesById = tilesByIdFromList(tiles);

function place(map: MapFile, x: number, y: number, tileIds: string[]): MapFile {
  return replaceStack(
    map,
    x,
    y,
    0,
    tileIds.map((tileId) => ({ tileId })),
  );
}

/** Flat grass, nine by nine, on level 0, centred on the origin. */
function field(): MapFile {
  let map = emptyMap();
  for (let x = -4; x <= 4; x++) {
    for (let y = -4; y <= 4; y++) map = place(map, x, y, ["grass"]);
  }
  return map;
}

function actor(
  id: string,
  tileId: string,
  x: number,
  y: number,
  map: MapFile,
  hp: number | null = null,
): ActorSnapshot {
  return {
    id,
    tileId,
    x,
    y,
    z: 0,
    stackIndex: getStack(map, x, y, 0).length - 1,
    direction: "s",
    walk: null,
    fall: null,
    walkProgress: 0,
    fallProgress: 0,
    slide: null,
    slideProgress: 0,
    hp,
    maxHp: hp === null ? null : 10,
  };
}

/** The player standing at the origin with nothing else on them. */
function playerAt(map: MapFile, x = 0, y = 0): ActorSnapshot {
  return actor("me", "player", x, y, map);
}

/** Just the verbs, for tests that do not care about the rest of an entry. */
function actionsIn(options: InteractionOption[]): string[] {
  return options.map((o) => o.action);
}

describe("listInteractionOptions — objects", () => {
  it("offers a push for a crate in the next cell", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "crate"]);
    const me = playerAt(map);

    const targets = listInteractionOptions(map, tilesById, me, [me], null);

    expect(targets).toHaveLength(1);
    expect(targets[0]!.name).toBe("Crate");
    expect(targets[0]!.action).toBe("push");
    expect(targets[0]!.label).toBe("Push");
    expect(targets[0]!.ref).toEqual({
      x: 1,
      y: 0,
      z: 0,
      stackIndex: 1,
    });
  });

  it("says nothing about a crate a cell further off", () => {
    let map = field();
    map = place(map, 2, 0, ["grass", "crate"]);
    const me = playerAt(map);

    expect(listInteractionOptions(map, tilesById, me, [me], null)).toEqual([]);
  });

  it("says nothing about a crate on the diagonal", () => {
    let map = field();
    map = place(map, 1, 1, ["grass", "crate"]);
    const me = playerAt(map);

    expect(listInteractionOptions(map, tilesById, me, [me], null)).toEqual([]);
  });

  it("drops a push with nowhere to go", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "crate"]);
    // Wall the crate in: the landing cell is nothing at all.
    map = place(map, 2, 0, []);
    const me = playerAt(map);

    expect(listInteractionOptions(map, tilesById, me, [me], null)).toEqual([]);
  });

  it("names a switch by its authored verb", () => {
    let map = field();
    map = place(map, 0, -1, ["grass", "door_shut"]);
    const me = playerAt(map);

    const targets = listInteractionOptions(map, tilesById, me, [me], null);

    expect(targets[0]!.action).toBe("switch");
    expect(targets[0]!.label).toBe("Open");
  });

  it("falls back to the kind when no verb is authored", () => {
    let map = field();
    map = place(map, 0, -1, ["grass", "lever"]);
    const me = playerAt(map);

    const targets = listInteractionOptions(map, tilesById, me, [me], null);

    expect(targets[0]!.label).toBe("Switch");
  });

  it("offers a switch for a door, and never the push under it", () => {
    let map = field();
    map = place(map, 0, -1, ["grass", "lever_crate"]);
    const me = playerAt(map);

    const targets = listInteractionOptions(map, tilesById, me, [me], null);

    // One button, because one tap does one thing — and it does the switch,
    // which is the order `PlaySession.interact` tries them in.
    expect(actionsIn(targets)).toEqual(["switch"]);
  });

  it("ignores an object buried under another tile", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "crate", "rock"]);
    const me = playerAt(map);

    expect(listInteractionOptions(map, tilesById, me, [me], null)).toEqual([]);
  });

  it("lists every reachable object at once", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "crate"]);
    map = place(map, -1, 0, ["grass", "crate"]);
    map = place(map, 0, -1, ["grass", "door_shut"]);
    const me = playerAt(map);

    const targets = listInteractionOptions(map, tilesById, me, [me], null);

    expect(targets).toHaveLength(3);
    expect(actionsIn(targets).sort()).toEqual(["push", "push", "switch"]);
  });
});

describe("listInteractionOptions — battlers", () => {
  it("offers a target on a body one cell away", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "deer"]);
    const me = playerAt(map);
    const deer = actor("npc:deer", "deer", 1, 0, map, 10);

    const targets = listInteractionOptions(map, tilesById, me, [me, deer], null);

    expect(targets).toHaveLength(1);
    expect(targets[0]!.name).toBe("Deer");
    expect(targets[0]!.action).toBe("target");
    expect(targets[0]!.actorId).toBe("npc:deer");
    expect(targets[0]!.active).toBe(false);
  });

  it("offers a target on a body right across the view", () => {
    // Picking a target is pointing, not swinging: anything the caller says is
    // visible can be marked, however far off it is.
    let map = field();
    map = place(map, 4, -4, ["grass", "deer"]);
    const me = playerAt(map);
    const deer = actor("npc:deer", "deer", 4, -4, map, 10);

    const targets = listInteractionOptions(map, tilesById, me, [me, deer], null);

    expect(actionsIn(targets)).toEqual(["target"]);
  });

  it("never offers the viewer their own body", () => {
    const map = field();
    const me = playerAt(map);

    expect(listInteractionOptions(map, tilesById, me, [me], null)).toEqual([]);
  });

  it("marks the body being pointed at", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "deer"]);
    const me = playerAt(map);
    const deer = actor("npc:deer", "deer", 1, 0, map, 10);

    const targets = listInteractionOptions(
      map,
      tilesById,
      me,
      [me, deer],
      "npc:deer",
    );

    expect(targets[0]!.active).toBe(true);
  });

  it("ignores a body with no hit points to take", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "deer"]);
    const me = playerAt(map);
    const inert = actor("npc:deer", "deer", 1, 0, map, null);

    expect(
      listInteractionOptions(map, tilesById, me, [me, inert], null),
    ).toEqual([]);
  });
});

describe("listInteractionOptions — health", () => {
  it("reports what a body has left, so two rats can be told apart", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "deer"]);
    const me = playerAt(map);
    const hurt = { ...actor("npc:deer", "deer", 1, 0, map, 10), hp: 3 };

    const targets = listInteractionOptions(map, tilesById, me, [me, hurt], null);

    expect(targets[0]!.health).toEqual({ hp: 3, maxHp: 10 });
  });

  it("reports it on a shove at the same body as well as on the fight", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "player"]);
    const me = playerAt(map);
    const them = actor("them", "player", 1, 0, map, 10);

    const targets = listInteractionOptions(map, tilesById, me, [me, them], null);

    expect(targets.map((o) => o.health)).toEqual([
      { hp: 10, maxHp: 10 },
      { hp: 10, maxHp: 10 },
    ]);
  });

  it("leaves a thing with no hit points without a reading", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "crate"]);
    const me = playerAt(map);

    const targets = listInteractionOptions(map, tilesById, me, [me], null);

    expect(targets[0]!.health).toBeNull();
  });
});

describe("listInteractionOptions — a body that is both", () => {
  it("lists a shovable body's two verbs as two entries, fight first", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "player"]);
    const me = playerAt(map);
    const them = actor("them", "player", 1, 0, map, 10);

    const targets = listInteractionOptions(map, tilesById, me, [me, them], null);

    expect(actionsIn(targets)).toEqual(["target", "push"]);
  });

  it("names both entries after whoever is in the body, not after its tile", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "player"]);
    const me = playerAt(map);
    const them = actor("them", "player", 1, 0, map, 10);

    const targets = listInteractionOptions(map, tilesById, me, [me, them], null);

    // A person is behind a cookie, so their name is derived from it; reading it
    // off the placement would have the shove announcing a tile called "Player"
    // beside a fight with somebody who has a name.
    expect(new Set(targets.map((o) => o.name)).size).toBe(1);
    expect(targets[0]!.name).not.toBe("Player");
  });
});

describe("listInteractionOptions — ordering", () => {
  it("puts the nearer thing first, whichever way round they arrive", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "crate"]);
    map = place(map, 3, 3, ["grass", "deer"]);
    const me = playerAt(map);
    const deer = actor("npc:deer", "deer", 3, 3, map, 10);

    const targets = listInteractionOptions(map, tilesById, me, [me, deer], null);

    expect(targets.map((o) => o.name)).toEqual(["Crate", "Deer"]);
  });

  it("sorts several bodies by how far off they are", () => {
    let map = field();
    for (const [x, y] of [
      [4, 0],
      [2, 0],
      [1, 0],
    ] as const) {
      map = place(map, x, y, ["grass", "deer"]);
    }
    const me = playerAt(map);
    const far = actor("npc:far", "deer", 4, 0, map, 10);
    const mid = actor("npc:mid", "deer", 2, 0, map, 10);
    const near = actor("npc:near", "deer", 1, 0, map, 10);

    const targets = listInteractionOptions(
      map,
      tilesById,
      me,
      [me, far, mid, near],
      null,
    );

    expect(targets.map((o) => o.actorId)).toEqual([
      "npc:near",
      "npc:mid",
      "npc:far",
    ]);
  });

  it("puts anything a floor away behind everything on this one", () => {
    // A body one storey up is drawn a couple of cells off and is nowhere near
    // you; screen distance alone would interleave it with what is at your feet.
    let map = field();
    map = place(map, 4, 4, ["grass", "deer"]);
    const me = playerAt(map);
    const nearButUpstairs = { ...actor("npc:up", "deer", 1, 0, map, 10), z: 1 };
    const farButHere = actor("npc:here", "deer", 4, 4, map, 10);

    const targets = listInteractionOptions(
      map,
      tilesById,
      me,
      [me, nearButUpstairs, farButHere],
      null,
    );

    expect(targets.map((o) => o.actorId)).toEqual([
      "npc:here",
      "npc:up",
    ]);
  });
});
