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
import { tilesByIdFromList } from "../lib/validation";
import { extractKey } from "./extract";
import type { ActorSnapshot, PlaySession } from "./GameSession";
import {
  actionRows,
  applyInteraction,
  groupInteractionOptions,
  interactionText,
  listedActionRows,
  listInteractionOptions,
  rowPress,
  topInteractionAt,
  type InteractionOption,
} from "./interactionOptions";
import { tile } from "../lib/testTile";

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
    interactions: { item: { type: "consumable", hp: 1 } },
  }),
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
  tile({
    id: "lever",
    name: "Lever",
    height: 2,
    interactions: { switch: { targetTileId: "door_open" } },
  }),
  tile({
    id: "lever_crate",
    name: "Lever crate",
    height: 2,
    affectedByGravity: true,
    interactions: { push: DEFAULT_PUSH, switch: { targetTileId: "door_open" } },
  }),
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
  pvp = true,
): ActorSnapshot {
  return {
    id,
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
    hidden: false,
  };
}

function playerAt(map: MapFile, x = 0, y = 0): ActorSnapshot {
  return actor("me", "player", x, y, map);
}

const KIT: Equipment = {
  ...emptyEquipment(),
  bag: { id: "itm_bag", tileId: "bag", contents: [] },
};

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

const NO_BAG: Equipment = emptyEquipment();

