import { describe, expect, it } from "vitest";
import { DEFAULT_PUSH } from "../lib/interactions";
import {
  DEFAULT_ARTIFACT,
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
  groupInteractionOptions,
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
  tile({ id: "rock", height: 2 }),
  tile({
    id: "crate",
    name: "Crate",
    height: 2,
    affectedByGravity: true,
    interactions: { push: DEFAULT_PUSH },
  }),
  tile({
    id: "door_shut",
    name: "Shut door",
    height: 4,
    walkable: false,
    interactions: {
      switch: { targetTileId: "door_open", actionName: "Open" },
    },
  }),
  tile({ id: "door_open", name: "Open door", height: 4 }),
  tile({
    id: "sword",
    name: "Sword",
    height: 0,
    kind: "item",
    intangible: true,
    interactions: { item: DEFAULT_WEAPON },
  }),
  tile({
    id: "torch",
    name: "Torch",
    height: 0,
    kind: "item",
    intangible: true,
    interactions: { item: { ...DEFAULT_ARTIFACT } },
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
    height: 2,
    interactions: { switch: { targetTileId: "door_open" } },
  }),
  // Both authored on one tile, which is what the single interact button
  // resolves by precedence — see `objectOptions`.
  tile({
    id: "lever_crate",
    name: "Lever crate",
    height: 2,
    affectedByGravity: true,
    interactions: { push: DEFAULT_PUSH, switch: { targetTileId: "door_open" } },
  }),
  tile({
    id: "deer",
    name: "Deer",
    height: 4,
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
    height: 4,
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
    strike: null,
    strikeProgress: 0,
    hp,
    maxHp: hp === null ? null : 10,
    rating: hp === null ? null : 10,
    statuses: [],
    carriedLights: [],
  };
}

/** The player standing at the origin with nothing else on them. */
function playerAt(map: MapFile, x = 0, y = 0): ActorSnapshot {
  return actor("me", "player", x, y, map);
}

/** A player with an empty four-slot bag on their back — the starting kit. */
const KIT: Equipment = {
  ...emptyEquipment(),
  bag: { id: "itm_bag", tileId: "bag", contents: [] },
};

/** Same bag, with nothing left to put in it. */
const FULL_KIT: Equipment = {
  ...emptyEquipment(),
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

/** Both hands and the back already full, so only stowing is ever on offer. */
const ARMED: Equipment = {
  ...emptyEquipment(),
  weapon: { id: "itm_held", tileId: "sword" },
  offhand: { id: "itm_lit", tileId: "torch" },
  bag: { id: "itm_bag", tileId: "bag", contents: [] },
};

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

  /**
   * A shove and a switch reach a floor either way — see `INTERACT_LEVEL_SLACK`
   * — and on their own that slack reached straight through the ground. A crate
   * in the cellar is a crate you can see the top of only if there is a hole in
   * the floor.
   */
  it("says nothing about a crate a floor down under solid ground", () => {
    let map = field();
    map = replaceStack(map, 1, 0, -1, [
      { tileId: "grass" },
      { tileId: "crate" },
    ]);
    const me = playerAt(map);

    expect(listInteractionOptions(map, tilesById, me, [me], null, KIT)).toEqual([]);
  });

  /** And the case the slack exists for: the same crate, down an open shaft. */
  it("offers a push on a crate a floor down where that ground is missing", () => {
    let map = field();
    map = replaceStack(map, 1, 0, 0, []);
    map = replaceStack(map, 1, 0, -1, [
      { tileId: "grass" },
      { tileId: "crate" },
    ]);
    // Somewhere for the shove to land, a cellar being one floor rather than
    // one cell.
    map = replaceStack(map, 2, 0, -1, [{ tileId: "grass" }]);
    const me = playerAt(map);

    const targets = listInteractionOptions(map, tilesById, me, [me], null, KIT);

    expect(actionsIn(targets)).toEqual(["push"]);
  });

  /** The door that started it: shut from the storey above, through the floor. */
  it("says nothing about a door a floor down under solid ground", () => {
    let map = field();
    map = replaceStack(map, 1, 0, -1, [
      { tileId: "grass" },
      { tileId: "door_shut" },
    ]);
    const me = playerAt(map);

    expect(listInteractionOptions(map, tilesById, me, [me], null, KIT)).toEqual([]);
  });

  it("offers a door a floor down where that ground is missing", () => {
    let map = field();
    map = replaceStack(map, 1, 0, 0, []);
    map = replaceStack(map, 1, 0, -1, [
      { tileId: "grass" },
      { tileId: "door_shut" },
    ]);
    const me = playerAt(map);

    const targets = listInteractionOptions(map, tilesById, me, [me], null, KIT);

    expect(actionsIn(targets)).toEqual(["switch"]);
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

  it("ignores a switch buried under another tile", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "door_shut", "rock"]);
    const me = playerAt(map);

    expect(listInteractionOptions(map, tilesById, me, [me], null, KIT)).toEqual([]);
  });

  /**
   * A shove reaches under, because whatever is on top comes with it — so a
   * crate with a rock on it is still a crate you can push.
   */
  it("offers a push on an object with something stacked on it", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "crate", "rock"]);
    const me = playerAt(map);

    const targets = listInteractionOptions(map, tilesById, me, [me], null, KIT);

    expect(actionsIn(targets)).toEqual(["push"]);
    expect(targets[0]!.ref.stackIndex).toBe(1);
  });

  /** Two crates one on the other are two crates, and either can be shoved. */
  it("offers a push on each of two stacked objects", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "crate", "crate"]);
    const me = playerAt(map);

    const targets = listInteractionOptions(map, tilesById, me, [me], null, KIT);

    expect(actionsIn(targets)).toEqual(["push", "push"]);
    expect(targets.map((t) => t.ref.stackIndex).sort()).toEqual([1, 2]);
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

  /**
   * **Line of sight is deliberately not consulted.** Picking somebody out is
   * pointing at them, not swinging: whether the blow can land is `./combat`'s
   * `canReach`, asked at the moment of the swing. A list that only offered a
   * target once you could see one would arrive after the decision it exists
   * for — choosing who you are walking towards, round the wall, is how a fight
   * starts.
   */
  it("offers a target on a body behind a full-height wall", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "door_shut"]);
    map = place(map, 2, 0, ["grass", "deer"]);
    const me = playerAt(map);
    const deer = actor("npc:deer", "deer", 2, 0, map, 10);

    const targets = listInteractionOptions(map, tilesById, me, [me, deer], null, KIT);

    expect(actionsIn(targets)).toContain("target");
    expect(targets.find((t) => t.action === "target")!.actorId).toBe("npc:deer");
  });

  /** And the same through a floor, which is the harder half of the rule. */
  it("offers a target on a body a level down under solid ground", () => {
    let map = field();
    map = replaceStack(map, 1, 0, -1, [{ tileId: "grass" }, { tileId: "deer" }]);
    const me = playerAt(map);
    const deer: ActorSnapshot = {
      ...actor("npc:deer", "deer", 1, 0, map, 10),
      z: -1,
      stackIndex: 1,
    };

    const targets = listInteractionOptions(map, tilesById, me, [me, deer], null, KIT);

    expect(actionsIn(targets)).toContain("target");
  });

  /**
   * The row is the same row and does one thing either way; what changes is the
   * word, because "Target Deer" describes the mechanism and "Attack Deer"
   * describes what is about to happen. In attack mode the tap *is* the first
   * swing, and people were reading the neutral verb and being surprised by the
   * fight.
   */
  it("names a body's row for the fight while the sword is out", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "deer"]);
    const me = playerAt(map);
    const deer = actor("npc:deer", "deer", 1, 0, map, 10);

    const peaceful = listInteractionOptions(
      map, tilesById, me, [me, deer], null, KIT, null, [], false,
    );
    const armed = listInteractionOptions(
      map, tilesById, me, [me, deer], null, KIT, null, [], true,
    );

    expect(peaceful[0]!.label).toBe("Target");
    expect(armed[0]!.label).toBe("Attack");
    // Same row, same act: only the word changed.
    expect(armed[0]!.action).toBe("target");
    expect(armed[0]!.id).toBe(peaceful[0]!.id);
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

    const options = listInteractionOptions(map, tilesById, me, [me], null, ARMED);

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
      actionsIn(listInteractionOptions(map, tilesById, me, [me], null, ARMED)),
    ).toEqual(["pickUp"]);
  });

  it("reaches the cell the player is standing in", () => {
    let map = field();
    map = place(map, 0, 0, ["grass", "sword"]);
    const me = playerAt(map);

    expect(
      actionsIn(listInteractionOptions(map, tilesById, me, [me], null, ARMED)),
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

  it("says nothing once the bag and both hands are full", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "sword"]);
    const me = playerAt(map);
    const noRoomAnywhere: Equipment = {
      ...FULL_KIT,
      weapon: { id: "w", tileId: "sword" },
      offhand: { id: "o", tileId: "torch" },
    };

    expect(
      listInteractionOptions(map, tilesById, me, [me], null, noRoomAnywhere),
    ).toEqual([]);
  });

  /**
   * A full bag is not the end of it: you have hands. The row still says "Pick
   * up", because putting a thing somewhere out of the way is what it means.
   */
  it("reaches for a hand when the bag has no room", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "cherry"]);
    const me = playerAt(map);

    expect(
      actionsIn(listInteractionOptions(map, tilesById, me, [me], null, FULL_KIT)),
    ).toEqual(["pickUp", "consume"]);
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

