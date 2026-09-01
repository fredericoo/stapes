import { describe, expect, it } from "vitest";
import statusesJson from "../../data/statuses.json";
import tilesJson from "../../data/tiles.json";
import { resolveItem, resolveStone } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { statusesById } from "../lib/status";
import { xpForLevel } from "../lib/mastery";
import { XP_PER_CAST } from "./experience";
import type { MapFile, TileDef } from "../lib/types";
import { normalizeTileDef, normalizeTiles } from "../lib/types";
import { emptyMap, replaceStack } from "../lib/mapData";
import { tilesByIdFromList } from "../lib/validation";
import {
  automaticFires,
  CAST_SQUARES,
  castability,
  castableStones,
  type CastContext,
  type CastPoint,
  meetsRequirements,
  spellReading,
} from "./casting";
import {
  emptyEquipment,
  handAccepts,
  handToSwing,
  type Equipment,
  weaponSwungBy,
  wornAccepts,
} from "./equipment";

/**
 * Which stones can be cast, and why not the rest.
 *
 * The module four callers depend on agreeing with itself — two on the client,
 * one on the server, and these — so every reason a cast can be refused gets a
 * case and each effect gets a happy path. Pure throughout: a map, a catalogue, a
 * kit and two positions, exactly as the move-rule and affordance suites are.
 *
 * The content cases at the bottom assert against the *authored* world rather
 * than against a fixture, on the terms the equipment suite's "what we ship"
 * cases do: a design quietly ceasing to be true should fail here.
 */

const frame = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

function tile(partial: Record<string, unknown>): TileDef {
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

function stoneTile(id: string, item: Record<string, unknown>): TileDef {
  return tile({
    id,
    kind: "item",
    lightPassing: true,
    intangible: true,
    interactions: { item: { type: "stone", ...item } },
  });
}

const NEAR_REACH = { cells: 3, height: 1 };

const tiles: TileDef[] = [
  tile({ id: "grass" }),
  // Tall and opaque, so a stone thrown through it fails the same way a shot
  // does — the line is what a wall costs.
  tile({ id: "wall", height: 2, lightPassing: false }),
  stoneTile("mend-stone", {
    effect: { kind: "bolt", damage: -10, on: "caster" },
    cooldownMs: 60_000,
  }),
  stoneTile("bolt-stone", {
    effect: {
      kind: "bolt",
      damage: 10,
      on: "target",
      projectile: { tileId: "arrow", cellsPerSecond: 14 },
    },
    cooldownMs: 20_000,
    reach: NEAR_REACH,
  }),
  stoneTile("ward-stone", {
    effect: { kind: "status", on: "caster", id: "luminous" },
    cooldownMs: 30_000,
  }),
  stoneTile("curse-stone", {
    effect: { kind: "status", on: "target", id: "burned" },
    cooldownMs: 30_000,
    reach: NEAR_REACH,
  }),
  stoneTile("flame-stone", {
    effect: { kind: "conjure", tileId: "fire" },
    cooldownMs: 120_000,
    reach: NEAR_REACH,
  }),
  stoneTile("adept-stone", {
    effect: { kind: "bolt", damage: -5, on: "caster" },
    cooldownMs: 10_000,
    requirements: { arcane: 10 },
  }),
  stoneTile("quiet-stone", {
    effect: { kind: "bolt", damage: -5, on: "caster" },
    cooldownMs: 10_000,
    automatic: true,
  }),
  tile({
    id: "sword",
    kind: "item",
    interactions: {
      item: {
        type: "weapon",
        damage: 5,
        def: 0,
        accuracy: 90,
        variance: 0,
        spd: 50,
        mastery: "blade",
      },
    },
  }),
  tile({
    id: "helm",
    kind: "item",
    interactions: { item: { type: "armor", slot: "head", def: 2 } },
  }),
  tile({ id: "fire", intangible: true, lightPassing: true }),
];

const tilesById = tilesByIdFromList(tiles);

let nextId = 0;
function instance(tileId: string, cooldownMs?: number): ItemInstance {
  return {
    id: `itm_${++nextId}`,
    tileId,
    ...(cooldownMs === undefined ? {} : { cooldownMs }),
  };
}

/** Two clear cells, `apart` cells along the x axis, with nothing between them. */
function open(apart: number): MapFile {
  let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);
  for (let x = 1; x <= apart; x++) {
    map = replaceStack(map, x, 0, 0, [{ tileId: "grass" }]);
  }
  return map;
}

