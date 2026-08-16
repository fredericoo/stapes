import { describe, expect, it } from "vitest";
import { DEFAULT_PUSH } from "../lib/interactions";
import {
  DEFAULT_CONSUMABLE,
  DEFAULT_CONTAINER,
  DEFAULT_WEAPON,
} from "../lib/item";
import type { Equipment } from "./equipment";
import { emptyEquipment } from "./equipment";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import type { ActorSnapshot } from "./GameSession";
import {
  interactionText,
  listInteractionOptions,
  topInteractionAt,
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
  tile({
    id: "sword",
    name: "Sword",
    height: 0,
    kind: "item",
    intangible: true,
    interactions: { item: DEFAULT_WEAPON },
  }),
  tile({
    id: "bag",
    name: "Bag",
    height: 0,
    kind: "item",
    intangible: true,
    interactions: { item: DEFAULT_CONTAINER },
  }),
  tile({
    id: "chest",
    name: "Chest",
    height: 0,
    kind: "item",
    intangible: true,
    interactions: { item: { ...DEFAULT_CONTAINER, size: 2, equippable: false } },
  }),
  tile({
    id: "cherry",
    name: "Cherry",
    height: 0,
    kind: "item",
    intangible: true,
    interactions: { item: { ...DEFAULT_CONSUMABLE } },
  }),
  tile({
    id: "mystery-snack",
    name: "Mystery snack",
    height: 0,
    kind: "item",
    intangible: true,
    // No verb authored, which every consumable written by hand could be.
    interactions: { item: { type: "consumable", hp: 1 } },
  }),
  // Authored as both, so the switch → pickUp precedence has something to bite.
  tile({
    id: "switch_sword",
    name: "Switch sword",
    height: 0,
    kind: "item",
    intangible: true,
    interactions: {
      item: DEFAULT_WEAPON,
      switch: { targetTileId: "door_open", actionName: "Pull" },
    },
  }),
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
    carriedLights: [],
  };
}

/** The player standing at the origin with nothing else on them. */
function playerAt(map: MapFile, x = 0, y = 0): ActorSnapshot {
  return actor("me", "player", x, y, map);
}

/** A player with an empty four-slot bag on their back — the starting kit. */
const KIT: Equipment = {
  weapon: null,
  bag: { id: "itm_bag", tileId: "bag", contents: [] },
};

/** Same bag, with nothing left to put in it. */
const FULL_KIT: Equipment = {
  weapon: null,
  bag: {
    id: "itm_bag",
    tileId: "bag",
    contents: Array.from({ length: DEFAULT_CONTAINER.size }, (_, i) => ({
      id: `itm_${i}`,
      tileId: "sword",
    })),
  },
};

/** Carrying nothing at all — no bag to put anything into. */
const NO_BAG: Equipment = emptyEquipment();

/** Just the verbs, for tests that do not care about the rest of an entry. */
function actionsIn(options: InteractionOption[]): string[] {
  return options.map((o) => o.action);
}