/**
 * Arming yourself off the floor.
 *
 * A verb per slot, because "Wield" and "Hold" are what you are actually
 * choosing between — and it is the one row that works with no bag at all, which
 * is the whole reason it exists.
 */
describe("listInteractionOptions — putting things on", () => {
  const rowsFor = (tileId: string, kit: Equipment) => {
    let map = field();
    map = place(map, 1, 0, ["grass", tileId]);
    const me = playerAt(map);
    return listInteractionOptions(map, tilesById, me, [me], null, kit);
  };

  it("names the slot the thing belongs in", () => {
    const verbs = (tileId: string) =>
      rowsFor(tileId, NO_BAG)
        .filter((o) => o.action === "equip")
        .map((o) => o.label);

    expect(verbs("sword")).toEqual(["Wield"]);
    expect(verbs("torch")).toEqual(["Hold"]);
    expect(verbs("bag")).toEqual(["Put on"]);
  });

  /** The case this exists for: nothing carried, and a sword on the ground. */
  it("arms somebody with no bag at all", () => {
    expect(actionsIn(rowsFor("sword", NO_BAG))).toEqual(["equip"]);
  });

  /** Two things to want, so two rows — and the tap takes the hand. */
  it("offers stowing beside it when there is also room in the bag", () => {
    expect(actionsIn(rowsFor("sword", KIT))).toEqual(["equip", "pickUp"]);
  });

  it("drops the row once the slot it names is full", () => {
    expect(actionsIn(rowsFor("sword", ARMED))).toEqual(["pickUp"]);
    expect(actionsIn(rowsFor("torch", ARMED))).toEqual(["pickUp"]);
  });

  /**
   * A consumable belongs nowhere in particular, so nothing offers to put it on.
   * A hand will still take one — that is the pick-up row's business, not this.
   */
  it("has no equip row for a consumable", () => {
    expect(actionsIn(rowsFor("cherry", NO_BAG))).not.toContain("equip");
  });
});