const HERE: CastPoint = { x: 0, y: 0, z: 0, elevAbs: 0 };
const point = (x: number): CastPoint => ({ x, y: 0, z: 0, elevAbs: 0 });

function context(
  equipment: Partial<Equipment>,
  extra: Partial<CastContext> = {},
): CastContext {
  return {
    map: open(6),
    tilesById,
    equipment: { ...emptyEquipment(), ...equipment },
    masteries: {},
    caster: HERE,
    target: null,
    ...extra,
  };
}

describe("why a stone cannot be cast", () => {
  it("refuses an empty square", () => {
    expect(castability(context({}), "weapon")).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  /**
   * A hand holding a sword is not a hand holding a spell. The refusal is the
   * same one an empty square gets, because to a caster they are the same thing:
   * there is no stone there.
   */
  it("refuses a square holding something that is not a stone", () => {
    expect(castability(context({ weapon: instance("sword") }), "weapon")).toEqual(
      { ok: false, reason: "empty" },
    );
  });

  it("refuses a stone that is still cooling", () => {
    expect(
      castability(context({ weapon: instance("mend-stone", 4_000) }), "weapon"),
    ).toEqual({ ok: false, reason: "cooling" });
  });

  /**
   * **Cooling beats every other reason**, and deliberately: it is the fact that
   * will still be true when the player has walked closer, so it is the one worth
   * telling them.
   */
  it("says cooling over out of range when both are true", () => {
    const state = context(
      { weapon: instance("curse-stone", 4_000) },
      { target: point(6) },
    );
    expect(castability(state, "weapon")).toEqual({
      ok: false,
      reason: "cooling",
    });
  });

  it("refuses a stone whose mastery has not been earned", () => {
    expect(
      castability(
        context({ weapon: instance("adept-stone") }, { masteries: { arcane: 9 } }),
        "weapon",
      ),
    ).toEqual({ ok: false, reason: "mastery" });
  });

  it("allows one whose mastery has been met exactly", () => {
    expect(
      castability(
        context(
          { weapon: instance("adept-stone") },
          { masteries: { arcane: 10 } },
        ),
        "weapon",
      ),
    ).toEqual({ ok: true });
  });

  it("refuses a stone that acts on a target when nobody is targeted", () => {
    expect(
      castability(context({ weapon: instance("curse-stone") }), "weapon"),
    ).toEqual({ ok: false, reason: "noTarget" });
  });

  it("refuses a target out of the stone's reach", () => {
    const state = context(
      { weapon: instance("curse-stone") },
      { target: point(5) },
    );
    expect(castability(state, "weapon")).toEqual({
      ok: false,
      reason: "outOfRange",
    });
  });

  /**
   * The same rule a bow is under: most of what an archer can see is not, at this
   * instant, something they can hit. A spell out of range fails the way a swing
   * does, wall included.
   */
  it("refuses a target in reach with a wall in the way", () => {
    let map = open(4);
    map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "wall" }]);
    const state = context(
      { weapon: instance("curse-stone") },
      { map, target: point(2) },
    );
    expect(castability(state, "weapon")).toEqual({
      ok: false,
      reason: "outOfRange",
    });
  });

  it("allows a target inside the reach with a clear line", () => {
    const state = context(
      { weapon: instance("curse-stone") },
      { target: point(2) },
    );
    expect(castability(state, "weapon")).toEqual({ ok: true });
  });
});

describe("a stone that acts on its caster", () => {
  /**
   * Story 18 and story 20 in one case: a mend works with nothing targeted, and
   * works the same with something targeted a mile away. A self spell never
   * misfires at an enemy because it never looks at one.
   */
  it("works with no target and ignores one entirely", () => {
    const alone = context({ weapon: instance("mend-stone") });
    expect(castability(alone, "weapon")).toEqual({ ok: true });

    const aiming = context(
      { weapon: instance("mend-stone") },
      { target: point(6) },
    );
    expect(castability(aiming, "weapon")).toEqual({ ok: true });
  });

  it("does the same for a status the stone puts on its caster", () => {
    expect(
      castability(context({ weapon: instance("ward-stone") }), "weapon"),
    ).toEqual({ ok: true });
  });
});