describe("listInteractionOptions — objects", () => {
  it("offers a push for a crate in the next cell", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "crate"]);
    const me = playerAt(map);

    const targets = listInteractionOptions(map, tilesById, me, [me], null, KIT);

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

    expect(listInteractionOptions(map, tilesById, me, [me], null, KIT)).toEqual([]);
  });

  it("says nothing about a crate on the diagonal", () => {
    let map = field();
    map = place(map, 1, 1, ["grass", "crate"]);
    const me = playerAt(map);

    expect(listInteractionOptions(map, tilesById, me, [me], null, KIT)).toEqual([]);
  });

  it("drops a push with nowhere to go", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "crate"]);
    // Wall the crate in: the landing cell is nothing at all.
    map = place(map, 2, 0, []);
    const me = playerAt(map);

    expect(listInteractionOptions(map, tilesById, me, [me], null, KIT)).toEqual([]);
  });

  it("names a switch by its authored verb", () => {
    let map = field();
    map = place(map, 0, -1, ["grass", "door_shut"]);
    const me = playerAt(map);

    const targets = listInteractionOptions(map, tilesById, me, [me], null, KIT);

    expect(targets[0]!.action).toBe("switch");
    expect(targets[0]!.label).toBe("Open");
  });

  it("falls back to the kind when no verb is authored", () => {
    let map = field();
    map = place(map, 0, -1, ["grass", "lever"]);
    const me = playerAt(map);

    const targets = listInteractionOptions(map, tilesById, me, [me], null, KIT);

    expect(targets[0]!.label).toBe("Switch");
  });

  it("offers a switch for a door, and never the push under it", () => {
    let map = field();
    map = place(map, 0, -1, ["grass", "lever_crate"]);
    const me = playerAt(map);

    const targets = listInteractionOptions(map, tilesById, me, [me], null, KIT);

    // One button, because one tap does one thing — and it does the switch,
    // which is the order `PlaySession.interact` tries them in.
    expect(actionsIn(targets)).toEqual(["switch"]);
  });

  it("ignores an object buried under another tile", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "crate", "rock"]);
    const me = playerAt(map);

    expect(listInteractionOptions(map, tilesById, me, [me], null, KIT)).toEqual([]);
  });

  it("lists every reachable object at once", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "crate"]);
    map = place(map, -1, 0, ["grass", "crate"]);
    map = place(map, 0, -1, ["grass", "door_shut"]);
    const me = playerAt(map);

    const targets = listInteractionOptions(map, tilesById, me, [me], null, KIT);

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

    const targets = listInteractionOptions(map, tilesById, me, [me, deer], null, KIT);

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

    const targets = listInteractionOptions(map, tilesById, me, [me, deer], null, KIT);

    expect(actionsIn(targets)).toEqual(["target"]);
  });

  it("never offers the viewer their own body", () => {
    const map = field();
    const me = playerAt(map);

    expect(listInteractionOptions(map, tilesById, me, [me], null, KIT)).toEqual([]);
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
      KIT,
    );

    expect(targets[0]!.active).toBe(true);
  });

  it("ignores a body with no hit points to take", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "deer"]);
    const me = playerAt(map);
    const inert = actor("npc:deer", "deer", 1, 0, map, null);

    expect(
      listInteractionOptions(map, tilesById, me, [me, inert], null, KIT),
    ).toEqual([]);
  });
});

describe("listInteractionOptions — health", () => {
  it("reports what a body has left, so two rats can be told apart", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "deer"]);
    const me = playerAt(map);
    const hurt = { ...actor("npc:deer", "deer", 1, 0, map, 10), hp: 3 };

    const targets = listInteractionOptions(map, tilesById, me, [me, hurt], null, KIT);

    expect(targets[0]!.health).toEqual({ hp: 3, maxHp: 10 });
  });

  it("reports it on a shove at the same body as well as on the fight", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "player"]);
    const me = playerAt(map);
    const them = actor("them", "player", 1, 0, map, 10);

    const targets = listInteractionOptions(map, tilesById, me, [me, them], null, KIT);

    expect(targets.map((o) => o.health)).toEqual([
      { hp: 10, maxHp: 10 },
      { hp: 10, maxHp: 10 },
    ]);
  });

  it("leaves a thing with no hit points without a reading", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "crate"]);
    const me = playerAt(map);

    const targets = listInteractionOptions(map, tilesById, me, [me], null, KIT);

    expect(targets[0]!.health).toBeNull();
  });
});

describe("listInteractionOptions — a body that is both", () => {
  it("lists a shovable body's two verbs as two entries, fight first", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "player"]);
    const me = playerAt(map);
    const them = actor("them", "player", 1, 0, map, 10);

    const targets = listInteractionOptions(map, tilesById, me, [me, them], null, KIT);

    expect(actionsIn(targets)).toEqual(["target", "push"]);
  });

  it("names both entries after whoever is in the body, not after its tile", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "player"]);
    const me = playerAt(map);
    const them = actor("them", "player", 1, 0, map, 10);

    const targets = listInteractionOptions(map, tilesById, me, [me, them], null, KIT);

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

    const targets = listInteractionOptions(map, tilesById, me, [me, deer], null, KIT);

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
      KIT,
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
      KIT,
    );

    expect(targets.map((o) => o.actorId)).toEqual([
      "npc:here",
      "npc:up",
    ]);
  });
});

