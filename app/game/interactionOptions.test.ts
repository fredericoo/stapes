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
import { extractKey } from "./extract";
import type { ActorSnapshot, PlaySession } from "./GameSession";
import {
  actionRows,
  applyInteraction,
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
  // Something to stand still and pull at, so a pull in progress has a row.
  tile({
    id: "bush",
    name: "Bush",
    height: 2,
    interactions: {
      extract: {
        actionName: "Pick",
        durability: 2,
        tileId: "grass",
        durationMs: 1_000,
        slots: [{ tileId: "cherry", chance: 100 }],
      },
    },
  }),
  tile({
    id: "deer",
    name: "Deer",
    height: 4,
    actor: true,
    interactions: {
      battler: { baseHp: 8, maxHp: 10, atk: 2, def: 0, acc: 50, flee: 0, spd: 50 },
    },
  }),
  // A battler with something to say: the one body a tap could mean two things on.
  tile({
    id: "salesman",
    name: "Salesman",
    height: 4,
    actor: true,
    interactions: {
      battler: { baseHp: 8, maxHp: 10, atk: 2, def: 0, acc: 50, flee: 0, spd: 50 },
      dialog: { script: [{ kind: "say", text: "Hello." }] },
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
      battler: { baseHp: 8, maxHp: 10, atk: 2, def: 0, acc: 50, flee: 0, spd: 50 },
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

/**
 * A body on the board.
 *
 * **In the fighting by default**, which is the opposite of what a player who
 * has never touched the switch is — see `./pvp`. Almost every case in this file
 * is about which rows a body offers and in what order, and a fixture that was
 * quietly unfightable would be asserting the switch instead. The cases that
 * *are* about the switch pass `pvp: false` and say so.
 */
function actor(
  id: string,
  tileId: string,
  x: number,
  y: number,
  map: MapFile,
  hp: number | null = null,
  pvp = true,
): ActorSnapshot {
  return {
    id,
    // Every player body in this file is `me`, and what a body is called comes
    // off the body now rather than out of its id. A creature's is null: it is
    // named after its tile. @see `./displayName`
    name: tileId === "player" ? "Mira" : null,
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
    extracting: null,
    casting: null,
    pvp,
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

    expect(actionsIn(targets)).toEqual(["target", "attack", "follow"]);
    expect(targets[0]!.name).toBe("Deer");
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

    expect(actionsIn(targets)).toEqual(["target", "attack", "follow"]);
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
   * The two rows are the two positions of one decision about this body, so the
   * stance decides which of them is lit and nothing else: same rows, same
   * verbs, same ids. A player who can see which one is lit can say what their
   * next press does, which is the whole thing the mode could not tell them.
   */
  it("lights the fight rather than the watch while the sword is out", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "deer"]);
    const me = playerAt(map);
    const deer = actor("npc:deer", "deer", 1, 0, map, 10);

    const peaceful = listInteractionOptions(
      map, tilesById, me, [me, deer], "npc:deer", KIT, null, [], null, false,
    );
    const armed = listInteractionOptions(
      map, tilesById, me, [me, deer], "npc:deer", KIT, null, [], null, true,
    );

    const lit = (options: InteractionOption[]) =>
      options.filter((o) => o.active).map((o) => o.action);
    expect(lit(peaceful)).toEqual(["target"]);
    expect(lit(armed)).toEqual(["attack"]);
    expect(armed.map((o) => o.label)).toEqual(peaceful.map((o) => o.label));
    expect(armed.map((o) => o.id)).toEqual(peaceful.map((o) => o.id));
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

    // The watching half of the pair is lit, since nothing said a sword was out.
    expect(targets[0]!.action).toBe("target");
    expect(targets[0]!.active).toBe(true);
    expect(targets[1]!.action).toBe("attack");
    expect(targets[1]!.active).toBe(false);
  });

  /**
   * The clock on the fight row, which is what a player reads to know when their
   * next blow lands. @see `../components/InteractionList`
   */
  describe("the wait on the fight row", () => {
    const WAIT = { remainingMs: 600, durationMs: 1_200 };

    /** Every row for a deer one cell away, with a fight optionally running. */
    function rows(targetId: string | null, attacking: boolean) {
      let map = field();
      map = place(map, 1, 0, ["grass", "deer"]);
      const me = playerAt(map);
      const deer = actor("npc:deer", "deer", 1, 0, map, 10);
      return listInteractionOptions(
        map,
        tilesById,
        me,
        [me, deer],
        targetId,
        KIT,
        null,
        [],
        null,
        attacking,
        undefined,
        null,
        null,
        [],
        WAIT,
      );
    }

    /**
     * By reference, not by value: the session winds one object in place for the
     * whole wait and replaces it when the wait changes, and that identity is
     * what tells the row a *new* blow is being waited on. A copy made here would
     * throw it away and leave the bar mounted for the first blow for ever.
     */
    it("hands the fight row the very object it was given", () => {
      const fight = rows("npc:deer", true).find((o) => o.action === "attack")!;

      expect(fight.active).toBe(true);
      expect(fight.wait).toBe(WAIT);
    });

    it("leaves every other row without one", () => {
      const all = rows("npc:deer", true);

      expect(all.filter((o) => o.wait !== null)).toHaveLength(1);
    });

    /**
     * Watching somebody is not waiting to hit them. The wait outlives attack
     * mode on the simulation side — flicking it off is not a way to skip an
     * approach — so a row that read the figure without the stance would draw a
     * clock counting down to a blow nobody is going to throw.
     */
    it("draws no clock on a body being watched rather than fought", () => {
      const fight = rows("npc:deer", false).find((o) => o.action === "attack")!;

      expect(fight.wait).toBeNull();
    });

    /** And none on a body nobody has picked, whose fight row is only an offer. */
    it("draws no clock on a body nobody has picked", () => {
      const fight = rows(null, true).find((o) => o.action === "attack")!;

      expect(fight.wait).toBeNull();
    });
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
  it("lists a shovable body's verbs as separate entries, the body first", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "player"]);
    const me = playerAt(map);
    const them = actor("them", "player", 1, 0, map, 10);

    const targets = listInteractionOptions(map, tilesById, me, [me, them], null, KIT);

    expect(actionsIn(targets)).toEqual(["target", "attack", "follow", "push"]);
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

    expect(targets.map((o) => o.name)).toEqual([
      "Crate",
      "Deer",
      "Deer",
      "Deer",
    ]);
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

    // Three rows each, and they stay together: the sort settles distance first
    // and only then which of a body's own verbs comes above the others.
    expect(targets.map((o) => o.actorId)).toEqual([
      "npc:near",
      "npc:near",
      "npc:near",
      "npc:mid",
      "npc:mid",
      "npc:mid",
      "npc:far",
      "npc:far",
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
      "npc:here",
      "npc:here",
      "npc:up",
      "npc:up",
      "npc:up",
    ]);
  });
});