describe("a conjuring stone", () => {
  /**
   * The one case where "nobody targeted" is not a refusal: the tile lands on the
   * cell the caster is facing, so a flame can be laid in a doorway.
   */
  it("can be cast with nothing targeted", () => {
    expect(
      castability(context({ weapon: instance("flame-stone") }), "weapon"),
    ).toEqual({ ok: true });
  });

  it("is still held to its reach when something is targeted", () => {
    const near = context(
      { weapon: instance("flame-stone") },
      { target: point(2) },
    );
    expect(castability(near, "weapon")).toEqual({ ok: true });

    const far = context(
      { weapon: instance("flame-stone") },
      { target: point(5) },
    );
    expect(castability(far, "weapon")).toEqual({
      ok: false,
      reason: "outOfRange",
    });
  });
});

describe("the charm square", () => {
  /**
   * A charm acts on its holder and nothing else, so a stone authored to reach a
   * target reaches nobody from there — where the same stone in a hand would need
   * one. Which is what makes the two squares different at all.
   */
  it("ignores the target even for a stone that names one", () => {
    const state = context({
      charm: instance("curse-stone"),
      weapon: instance("curse-stone"),
    });
    expect(castability(state, "charm")).toEqual({ ok: true });
    expect(castability(state, "weapon")).toEqual({
      ok: false,
      reason: "noTarget",
    });
  });
});

describe("what the squares will take", () => {
  it("lets either hand hold a stone that is pressed", () => {
    expect(handAccepts(tilesById["mend-stone"]!)).toBe(true);
  });

  /**
   * A hand is a thing you act with. One that acted by itself would be a body
   * casting spells nobody asked it to, so an automatic stone has exactly one
   * square.
   */
  it("refuses a hand an automatic stone, and the charm takes it", () => {
    expect(handAccepts(tilesById["quiet-stone"]!)).toBe(false);
    expect(wornAccepts("charm", tilesById["quiet-stone"]!)).toBe(true);
  });

  it("takes a stone on the charm and nowhere else that is worn", () => {
    expect(wornAccepts("charm", tilesById["mend-stone"]!)).toBe(true);
    for (const slot of ["head", "armor", "footwear"] as const) {
      expect(wornAccepts(slot, tilesById["mend-stone"]!)).toBe(false);
    }
  });

  it("still takes armour in the square that armour names", () => {
    expect(wornAccepts("head", tilesById.helm!)).toBe(true);
    expect(wornAccepts("charm", tilesById.helm!)).toBe(false);
  });
});

describe("the rotation, unchanged", () => {
  /**
   * The whole of stories 3 to 5, and none of it needed a line of new code: the
   * rotation already skips a hand with nothing to swing, and a stone is not a
   * weapon.
   */
  it("takes no turn for a hand holding a stone", () => {
    const kit = {
      ...emptyEquipment(),
      weapon: instance("mend-stone"),
    };
    expect(weaponSwungBy(kit, tilesById, "weapon")).toBeNull();
  });

  it("swings the weapon every turn beside a stone", () => {
    const kit = {
      ...emptyEquipment(),
      weapon: instance("sword"),
      offhand: instance("mend-stone"),
    };
    expect(handToSwing(kit, tilesById, "weapon")).toBe("weapon");
    // And again on the turn the off hand would otherwise have taken.
    expect(handToSwing(kit, tilesById, "offhand")).toBe("weapon");
  });

  it("falls back to the natural weapon with two stones", () => {
    const kit = {
      ...emptyEquipment(),
      weapon: instance("mend-stone"),
      offhand: instance("ward-stone"),
    };
    expect(handToSwing(kit, tilesById, "weapon")).toBeNull();
  });
});

describe("the row of buttons", () => {
  /**
   * The one thing about the row that is a rule rather than a drawing: as many
   * buttons as there are stones to press, and none at all for a body carrying
   * none.
   */
  it("is empty for a body carrying no stones", () => {
    expect(castableStones(context({ weapon: instance("sword") }))).toEqual([]);
  });

  it("has one button per non-passive stone, in square order", () => {
    const buttons = castableStones(
      context({
        weapon: instance("mend-stone"),
        offhand: instance("sword"),
        charm: instance("ward-stone"),
      }),
    );
    expect(buttons.map((button) => button.square)).toEqual(["weapon", "charm"]);
  });

  it("leaves out a stone that fires on its own", () => {
    const buttons = castableStones(
      context({
        weapon: instance("mend-stone"),
        charm: instance("quiet-stone"),
      }),
    );
    expect(buttons.map((button) => button.square)).toEqual(["weapon"]);
  });

  it("carries the stone's own sprite and its cooldown", () => {
    const [button] = castableStones(
      context({ weapon: instance("mend-stone", 4_000) }),
    );
    expect(button).toMatchObject({
      tileId: "mend-stone",
      cooldownMs: 4_000,
      cooldownTotalMs: 60_000,
      castability: { ok: false, reason: "cooling" },
    });
  });

  it("never offers a fourth, because there is no fourth square", () => {
    expect(CAST_SQUARES).toHaveLength(3);
  });
});