describe("listInteractionOptions — picking things up", () => {
  it("offers a pick-up for an item in the next cell", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "sword"]);
    const me = playerAt(map);

    const options = listInteractionOptions(map, tilesById, me, [me], null, KIT);

    expect(options).toHaveLength(1);
    expect(options[0]!.action).toBe("pickUp");
    expect(options[0]!.label).toBe("Pick up");
    expect(options[0]!.name).toBe("Sword");
  });

  /**
   * The reach is round, unlike a push. A player who could not take the sword
   * lying at their own feet, or one step diagonally, would read that as a bug
   * rather than as a rule.
   */
  it("reaches diagonally, where a push does not", () => {
    let map = field();
    map = place(map, 1, 1, ["grass", "sword"]);
    const me = playerAt(map);

    expect(
      actionsIn(listInteractionOptions(map, tilesById, me, [me], null, KIT)),
    ).toEqual(["pickUp"]);
  });

  it("reaches the cell the player is standing in", () => {
    let map = field();
    map = place(map, 0, 0, ["grass", "sword"]);
    const me = playerAt(map);

    expect(
      actionsIn(listInteractionOptions(map, tilesById, me, [me], null, KIT)),
    ).toEqual(["pickUp"]);
  });

  it("does not reach two cells out", () => {
    let map = field();
    map = place(map, 2, 0, ["grass", "sword"]);
    const me = playerAt(map);

    expect(listInteractionOptions(map, tilesById, me, [me], null, KIT)).toEqual(
      [],
    );
  });

  it("says nothing about an item buried under something else", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "sword", "rock"]);
    const me = playerAt(map);

    expect(listInteractionOptions(map, tilesById, me, [me], null, KIT)).toEqual(
      [],
    );
  });

  it("says nothing when the bag is full", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "sword"]);
    const me = playerAt(map);

    expect(
      listInteractionOptions(map, tilesById, me, [me], null, FULL_KIT),
    ).toEqual([]);
  });

  it("says nothing when there is no bag to put it in", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "sword"]);
    const me = playerAt(map);

    expect(
      listInteractionOptions(map, tilesById, me, [me], null, NO_BAG),
    ).toEqual([]);
  });

  /** An authored switch is an explicit intent, and wins over lifting the thing. */
  it("lets a switch win over a pick-up on the same tile", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "switch_sword"]);
    const me = playerAt(map);

    const options = listInteractionOptions(map, tilesById, me, [me], null, KIT);
    const kinds = options.filter((o) => o.action !== "open");

    expect(kinds).toHaveLength(1);
    expect(kinds[0]!.action).toBe("switch");
    expect(kinds[0]!.label).toBe("Pull");
  });

  it("never offers the viewer their own body, now that the sweep is round", () => {
    const map = field();
    const me = playerAt(map);

    expect(listInteractionOptions(map, tilesById, me, [me], null, KIT)).toEqual(
      [],
    );
  });
});

describe("listInteractionOptions — bags on the floor", () => {
  it("offers a bag as two rows, pick up before open", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "bag"]);
    const me = playerAt(map);

    // Bare-backed, so the bag on the floor is genuinely takeable.
    const options = listInteractionOptions(
      map,
      tilesById,
      me,
      [me],
      null,
      NO_BAG,
    );

    // Taking it comes first. The only time both are offered is when your back
    // is bare, which is exactly when you want the bag itself.
    expect(actionsIn(options)).toEqual(["pickUp", "open"]);
    expect(options.every((o) => o.name === "Bag")).toBe(true);
  });

  /**
   * Containers do not nest, so a bag can only ever go on a back that is free.
   * With one already there, opening is the only thing left to do with it — and
   * a bag with room inside it changes nothing, because a bag is not something
   * that goes *in* a bag.
   */
  it("offers only open for a bag when one is already worn", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "bag"]);
    const me = playerAt(map);

    expect(
      actionsIn(listInteractionOptions(map, tilesById, me, [me], null, KIT)),
    ).toEqual(["open"]);
  });

  it("never offers to pick up a chest, however much room there is", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "chest"]);
    const me = playerAt(map);

    expect(
      actionsIn(listInteractionOptions(map, tilesById, me, [me], null, NO_BAG)),
    ).toEqual(["open"]);
  });

  it("offers open even with a full bag, since looking costs nothing", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "chest"]);
    const me = playerAt(map);

    expect(
      actionsIn(listInteractionOptions(map, tilesById, me, [me], null, FULL_KIT)),
    ).toEqual(["open"]);
  });

  it("does not offer open for something that is not a container", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "sword"]);
    const me = playerAt(map);

    expect(
      actionsIn(listInteractionOptions(map, tilesById, me, [me], null, KIT)),
    ).toEqual(["pickUp"]);
  });
});