/**
 * The list is read by tier, and inside a tier by the order things arrived in.
 * Distance decides which tier a thing is in and nothing else, so a creature
 * pacing across the room does not shuffle the column under a thumb.
 */
describe("listInteractionOptions — stability", () => {
  function deerAt(id: string, x: number, y: number, map: MapFile) {
    return actor(id, "deer", x, y, map, 10);
  }

  it("puts the body you are targeting above the crate at your feet", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "crate"]);
    map = place(map, 4, 0, ["grass", "deer"]);
    const me = playerAt(map);
    const deer = deerAt("npc:deer", 4, 0, map);

    const idle = listInteractionOptions(map, tilesById, me, [me, deer], null, KIT);
    const engaged = listInteractionOptions(
      map,
      tilesById,
      me,
      [me, deer],
      "npc:deer",
      KIT,
    );

    expect(idle.map((o) => o.name)).toEqual(["Crate", "Deer", "Deer", "Deer"]);
    expect(engaged.map((o) => o.name)).toEqual(["Deer", "Deer", "Deer", "Crate"]);
  });

  it("puts the pull you are standing still for above what was held before it", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "crate"]);
    map = place(map, -1, 0, ["grass", "bush"]);
    const me = playerAt(map);
    const bushKey = extractKey({ x: -1, y: 0, z: 0 }, "bush");
    const before = listInteractionOptions(map, tilesById, me, [me], null, KIT);
    // Held in the order the crate came first, whichever way the plain sort
    // would have put them, so the pull has something to climb over.
    const crateFirst = [...before].sort((a) => (a.name === "Crate" ? -1 : 1));

    const pulling = listInteractionOptions(
      map,
      tilesById,
      me,
      [me],
      null,
      KIT,
      null,
      [],
      null,
      false,
      { key: bushKey, remainingMs: 500, durationMs: 1_000 },
      null,
      null,
      crateFirst,
    );
    const notPulling = listInteractionOptions(
      map,
      tilesById,
      me,
      [me],
      null,
      KIT,
      null,
      [],
      null,
      false,
      null,
      null,
      null,
      crateFirst,
    );

    expect(pulling[0]).toMatchObject({ name: "Bush", blocked: { kind: "working" } });
    expect(notPulling[0].name).toBe("Crate");
  });

  it("puts a body in sight above one behind a wall at the same distance", () => {
    let map = field();
    map = place(map, 2, 0, ["grass", "door_shut"]);
    map = place(map, 3, 0, ["grass", "deer"]);
    map = place(map, 0, 3, ["grass", "deer"]);
    const me = playerAt(map);
    // Ids in the order the last tie-break would put them, so the wall is the
    // only thing that can reverse the pair.
    const walled = deerAt("npc:a", 3, 0, map);
    const open = deerAt("npc:b", 0, 3, map);

    const targets = listInteractionOptions(
      map,
      tilesById,
      me,
      [me, walled, open],
      null,
      KIT,
    );

    expect(targets.map((o) => o.actorId)).toEqual([
      "npc:b",
      "npc:b",
      "npc:b",
      "npc:a",
      "npc:a",
      "npc:a",
    ]);
  });

  it("keeps two bodies in their held order after they swap distances", () => {
    const map = field();
    const me = playerAt(map);
    const first = listInteractionOptions(
      map,
      tilesById,
      me,
      [me, deerAt("npc:a", 2, 0, map), deerAt("npc:b", 3, 0, map)],
      null,
      KIT,
    );
    const aFirst = ["npc:a", "npc:a", "npc:a", "npc:b", "npc:b", "npc:b"];
    const bFirst = ["npc:b", "npc:b", "npc:b", "npc:a", "npc:a", "npc:a"];
    expect(first.map((o) => o.actorId)).toEqual(aFirst);

    const swapped = [me, deerAt("npc:a", 3, 0, map), deerAt("npc:b", 2, 0, map)];
    const held = listInteractionOptions(
      map,
      tilesById,
      me,
      swapped,
      null,
      KIT,
      null,
      [],
      null,
      false,
      null,
      null,
      null,
      first,
    );
    const fresh = listInteractionOptions(map, tilesById, me, swapped, null, KIT);

    expect(held.map((o) => o.actorId)).toEqual(aFirst);
    expect(fresh.map((o) => o.actorId)).toEqual(bFirst);
  });

  it("puts a newcomer after everything held, however near it is", () => {
    const map = field();
    const me = playerAt(map);
    const far = deerAt("npc:far", 3, 0, map);
    const before = listInteractionOptions(map, tilesById, me, [me, far], null, KIT);

    const arrived = listInteractionOptions(
      map,
      tilesById,
      me,
      [me, far, deerAt("npc:new", 2, 0, map)],
      null,
      KIT,
      null,
      [],
      null,
      false,
      null,
      null,
      null,
      before,
    );

    expect(arrived.map((o) => o.actorId)).toEqual([
      "npc:far",
      "npc:far",
      "npc:far",
      "npc:new",
      "npc:new",
      "npc:new",
    ]);
  });

  it("moves a body up a tier when it steps into reach, verbs together and fight first", () => {
    const farMap = place(field(), 3, 0, ["grass", "player"]);
    const me = playerAt(farMap);
    const before = listInteractionOptions(
      farMap,
      tilesById,
      me,
      [me, deerAt("npc:a", 2, 0, farMap), actor("npc:p", "player", 3, 0, farMap, 10)],
      null,
      KIT,
    );
    expect(before.map((o) => o.actorId)).toEqual([
      "npc:a",
      "npc:a",
      "npc:a",
      "npc:p",
      "npc:p",
      "npc:p",
    ]);

    const nearMap = place(field(), 1, 0, ["grass", "player"]);
    const stepped = listInteractionOptions(
      nearMap,
      tilesById,
      me,
      [me, deerAt("npc:a", 2, 0, nearMap), actor("npc:p", "player", 1, 0, nearMap, 10)],
      null,
      KIT,
      null,
      [],
      null,
      false,
      null,
      null,
      null,
      before,
    );

    expect(stepped.map((o) => `${o.action}:${o.actorId}`)).toEqual([
      "target:npc:p",
      "attack:npc:p",
      "follow:npc:p",
      "push:npc:p",
      "target:npc:a",
      "attack:npc:a",
      "follow:npc:a",
    ]);
  });

  it("holds a subject's place on its shove row as well as on the fight", () => {
    let crateMap = place(field(), 1, 0, ["grass", "player"]);
    crateMap = place(crateMap, -1, 0, ["grass", "crate"]);
    const me = playerAt(crateMap);
    const p = actor("npc:p", "player", 1, 0, crateMap, 10);
    const before = listInteractionOptions(crateMap, tilesById, me, [me, p], null, KIT);
    expect(before.map((o) => o.actorId)).toEqual(["npc:p", "npc:p", "npc:p", "npc:p", null]);

    // Targeting the body engages every row about it, so the box moves as one.
    const engaged = listInteractionOptions(
      crateMap,
      tilesById,
      me,
      [me, p],
      "npc:p",
      KIT,
      null,
      [],
      null,
      false,
      null,
      null,
      null,
      before,
    );
    const grouped = groupInteractionOptions(engaged);

    expect(grouped.map((g) => g.options.length)).toEqual([4, 1]);
    expect(engaged.map((o) => o.action)).toEqual([
      "target",
      "attack",
      "follow",
      "push",
      "push",
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
/**
 * A row names a conjured tile after whoever conjured it, which is the same
 * answer the look label gives. @see ./conjured's `conjuredName`
 */
describe("listInteractionOptions — a tile somebody conjured", () => {
  /** The same sword beside the player, conjured by whoever is named. */
  function litBy(castBy: string): MapFile {
    return replaceStack(field(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "sword", castBy },
    ]);
  }

  it("names it after the caster", () => {
    const map = litBy("me");
    const me = playerAt(map);

    const options = listInteractionOptions(map, tilesById, me, [me], null, ARMED);

    expect(options[0]!.name).toBe("Mira's Sword");
  });

  it("names it after a creature that conjured it", () => {
    const map = litBy("npc:1");
    const me = playerAt(map);
    const deer = actor("npc:1", "deer", 0, 2, map, 10);

    const options = listInteractionOptions(
      map,
      tilesById,
      me,
      [me, deer],
      null,
      ARMED,
    );

    expect(options.find((o) => o.action === "pickUp")!.name).toBe("Deer's Sword");
  });

  it("is the plain name again for a caster nobody can see", () => {
    const map = litBy("who");
    const me = playerAt(map);

    const options = listInteractionOptions(map, tilesById, me, [me], null, ARMED);

    expect(options[0]!.name).toBe("Sword");
  });
});

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

    expect(actionsIn(options).sort()).toEqual([
      "attack",
      "follow",
      "pickUp",
      "push",
      "target",
    ]);
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

  /**
   * A tap on a talking battler opens the conversation rather than picking it
   * out — with the sword out too, since attack is the mode a player starts in.
   */
  it("takes talk over target on a body with a dialog, sword out or not", () => {
    for (const attacking of [false, true]) {
      let map = field();
      map = place(map, 2, 0, ["grass", "salesman"]);
      const me = playerAt(map);
      const npc = actor("npc:salesman", "salesman", 2, 0, map, 10);
      const options = listInteractionOptions(
        map,
        tilesById,
        me,
        [me, npc],
        null,
        KIT,
        null,
        [],
        null,
        attacking,
      );

      expect(topInteractionAt(options, npc)?.action).toBe("talk");
    }
  });

  it("targets a body with a dialog that is out of talking reach", () => {
    let map = field();
    map = place(map, 4, 0, ["grass", "salesman"]);
    const me = playerAt(map);
    const npc = actor("npc:salesman", "salesman", 4, 0, map, 10);
    const options = listInteractionOptions(map, tilesById, me, [me, npc], null, KIT);

    // The left button picks somebody out; the right one fights them. So the
    // verb a plain press runs is never the fight — see `ACTION_ORDER`.
    expect(topInteractionAt(options, npc)?.action).toBe("target");
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

  it("reads a talk row as a sentence", () => {
    const withTalker = tilesByIdFromList([
      ...tiles,
      tile({
        id: "talker",
        name: "Pie Maker",
        height: 4,
        interactions: { dialog: { script: [{ kind: "say", text: "Pie?" }] } },
      }),
    ]);
    let map = field();
    map = place(map, 1, 0, ["grass", "talker"]);
    const me = playerAt(map);
    const npc = actor("npc:talker", "talker", 1, 0, map);
    const options = listInteractionOptions(map, withTalker, me, [me, npc], null, KIT);

    expect(options.map(interactionText)).toContain("Talk to Pie Maker");
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
      wait: null,
      tileId: "crate",
      name: "Crate",
      health: null,
      active: false,
      ...partial,
    };
  }

  it("says one body once and all of its verbs under it", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "player"]);
    const me = playerAt(map);
    const them = actor("them", "player", 1, 0, map, 10);

    const groups = groupInteractionOptions(
      listInteractionOptions(map, tilesById, me, [me, them], null, KIT),
    );

    expect(groups).toHaveLength(1);
    expect(actionsIn(groups[0]!.options)).toEqual([
      "target",
      "attack",
      "follow",
      "push",
    ]);
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
      ["target", "attack", "follow", "push"],
      ["push"],
    ]);
    expect(groups[1]!.options[0]!.name).toBe("Crate");
    expect(groups.flatMap((g) => g.options)).toHaveLength(options.length);
  });

  it("has nothing to say about an empty list", () => {
    expect(groupInteractionOptions([])).toEqual([]);
  });
});