describe("what a row of buttons says", () => {
  /**
   * Whole seconds, because that is what a countdown can show — so a cooling
   * stone re-renders the row about once a second rather than thirty times.
   */
  it("reads the same across one second of cooling", () => {
    const at = (cooldownMs: number) =>
      spellReading(castableStones(context({ weapon: instance("mend-stone", cooldownMs) })));
    // Two different instances, so only the *reading* can make these agree.
    expect(at(4_400).replace(/itm_\d+/, "x")).toBe(
      at(4_001).replace(/itm_\d+/, "x"),
    );
    expect(at(4_400).replace(/itm_\d+/, "x")).not.toBe(
      at(3_400).replace(/itm_\d+/, "x"),
    );
  });

  it("is empty for a body with nothing to press", () => {
    expect(spellReading([])).toBe("");
  });
});

describe("requirements", () => {
  it("asks nothing of a stone with no block", () => {
    expect(meetsRequirements({}, undefined)).toBe(true);
  });

  /**
   * On the terms a weapon's are: what a stone asks of a mastery it does not
   * train is a real gate and not a footnote.
   */
  it("holds every named mastery, trained or not", () => {
    const asks = { arcane: 10, toughness: 5 };
    expect(meetsRequirements({ arcane: 10 }, asks)).toBe(false);
    expect(meetsRequirements({ arcane: 10, toughness: 5 }, asks)).toBe(true);
  });
});

describe("a stone that fires on its own", () => {
  const mend = resolveStone(tilesById["quiet-stone"]!)!;
  const ward = resolveStone(tilesById["ward-stone"]!)!;
  const flame = resolveStone(tilesById["flame-stone"]!)!;

  it("waits until a mend would put something back", () => {
    expect(automaticFires(mend, { hp: 20, maxHp: 20, statusIds: [] })).toBe(false);
    expect(automaticFires(mend, { hp: 19, maxHp: 20, statusIds: [] })).toBe(true);
  });

  /**
   * A charm reaches nobody but its wearer, so a bolt that harms is one that
   * harms them — and there is no moment at which that would be wasted. The
   * author wrote a cursed trinket and gets one.
   */
  it("fires a harming bolt whenever it is ready", () => {
    const curse = resolveStone(tilesById["bolt-stone"]!)!;
    expect(automaticFires(curse, { hp: 20, maxHp: 20, statusIds: [] })).toBe(true);
    expect(automaticFires(curse, { hp: 1, maxHp: 20, statusIds: [] })).toBe(true);
  });

  it("waits until its status is not already running", () => {
    expect(
      automaticFires(ward, { hp: 20, maxHp: 20, statusIds: ["luminous"] }),
    ).toBe(false);
    expect(automaticFires(ward, { hp: 20, maxHp: 20, statusIds: [] })).toBe(true);
  });

  /** A flame laid on an empty floor is still a flame; there is nothing to waste. */
  it("fires a conjure the moment it can", () => {
    expect(automaticFires(flame, { hp: 20, maxHp: 20, statusIds: [] })).toBe(true);
  });
});

/**
 * How many presses of a stone that asks nothing may stand between a player and
 * their first point of Arcane.
 *
 * A handful, because that is the whole promise: somebody who finds a light and
 * uses it a few times should feel the mastery move. It is a *bound* rather than
 * the number — the curve and the fee are what decide the number, and this is
 * what fails if either is retuned into a grind.
 */
const MOST_CASTS_TO_THE_FIRST_LEVEL = 6;