describe("listInteractionOptions — consumables on the floor", () => {
  it("offers a cherry as two rows, pick up before eat", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "cherry"]);
    const me = playerAt(map);

    const options = listInteractionOptions(map, tilesById, me, [me], null, KIT);

    // Taking it first: lifting is reversible where eating is not, so the tap's
    // default is the safe verb and the destructive one is a row you choose.
    expect(actionsIn(options)).toEqual(["pickUp", "consume"]);
    expect(options.every((o) => o.name === "Cherry")).toBe(true);
  });

  it("names the row by the authored verb", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "cherry"]);
    const me = playerAt(map);

    const eat = listInteractionOptions(map, tilesById, me, [me], null, KIT).find(
      (o) => o.action === "consume",
    );
    expect(eat?.label).toBe("Eat");
    expect(interactionText(eat!)).toBe("Eat Cherry");
  });

  it("falls back to a generic verb when none is authored", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "mystery-snack"]);
    const me = playerAt(map);

    const eat = listInteractionOptions(map, tilesById, me, [me], null, KIT).find(
      (o) => o.action === "consume",
    );
    expect(eat?.label).toBe("Use");
  });

  // A full bag refuses the pickup and not the meal — eating it off the ground
  // is exactly what a player with no room left wants to do with a cherry.
  it("still offers the meal when the bag is full", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "cherry"]);
    const me = playerAt(map);

    expect(
      actionsIn(listInteractionOptions(map, tilesById, me, [me], null, FULL_KIT)),
    ).toEqual(["consume"]);
  });

  it("does not reach two cells out", () => {
    let map = field();
    map = place(map, 2, 0, ["grass", "cherry"]);
    const me = playerAt(map);

    expect(listInteractionOptions(map, tilesById, me, [me], null, KIT)).toEqual(
      [],
    );
  });

  it("says nothing about one buried under something else", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "cherry", "rock"]);
    const me = playerAt(map);

    expect(listInteractionOptions(map, tilesById, me, [me], null, KIT)).toEqual(
      [],
    );
  });
});

/**
 * A body is not a lid.
 *
 * The round pick-up reach takes in the cell you are standing in on purpose, and
 * that is exactly the cell your own body covers — so a rule that read "top of
 * the stack" literally made the most obvious case in the game impossible: you
 * could not take the sword you were standing on, and could not open the chest
 * you had walked onto.
 */
describe("listInteractionOptions — standing on things", () => {
  /**
   * A body on the map carries the actor driving it, which is what makes it a
   * body rather than scenery — see `PlacedTile.owner`.
   */
  function withBodyOver(
    map: MapFile,
    x: number,
    y: number,
    under: string[],
    owner: string,
  ): MapFile {
    return replaceStack(map, x, y, 0, [
      ...under.map((tileId) => ({ tileId })),
      { tileId: "player", owner },
    ]);
  }

  it("picks up the sword under your own feet", () => {
    const map = withBodyOver(field(), 0, 0, ["grass", "sword"], "me");
    const me = actor("me", "player", 0, 0, map);

    const options = listInteractionOptions(map, tilesById, me, [me], null, KIT);

    expect(actionsIn(options)).toEqual(["pickUp"]);
    expect(options[0]!.ref).toEqual({ x: 0, y: 0, z: 0, stackIndex: 1 });
  });

  it("opens the chest you are standing on", () => {
    const map = withBodyOver(field(), 0, 0, ["grass", "chest"], "me");
    const me = actor("me", "player", 0, 0, map);

    expect(
      actionsIn(listInteractionOptions(map, tilesById, me, [me], null, KIT)),
    ).toEqual(["open"]);
  });

  it("still offers nothing for the body itself", () => {
    const map = withBodyOver(field(), 0, 0, ["grass"], "me");
    const me = actor("me", "player", 0, 0, map);

    expect(listInteractionOptions(map, tilesById, me, [me], null, KIT)).toEqual(
      [],
    );
  });

  /**
   * Somebody else standing on a thing does not own it. The alternative rule —
   * whoever stepped on it gets it — is one nothing else in the game plays by.
   */
  it("reaches under somebody else, and still offers the shove for them", () => {
    const map = withBodyOver(field(), 1, 0, ["grass", "sword"], "them");
    const me = playerAt(map, 0, 0);
    const them = actor("them", "player", 1, 0, map, 10);

    const options = listInteractionOptions(
      map,
      tilesById,
      me,
      [me, them],
      null,
      KIT,
    );

    expect(actionsIn(options).sort()).toEqual(["pickUp", "push", "target"]);
  });

  it("does not reach under a crate, which is a lid", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "sword", "crate"]);
    const me = playerAt(map);

    expect(
      actionsIn(listInteractionOptions(map, tilesById, me, [me], null, KIT)),
    ).toEqual(["push"]);
  });
});