describe("actionRows", () => {
  /**
   * The pair's adjacency is `ACTION_ORDER`'s doing rather than this function's,
   * so the two are asserted together against a real body: a player standing
   * next to you offers all four verbs, and only two of them share a line.
   */
  it("draws a body's fight and watch on one line, watching first", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "player"]);
    const me = playerAt(map);
    const them = actor("them", "player", 1, 0, map, 10);

    const groups = groupInteractionOptions(
      listInteractionOptions(map, tilesById, me, [me, them], null, KIT),
    );
    const rows = actionRows(groups[0]!.options);

    expect(rows.map((row) => row.map((o) => o.action))).toEqual([
      ["target", "attack"],
      ["follow"],
      ["push"],
    ]);
  });

  it("has nothing to draw for a box with nothing in it", () => {
    expect(actionRows([])).toEqual([]);
  });
});

/**
 * What a press asks the session for, which for a body is two questions at once:
 * who, and whether you are swinging at them. They used to be two decisions made
 * in two places — a row here and a mode elsewhere — and pressing one told you
 * nothing about the other.
 */
/**
 * Two players who have not both opted into fighting each other.
 *
 * What the list has to do about it is leave the fight row out: a row that is
 * drawn and does nothing when pressed is the one thing this file promises never
 * to offer. Everything else about the body stays. @see ./pvp
 */