describe("listInteractionOptions — bags on the floor", () => {
  it("offers a bag as two rows, putting it on before open", () => {
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

    // Wearing it comes first. The only time both are offered is when your back
    // is bare, which is exactly when you want the bag itself.
    expect(actionsIn(options)).toEqual(["equip", "open"]);
    expect(options[0]!.label).toBe("Put on");
    expect(options.every((o) => o.name === "Bag")).toBe(true);
  });

  /**
   * Containers do not nest, so a bag can only ever go on a back that is free.
   * With one already there, opening is the only thing left to do with it — and
   * a bag with room inside it changes nothing, because a bag is not something
   * that goes *in* a bag.
   */
  /**
   * With a pack already on your back the second one can only be carried, and a
   * hand will do that — which is a choice rather than a rule. Opening still
   * comes first, since looking inside is the more interesting of the two.
   */
  it("offers open before taking a bag in hand when one is already worn", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "bag"]);
    const me = playerAt(map);

    expect(
      actionsIn(listInteractionOptions(map, tilesById, me, [me], null, KIT)),
    ).toEqual(["open", "pickUp"]);
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
      actionsIn(listInteractionOptions(map, tilesById, me, [me], null, ARMED)),
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

  // The meal survives having nowhere at all to put the thing — eating it off
  // the ground is exactly what a player with no room left wants to do.
  it("offers the meal when there is nowhere left to put it", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "cherry"]);
    const me = playerAt(map);
    const laden: Equipment = {
      ...FULL_KIT,
      weapon: { id: "w", tileId: "sword" },
      offhand: { id: "o", tileId: "torch" },
    };

    expect(
      actionsIn(listInteractionOptions(map, tilesById, me, [me], null, laden)),
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

    const options = listInteractionOptions(map, tilesById, me, [me], null, ARMED);

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
      ARMED,
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

  it("takes putting it on over open on a bag, when the back is bare", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "bag"]);
    const ref = { x: 1, y: 0, z: 0, stackIndex: 1 };

    const top = topInteractionAt(optionsAround(map, NO_BAG), ref);
    expect(top?.action).toBe("equip");
  });

  /** An empty hand is the strongest thing you can say about a sword. */
  it("takes the hand over the bag on a sword", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "sword"]);
    const ref = { x: 1, y: 0, z: 0, stackIndex: 1 };

    expect(topInteractionAt(optionsAround(map, KIT), ref)?.action).toBe("equip");
    expect(topInteractionAt(optionsAround(map, ARMED), ref)?.action).toBe(
      "pickUp",
    );
  });

  // The other half of the same rule, and the reason the order is easy: wearing
  // a bag takes "Put on" off the table entirely, so the row that is left is the
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

    const top = topInteractionAt(optionsAround(map, ARMED), {
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

describe("groupInteractionOptions", () => {
  /** An entry with only the parts grouping reads, for the cases the map cannot pose. */
  function option(
    partial: Partial<InteractionOption> & Pick<InteractionOption, "id">,
  ): InteractionOption {
    return {
      action: "push",
      label: "Push",
      ref: { x: 1, y: 0, z: 0, stackIndex: 1 },
      actorId: null,
      recipeIndex: null,
      blocked: null,
      tileId: "crate",
      name: "Crate",
      health: null,
      active: false,
      ...partial,
    };
  }

  it("says one body once and both of its verbs under it", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "player"]);
    const me = playerAt(map);
    const them = actor("them", "player", 1, 0, map, 10);

    const groups = groupInteractionOptions(
      listInteractionOptions(map, tilesById, me, [me, them], null, KIT),
    );

    expect(groups).toHaveLength(1);
    expect(actionsIn(groups[0]!.options)).toEqual(["target", "push"]);
  });

  it("keeps two things apart, however near each other they are", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "crate"]);
    map = place(map, 0, 1, ["grass", "sword"]);
    const me = playerAt(map);

    const groups = groupInteractionOptions(
      listInteractionOptions(map, tilesById, me, [me], null, KIT),
    );

    expect(groups.map((g) => g.options[0]!.name).sort()).toEqual([
      "Crate",
      "Sword",
    ]);
  });

  // The transmute row is the one entry whose subject is not its placement: a
  // fire offering to cook meat and to cook fish wears two sprites and two
  // names, and a box that merged them would have to pick one of the two to lie
  // with.
  it("keeps two entries on one placement apart when they are about different things", () => {
    const fire = { x: 2, y: 2, z: 0, stackIndex: 1 };
    const groups = groupInteractionOptions([
      option({
        id: "transmute:2,2,0,1:0",
        action: "transmute",
        label: "Cook",
        ref: fire,
        recipeIndex: 0,
        tileId: "raw_meat",
        name: "Raw Meat",
      }),
      option({
        id: "transmute:2,2,0,1:1",
        action: "transmute",
        label: "Cook",
        ref: fire,
        recipeIndex: 1,
        tileId: "raw_fish",
        name: "Raw Fish",
      }),
    ]);

    expect(groups.map((g) => g.options[0]!.name)).toEqual([
      "Raw Meat",
      "Raw Fish",
    ]);
  });

  // Two people share a tile, and the handle is the only thing that says they
  // are two subjects rather than one.
  it("keeps two bodies apart even where one stands where the other is listed", () => {
    const ref = { x: 1, y: 0, z: 0, stackIndex: 1 };
    const groups = groupInteractionOptions([
      option({ id: "target:a", action: "target", ref, tileId: "player", name: "Ada" }),
      option({ id: "target:b", action: "target", ref, tileId: "player", name: "Bo" }),
    ]);

    expect(groups).toHaveLength(2);
  });

  // The flat list is sorted by nearness first, so two subjects the same
  // distance away interleave their verbs; a box is what un-interleaves them,
  // and it does so without re-ordering anything the list had settled.
  it("gathers a subject's verbs into the place its first one had", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "player"]);
    map = place(map, 0, 1, ["grass", "crate"]);
    const me = playerAt(map);
    const them = actor("them", "player", 1, 0, map, 10);
    const options = listInteractionOptions(
      map,
      tilesById,
      me,
      [me, them],
      null,
      KIT,
    );

    const groups = groupInteractionOptions(options);

    // The body comes first because its fight does, and its shove comes with it
    // rather than staying behind the crate it was sorted against.
    expect(groups.map((g) => actionsIn(g.options))).toEqual([
      ["target", "push"],
      ["push"],
    ]);
    expect(groups[1]!.options[0]!.name).toBe("Crate");
    expect(groups.flatMap((g) => g.options)).toHaveLength(options.length);
  });

  it("has nothing to say about an empty list", () => {
    expect(groupInteractionOptions([])).toEqual([]);
  });
});