/**
 * The open row is a toggle, so it is named for what pressing it would do and
 * lit while the box it names is the one you have open. One row for both halves:
 * a separate "Close" entry beside the first would be two rows for one chest.
 */
describe("listInteractionOptions — a container already open", () => {
  const REF = { x: 1, y: 0, z: 0, stackIndex: 1 };

  function rows(openedRef: typeof REF | null) {
    let map = field();
    map = place(map, 1, 0, ["grass", "chest"]);
    const me = playerAt(map);
    return listInteractionOptions(
      map,
      tilesById,
      me,
      [me],
      null,
      KIT,
      openedRef,
    );
  }

  it("says Open, unlit, when nothing is open", () => {
    const open = rows(null).find((o) => o.action === "open")!;
    expect(open.label).toBe("Open");
    expect(open.active).toBe(false);
  });

  it("says Close and lights up for the box being looked into", () => {
    const open = rows(REF).find((o) => o.action === "open")!;
    expect(open.label).toBe("Close");
    expect(open.active).toBe(true);
  });

  it("leaves a different box alone", () => {
    const elsewhere = { x: -1, y: 0, z: 0, stackIndex: 1 };
    const open = rows(elsewhere).find((o) => o.action === "open")!;
    expect(open.label).toBe("Open");
    expect(open.active).toBe(false);
  });

  it("is still one row, not two", () => {
    expect(rows(REF).filter((o) => o.action === "open")).toHaveLength(1);
  });
});

/**
 * What the pointer does with the list.
 *
 * The cursor and the list are the same list: whatever is under it is looked up
 * as a row, and that one row decides the outline, the words drawn over it and
 * what a click runs. So these are about the *choice* — which row wins when an
 * object offers more than one — because a chest that reads "Open Chest" and
 * shoves instead is the failure this is here to prevent.
 */
describe("topInteractionAt", () => {
  function optionsAround(map: MapFile, kit: Equipment = KIT) {
    const me = playerAt(map);
    return listInteractionOptions(map, tilesById, me, [me], null, kit);
  }

  it("takes pick up over open on a bag, when there is a back to put it on", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "bag"]);
    const ref = { x: 1, y: 0, z: 0, stackIndex: 1 };

    const top = topInteractionAt(optionsAround(map, NO_BAG), ref);
    expect(top?.action).toBe("pickUp");
  });

  // The other half of the same rule, and the reason the order is easy: wearing
  // a bag takes pick-up off the table entirely, so the row that is left is the
  // one that was always going to be wanted.
  it("takes open on a bag once one is already worn", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "bag"]);
    const ref = { x: 1, y: 0, z: 0, stackIndex: 1 };

    expect(topInteractionAt(optionsAround(map, KIT), ref)?.action).toBe("open");
  });

  // Never picked up, whatever your back is doing, so it opens either way.
  it("takes open on a chest", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "chest"]);
    const top = topInteractionAt(optionsAround(map, NO_BAG), {
      x: 1,
      y: 0,
      z: 0,
      stackIndex: 1,
    });
    expect(top?.action).toBe("open");
  });

  it("takes the one thing a crate offers", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "crate"]);
    const top = topInteractionAt(optionsAround(map), {
      x: 1,
      y: 0,
      z: 0,
      stackIndex: 1,
    });
    expect(top?.action).toBe("push");
  });

  it("has nothing to say about a cell with no rows", () => {
    const map = field();
    const top = topInteractionAt(optionsAround(map), {
      x: 1,
      y: 0,
      z: 0,
      stackIndex: 0,
    });
    expect(top).toBeNull();
  });

  // Rows for other objects are not candidates, however near they are — the
  // pointer is over one thing.
  it("ignores rows belonging to a different object", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "crate"]);
    map = place(map, 0, 1, ["grass", "sword"]);

    const top = topInteractionAt(optionsAround(map), {
      x: 0,
      y: 1,
      z: 0,
      stackIndex: 1,
    });
    expect(top?.action).toBe("pickUp");
  });
});

describe("interactionText", () => {
  it("puts the verb first, then what it is about", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "sword"]);
    const me = playerAt(map);
    const options = listInteractionOptions(map, tilesById, me, [me], null, KIT);

    expect(options.map(interactionText)).toContain("Pick up Sword");
  });
});