describe("listInteractionOptions — somebody you cannot fight", () => {
  /** The viewer and one other player, each with their switch where it is put. */
  function twoPlayers(mine: boolean, theirs: boolean) {
    const map = place(field(), 1, 0, ["grass", "player"]);
    const me = actor("me", "player", 0, 0, map, 10, mine);
    const them = actor("them", "player", 1, 0, map, 10, theirs);
    return { map, me, them };
  }

  function verbsOn(mine: boolean, theirs: boolean, targetId: string | null = null) {
    const { map, me, them } = twoPlayers(mine, theirs);
    return listInteractionOptions(map, tilesById, me, [me, them], targetId, KIT)
      .filter((option) => option.actorId === "them")
      .map((option) => option.action);
  }

  it("offers the fight row when both switches are on", () => {
    expect(verbsOn(true, true)).toContain("attack");
  });

  // The shove stays, and so does everything else a body offers: a push moves
  // somebody, which is not harm and is not what the switch is about.
  it("leaves it out when theirs is off", () => {
    expect(verbsOn(true, false)).toEqual(["target", "follow", "push"]);
  });

  it("leaves it out when the viewer's own is off", () => {
    expect(verbsOn(false, true)).toEqual(["target", "follow", "push"]);
  });

  it("still offers it against a creature, whatever the viewer's switch says", () => {
    const map = place(field(), 1, 0, ["grass", "deer"]);
    const me = actor("me", "player", 0, 0, map, 10, false);
    const deer = actor("npc:deer", "deer", 1, 0, map, 10, false);

    expect(
      listInteractionOptions(map, tilesById, me, [me, deer], null, KIT)
        .filter((option) => option.actorId === "npc:deer")
        .map((option) => option.action),
    ).toContain("attack");
  });

  /**
   * With no fight row beside it, the watch row is the whole of the control
   * rather than half of one — so it says what it is whatever the attack mode
   * happens to be set to by a fight with somebody else.
   */
  it("lights the lone watch row for the body that is picked", () => {
    const { map, me, them } = twoPlayers(true, false);
    const options = listInteractionOptions(
      map, tilesById, me, [me, them], "them", KIT, null, [], null, true,
    );

    expect(options.find((option) => option.action === "target")?.active).toBe(true);
  });
});