const ARMED: Equipment = {
  ...emptyEquipment(),
  weapon: { id: "itm_held", tileId: "sword" },
  offhand: { id: "itm_lit", tileId: "torch" },
  bag: { id: "itm_bag", tileId: "bag", contents: [] },
};

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

  it("says nothing about a crate a floor down under solid ground", () => {
    let map = field();
    map = replaceStack(map, 1, 0, -1, [{ tileId: "grass" }, { tileId: "crate" }]);
    const me = playerAt(map);

    expect(listInteractionOptions(map, tilesById, me, [me], null, KIT)).toEqual([]);
  });

  it("offers a push on a crate a floor down where that ground is missing", () => {
    let map = field();
    map = replaceStack(map, 1, 0, 0, []);
    map = replaceStack(map, 1, 0, -1, [{ tileId: "grass" }, { tileId: "crate" }]);
    map = replaceStack(map, 2, 0, -1, [{ tileId: "grass" }]);
    const me = playerAt(map);

    const targets = listInteractionOptions(map, tilesById, me, [me], null, KIT);

    expect(actionsIn(targets)).toEqual(["push"]);
  });

  it("says nothing about a door a floor down under solid ground", () => {
    let map = field();
    map = replaceStack(map, 1, 0, -1, [{ tileId: "grass" }, { tileId: "door_shut" }]);
    const me = playerAt(map);

    expect(listInteractionOptions(map, tilesById, me, [me], null, KIT)).toEqual([]);
  });

  it("offers a door a floor down where that ground is missing", () => {
    let map = field();
    map = replaceStack(map, 1, 0, 0, []);
    map = replaceStack(map, 1, 0, -1, [{ tileId: "grass" }, { tileId: "door_shut" }]);
    const me = playerAt(map);

    const targets = listInteractionOptions(map, tilesById, me, [me], null, KIT);

    expect(actionsIn(targets)).toEqual(["switch"]);
  });

  it("drops a push with nowhere to go", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "crate"]);
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

    expect(actionsIn(targets)).toEqual(["switch"]);
  });

  it("ignores a switch buried under another tile", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "door_shut", "rock"]);
    const me = playerAt(map);

    expect(listInteractionOptions(map, tilesById, me, [me], null, KIT)).toEqual([]);
  });

  it("offers a push on an object with something stacked on it", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "crate", "rock"]);
    const me = playerAt(map);

    const targets = listInteractionOptions(map, tilesById, me, [me], null, KIT);

    expect(actionsIn(targets)).toEqual(["push"]);
    expect(targets[0]!.ref.stackIndex).toBe(1);
  });

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
    let map = field();
    map = place(map, 4, -4, ["grass", "deer"]);
    const me = playerAt(map);
    const deer = actor("npc:deer", "deer", 4, -4, map, 10);

    const targets = listInteractionOptions(map, tilesById, me, [me, deer], null, KIT);

    expect(actionsIn(targets)).toEqual(["target", "attack", "follow"]);
  });

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

  it("lights the fight rather than the watch while the sword is out", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "deer"]);
    const me = playerAt(map);
    const deer = actor("npc:deer", "deer", 1, 0, map, 10);

    const peaceful = listInteractionOptions(
      map,
      tilesById,
      me,
      [me, deer],
      "npc:deer",
      KIT,
      null,
      [],
      null,
      false,
    );
    const armed = listInteractionOptions(
      map,
      tilesById,
      me,
      [me, deer],
      "npc:deer",
      KIT,
      null,
      [],
      null,
      true,
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

    const targets = listInteractionOptions(map, tilesById, me, [me, deer], "npc:deer", KIT);

    expect(targets[0]!.action).toBe("target");
    expect(targets[0]!.active).toBe(true);
    expect(targets[1]!.action).toBe("attack");
    expect(targets[1]!.active).toBe(false);
  });

  describe("the wait on the fight row", () => {
    const WAIT = { remainingMs: 600, durationMs: 1_200 };

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

    it("hands the fight row the very object it was given", () => {
      const fight = rows("npc:deer", true).find((o) => o.action === "attack")!;

      expect(fight.active).toBe(true);
      expect(fight.wait).toBe(WAIT);
    });

    it("leaves every other row without one", () => {
      const all = rows("npc:deer", true);

      expect(all.filter((o) => o.wait !== null)).toHaveLength(1);
    });

    it("draws no clock on a body being watched rather than fought", () => {
      const fight = rows("npc:deer", false).find((o) => o.action === "attack")!;

      expect(fight.wait).toBeNull();
    });

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

    expect(listInteractionOptions(map, tilesById, me, [me, inert], null, KIT)).toEqual([]);
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

    expect(targets.map((o) => o.name)).toEqual(["Crate", "Deer", "Deer", "Deer"]);
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

    const targets = listInteractionOptions(map, tilesById, me, [me, far, mid, near], null, KIT);

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
    const engaged = listInteractionOptions(map, tilesById, me, [me, deer], "npc:deer", KIT);

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
    const walled = deerAt("npc:a", 3, 0, map);
    const open = deerAt("npc:b", 0, 3, map);

    const targets = listInteractionOptions(map, tilesById, me, [me, walled, open], null, KIT);

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
    expect(engaged.map((o) => o.action)).toEqual(["target", "attack", "follow", "push", "push"]);
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

  it("reaches diagonally, where a push does not", () => {
    let map = field();
    map = place(map, 1, 1, ["grass", "sword"]);
    const me = playerAt(map);

    expect(actionsIn(listInteractionOptions(map, tilesById, me, [me], null, ARMED))).toEqual([
      "pickUp",
    ]);
  });

  it("reaches the cell the player is standing in", () => {
    let map = field();
    map = place(map, 0, 0, ["grass", "sword"]);
    const me = playerAt(map);

    expect(actionsIn(listInteractionOptions(map, tilesById, me, [me], null, ARMED))).toEqual([
      "pickUp",
    ]);
  });

  it("does not reach two cells out", () => {
    let map = field();
    map = place(map, 2, 0, ["grass", "sword"]);
    const me = playerAt(map);

    expect(listInteractionOptions(map, tilesById, me, [me], null, KIT)).toEqual([]);
  });

  it("says nothing about an item buried under something else", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "sword", "rock"]);
    const me = playerAt(map);

    expect(listInteractionOptions(map, tilesById, me, [me], null, KIT)).toEqual([]);
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

    expect(listInteractionOptions(map, tilesById, me, [me], null, noRoomAnywhere)).toEqual([]);
  });

  it("reaches for a hand when the bag has no room", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "cherry"]);
    const me = playerAt(map);

    expect(actionsIn(listInteractionOptions(map, tilesById, me, [me], null, FULL_KIT))).toEqual([
      "pickUp",
      "consume",
    ]);
  });

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

    expect(listInteractionOptions(map, tilesById, me, [me], null, KIT)).toEqual([]);
  });
});