describe("the stones we ship", () => {
  const shipped = tilesByIdFromList(normalizeTiles(tilesJson as unknown[]));
  const statusDefs = statusesById(statusesJson as unknown[]);

  const SHIPPED = [
    "arcane-necklace-of-life",
    "arcane-stone-of-flame",
    "arcane-stone-of-light",
    "arcane-stone-of-cinder",
  ];

  it("parses every one of them as a stone", () => {
    for (const id of SHIPPED) {
      const def = shipped[id];
      expect(def, id).toBeDefined();
      expect(resolveStone(def!), id).not.toBeNull();
    }
  });

  /**
   * One case per effect, asserted against the authored file rather than a
   * fixture: the vocabulary is closed, and shipping one of each is what proves
   * all three arms are reachable by an author.
   */
  it("uses every one of the three effects", () => {
    const kinds = SHIPPED.map((id) => resolveStone(shipped[id]!)!.effect.kind);
    expect([...new Set(kinds)].sort()).toEqual(["bolt", "conjure", "status"]);
  });

  /**
   * **Both directions of the one arm, authored.** A bolt is a signed number and
   * the sign is the whole of what separates a curse from a blessing, so shipping
   * only one of them would leave half the vocabulary reachable only in a test.
   */
  it("ships a bolt that mends and a bolt that harms", () => {
    const life = resolveStone(shipped["arcane-necklace-of-life"]!)!;
    expect(life.effect).toMatchObject({ kind: "bolt", on: "caster" });
    if (life.effect.kind !== "bolt") return;
    expect(life.effect.damage).toBeLessThan(0);

    const cinder = resolveStone(shipped["arcane-stone-of-cinder"]!)!;
    expect(cinder.effect).toMatchObject({ kind: "bolt", on: "target" });
    if (cinder.effect.kind !== "bolt") return;
    expect(cinder.effect.damage).toBeGreaterThan(0);
    // The whole reason a bolt has a projectile block: what it throws has to be a
    // tile the world actually holds, on the terms a conjure's is checked above.
    expect(shipped[cinder.effect.projectile!.tileId]).toBeDefined();
  });

  it("names a status and a tile the world actually has", () => {
    const light = resolveStone(shipped["arcane-stone-of-light"]!)!;
    expect(light.effect.kind).toBe("status");
    if (light.effect.kind !== "status") return;
    expect(statusDefs[light.effect.id]).toBeDefined();

    const flame = resolveStone(shipped["arcane-stone-of-flame"]!)!;
    expect(flame.effect.kind).toBe("conjure");
    if (flame.effect.kind !== "conjure") return;
    expect(shipped[flame.effect.tileId]).toBeDefined();
  });

  /**
   * The claim the whole "luminous needs no new simulation" argument rests on: it
   * is an ordinary status whose visual block carries a light, riding the same
   * emitter path a carried torch does.
   */
  it("makes luminous a status that actually emits light", () => {
    const luminous = statusDefs.luminous;
    expect(luminous).toBeDefined();
    expect(luminous!.vfx.light).not.toBeNull();
    expect(luminous!.vfx.light!.radius).toBeGreaterThan(0);
  });

  /**
   * A conjured tile with no lifetime is a battlefield that never clears. The
   * hearth flame deliberately has none — it is scenery — so the conjured one has
   * to be a tile of its own.
   */
  it("gives the conjured flame a lifetime and leaves the hearth alone", () => {
    const flame = resolveStone(shipped["arcane-stone-of-flame"]!)!;
    if (flame.effect.kind !== "conjure") throw new Error("not a conjure");
    const conjured = shipped[flame.effect.tileId]!;
    expect(conjured.interactions?.decay).toBeDefined();
    expect(conjured.id).not.toBe("flame");
    expect(shipped.flame!.interactions?.decay).toBeUndefined();
  });

  /**
   * **The way onto the ladder, checked against the world as authored.** A stone
   * of flame asks Arcane 10, so the only stones a player with no Arcane at all
   * can press are the two that ask nothing — and the flat fee every cast pays is
   * what turns pressing one of those into the first point. If either of those
   * facts stops being true, an arcanist has no way to begin.
   */
  it("leaves a way to the first point of Arcane for somebody with none", () => {
    const open = SHIPPED.filter(
      (id) => resolveStone(shipped[id]!)!.requirements === undefined,
    );
    expect(open.length).toBeGreaterThan(0);

    const casts = xpForLevel(1) / XP_PER_CAST;
    expect(casts).toBeLessThanOrEqual(MOST_CASTS_TO_THE_FIRST_LEVEL);
  });

  it("gates the strong one on a mastery and leaves the small ones open", () => {
    const flame = resolveStone(shipped["arcane-stone-of-flame"]!)!;
    expect(flame.requirements?.arcane).toBeGreaterThan(0);
    for (const id of ["arcane-necklace-of-life", "arcane-stone-of-light"]) {
      expect(resolveStone(shipped[id]!)!.requirements, id).toBeUndefined();
    }
  });

  /** Every stone in the world is a stone, and no stone is anything else. */
  it("authors them on the item union and nowhere else", () => {
    for (const id of SHIPPED) {
      expect(resolveItem(shipped[id]!)?.type, id).toBe("stone");
    }
  });
});