describe("applyInteraction — the fight and the watch", () => {
  /** Just enough of a session to record what a press asked of it. */
  function recorder() {
    const calls: string[] = [];
    const session = {
      setTarget: (actorId: string | null) => calls.push(`target ${actorId}`),
      setAttackMode: (enabled: boolean) => calls.push(`swinging ${enabled}`),
    } as unknown as PlaySession;
    return { calls, session };
  }

  function bodyOptions(targetId: string | null, attacking: boolean) {
    let map = field();
    map = place(map, 1, 0, ["grass", "deer"]);
    const me = playerAt(map);
    const deer = actor("npc:deer", "deer", 1, 0, map, 10);
    return listInteractionOptions(
      map, tilesById, me, [me, deer], targetId, KIT, null, [], null, attacking,
    );
  }

  function row(options: InteractionOption[], action: "attack" | "target") {
    return options.find((o) => o.action === action)!;
  }

  it("picks the body out and starts swinging, in one press", () => {
    const { calls, session } = recorder();

    applyInteraction(session, row(bodyOptions(null, false), "attack"));

    expect(calls).toEqual(["target npc:deer", "swinging true"]);
  });

  /**
   * Both ends of the pair answer a second press now. A lit row that did nothing
   * when pressed is one nobody can tell from a dropped tap — and this is the
   * same toggle the keyboard's half has always been.
   */
  it("stops the fight when pressed again, and keeps the body", () => {
    const { calls, session } = recorder();

    applyInteraction(session, row(bodyOptions("npc:deer", true), "attack"));

    expect(calls).toEqual(["swinging false"]);
  });

  it("stops the fight and keeps the body when the watch beside it is pressed", () => {
    const { calls, session } = recorder();

    applyInteraction(session, row(bodyOptions("npc:deer", true), "target"));

    expect(calls).toEqual(["target npc:deer", "swinging false"]);
  });

  it("lets the body go when the lit watch is pressed", () => {
    const { calls, session } = recorder();

    applyInteraction(session, row(bodyOptions("npc:deer", false), "target"));

    expect(calls).toEqual(["target null", "swinging false"]);
  });
});