describe("listInteractionOptions — a tile somebody conjured", () => {
  function litBy(castBy: string): MapFile {
    return replaceStack(field(), 1, 0, 0, [{ tileId: "grass" }, { tileId: "sword", castBy }]);
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

    const options = listInteractionOptions(map, tilesById, me, [me, deer], null, ARMED);

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

  it("arms somebody with no bag at all", () => {
    expect(actionsIn(rowsFor("sword", NO_BAG))).toEqual(["equip"]);
  });

  it("offers stowing beside it when there is also room in the bag", () => {
    expect(actionsIn(rowsFor("sword", KIT))).toEqual(["equip", "pickUp"]);
  });

  it("drops the row once the slot it names is full", () => {
    expect(actionsIn(rowsFor("sword", ARMED))).toEqual(["pickUp"]);
    expect(actionsIn(rowsFor("torch", ARMED))).toEqual(["pickUp"]);
  });

  it("has no equip row for a consumable", () => {
    expect(actionsIn(rowsFor("cherry", NO_BAG))).not.toContain("equip");
  });
});

describe("listInteractionOptions — bags on the floor", () => {
  it("offers a bag as two rows, putting it on before open", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "bag"]);
    const me = playerAt(map);

    const options = listInteractionOptions(map, tilesById, me, [me], null, NO_BAG);

    expect(actionsIn(options)).toEqual(["equip", "open"]);
    expect(options[0]!.label).toBe("Put on");
    expect(options.every((o) => o.name === "Bag")).toBe(true);
  });

  it("offers open before taking a bag in hand when one is already worn", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "bag"]);
    const me = playerAt(map);

    expect(actionsIn(listInteractionOptions(map, tilesById, me, [me], null, KIT))).toEqual([
      "open",
      "pickUp",
    ]);
  });

  it("never offers to pick up a chest, however much room there is", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "chest"]);
    const me = playerAt(map);

    expect(actionsIn(listInteractionOptions(map, tilesById, me, [me], null, NO_BAG))).toEqual([
      "open",
    ]);
  });

  it("offers open even with a full bag, since looking costs nothing", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "chest"]);
    const me = playerAt(map);

    expect(actionsIn(listInteractionOptions(map, tilesById, me, [me], null, FULL_KIT))).toEqual([
      "open",
    ]);
  });

  it("does not offer open for something that is not a container", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "sword"]);
    const me = playerAt(map);

    expect(actionsIn(listInteractionOptions(map, tilesById, me, [me], null, ARMED))).toEqual([
      "pickUp",
    ]);
  });
});

describe("listInteractionOptions — consumables on the floor", () => {
  it("offers a cherry as two rows, pick up before eat", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "cherry"]);
    const me = playerAt(map);

    const options = listInteractionOptions(map, tilesById, me, [me], null, KIT);

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

  it("offers the meal when there is nowhere left to put it", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "cherry"]);
    const me = playerAt(map);
    const laden: Equipment = {
      ...FULL_KIT,
      weapon: { id: "w", tileId: "sword" },
      offhand: { id: "o", tileId: "torch" },
    };

    expect(actionsIn(listInteractionOptions(map, tilesById, me, [me], null, laden))).toEqual([
      "consume",
    ]);
  });

  it("does not reach two cells out", () => {
    let map = field();
    map = place(map, 2, 0, ["grass", "cherry"]);
    const me = playerAt(map);

    expect(listInteractionOptions(map, tilesById, me, [me], null, KIT)).toEqual([]);
  });

  it("says nothing about one buried under something else", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "cherry", "rock"]);
    const me = playerAt(map);

    expect(listInteractionOptions(map, tilesById, me, [me], null, KIT)).toEqual([]);
  });
});

describe("listInteractionOptions — standing on things", () => {
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

    expect(actionsIn(listInteractionOptions(map, tilesById, me, [me], null, KIT))).toEqual([
      "open",
    ]);
  });

  it("still offers nothing for the body itself", () => {
    const map = withBodyOver(field(), 0, 0, ["grass"], "me");
    const me = actor("me", "player", 0, 0, map);

    expect(listInteractionOptions(map, tilesById, me, [me], null, KIT)).toEqual([]);
  });

  it("reaches under somebody else, and still offers the shove for them", () => {
    const map = withBodyOver(field(), 1, 0, ["grass", "sword"], "them");
    const me = playerAt(map, 0, 0);
    const them = actor("them", "player", 1, 0, map, 10);

    const options = listInteractionOptions(map, tilesById, me, [me, them], null, ARMED);

    expect(actionsIn(options).sort()).toEqual(["attack", "follow", "pickUp", "push", "target"]);
  });

  it("does not reach under a crate, which is a lid", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "sword", "crate"]);
    const me = playerAt(map);

    expect(actionsIn(listInteractionOptions(map, tilesById, me, [me], null, KIT))).toEqual([
      "push",
    ]);
  });
});

describe("listInteractionOptions — a container already open", () => {
  const REF = { x: 1, y: 0, z: 0, stackIndex: 1 };

  function rows(openedRef: typeof REF | null) {
    let map = field();
    map = place(map, 1, 0, ["grass", "chest"]);
    const me = playerAt(map);
    return listInteractionOptions(map, tilesById, me, [me], null, KIT, openedRef);
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

  it("takes the hand over the bag on a sword", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "sword"]);
    const ref = { x: 1, y: 0, z: 0, stackIndex: 1 };

    expect(topInteractionAt(optionsAround(map, KIT), ref)?.action).toBe("equip");
    expect(topInteractionAt(optionsAround(map, ARMED), ref)?.action).toBe("pickUp");
  });

  it("takes open on a bag once one is already worn", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "bag"]);
    const ref = { x: 1, y: 0, z: 0, stackIndex: 1 };

    expect(topInteractionAt(optionsAround(map, KIT), ref)?.action).toBe("open");
  });

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
  function option(
    partial: Partial<InteractionOption> & Pick<InteractionOption, "id">,
  ): InteractionOption {
    return {
      action: "push",
      label: "Push",
      ref: { x: 1, y: 0, z: 0, stackIndex: 1 },
      actorId: null,
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
    expect(actionsIn(groups[0]!.options)).toEqual(["target", "attack", "follow", "push"]);
  });

  it("keeps two things apart, however near each other they are", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "crate"]);
    map = place(map, 0, 1, ["grass", "sword"]);
    const me = playerAt(map);

    const groups = groupInteractionOptions(
      listInteractionOptions(map, tilesById, me, [me], null, KIT),
    );

    expect(groups.map((g) => g.options[0]!.name).sort()).toEqual(["Crate", "Sword"]);
  });

  it("keeps two entries on one placement apart when they are about different things", () => {
    const fire = { x: 2, y: 2, z: 0, stackIndex: 1 };
    const groups = groupInteractionOptions([
      option({
        id: "a:2,2,0,1",
        action: "craft",
        label: "Cook",
        ref: fire,
        tileId: "raw_meat",
        name: "Raw Meat",
      }),
      option({
        id: "b:2,2,0,1",
        action: "craft",
        label: "Cook",
        ref: fire,
        tileId: "raw_fish",
        name: "Raw Fish",
      }),
    ]);

    expect(groups.map((g) => g.options[0]!.name)).toEqual(["Raw Meat", "Raw Fish"]);
  });

  it("keeps two bodies apart even where one stands where the other is listed", () => {
    const ref = { x: 1, y: 0, z: 0, stackIndex: 1 };
    const groups = groupInteractionOptions([
      option({ id: "target:a", action: "target", ref, tileId: "player", name: "Ada" }),
      option({ id: "target:b", action: "target", ref, tileId: "player", name: "Bo" }),
    ]);

    expect(groups).toHaveLength(2);
  });

  it("gathers a subject's verbs into the place its first one had", () => {
    let map = field();
    map = place(map, 1, 0, ["grass", "player"]);
    map = place(map, 0, 1, ["grass", "crate"]);
    const me = playerAt(map);
    const them = actor("them", "player", 1, 0, map, 10);
    const options = listInteractionOptions(map, tilesById, me, [me, them], null, KIT);

    const groups = groupInteractionOptions(options);

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

describe("listedActionRows and rowPress", () => {
  function bodyAndCrate() {
    let map = field();
    map = place(map, 1, 0, ["grass", "player"]);
    map = place(map, -1, 0, ["grass", "crate"]);
    const me = playerAt(map);
    const them = actor("them", "player", 1, 0, map, 10);
    return listInteractionOptions(map, tilesById, me, [me, them], null, KIT);
  }

  it("counts lines across every box, a body's pair as one", () => {
    const rows = listedActionRows(bodyAndCrate());

    expect(rows.map((row) => row.map((o) => `${o.name}:${o.action}`))).toEqual([
      ["Mira:target", "Mira:attack"],
      ["Mira:follow"],
      ["Mira:push"],
      ["Crate:push"],
    ]);
  });

  it("runs the only verb on a line of one", () => {
    const [, , , crate] = listedActionRows(bodyAndCrate());

    expect(rowPress(crate!)?.action).toBe("push");
  });

  it("walks the pair: watch first, then fight, then back to watching", () => {
    const [pair] = listedActionRows(bodyAndCrate());
    const [watch, fight] = pair!;
    const lit = (on: InteractionOption | null) =>
      pair!.map((option) => ({ ...option, active: option === on }));

    expect(rowPress(lit(null))?.action).toBe("target");
    expect(rowPress(lit(watch!))?.action).toBe("attack");
    const pressed = rowPress(lit(fight!));
    expect(pressed?.action).toBe("attack");
    expect(pressed?.active).toBe(true);
  });

  it("runs nothing for a line that is greyed", () => {
    const [, , , crate] = listedActionRows(bodyAndCrate());

    expect(rowPress([{ ...crate![0]!, blocked: { kind: "here" } }])).toBeNull();
  });

  it("has no lines and nothing to press for an empty list", () => {
    expect(listedActionRows([])).toEqual([]);
    expect(rowPress([])).toBeNull();
  });
});

describe("listInteractionOptions — somebody you cannot fight", () => {
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

  it("lights the lone watch row for the body that is picked", () => {
    const { map, me, them } = twoPlayers(true, false);
    const options = listInteractionOptions(
      map,
      tilesById,
      me,
      [me, them],
      "them",
      KIT,
      null,
      [],
      null,
      true,
    );

    expect(options.find((option) => option.action === "target")?.active).toBe(true);
  });
});

describe("applyInteraction — the fight and the watch", () => {
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
