import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import { hasAnyInteraction, interactionsForSave } from "./interactions";
import {
  MAX_PROJECTILE_SPEED,
  MIN_PROJECTILE_SPEED,
  projectileEffect,
  projectileTiles,
  resolveProjectile,
} from "./projectile";
import { normalizeTileDef, normalizeTiles, type TileDef } from "./types";
import { tilesByIdFromList } from "./validation";

/**
 * What a `projectile` tile is allowed to say, and what survives saying it
 * badly.
 *
 * Two rules carry the whole module. The kind is authoritative, so a block on a
 * tile that is not a projectile is inert rather than quietly in charge — the
 * same gate `resolveBattler` and `resolveItem` stand behind. And a malformed
 * side is *dropped* rather than thrown over, because a world that would not
 * load over a bad ramp is worse than a bow whose arrow lands quietly.
 */

const RAMP = [{ at: 0, color: "#ffffff" }];

function burst(over: Record<string, unknown> = {}) {
  return {
    durationMs: 150,
    particles: {
      ratePerSecond: 60,
      ttlFromMs: 100,
      ttlToMs: 200,
      spawnRadiusCells: 0.2,
      spawnElevFrom: 0,
      spawnElevTo: 2,
      riseFrom: 1,
      riseTo: 4,
      driftCellsPerSecond: 1,
      lit: false,
      gravity: -10,
      windX: 0,
      windY: 0,
      shape: null,
      radiusFromPx: 1,
      radiusToPx: 1,
      alphaFrom: 1,
      alphaTo: 0,
      ramp: RAMP,
      ...over,
    },
  };
}

function tile(over: Record<string, unknown> = {}): TileDef {
  return normalizeTileDef({
    id: "arrow",
    name: "Arrow",
    height: 0,
    type: "directional8",
    kind: "projectile",
    interactions: { projectile: { cellsPerSecond: 20 } },
    ...over,
  });
}

describe("resolving a tile's projectile block", () => {
  it("takes the speed", () => {
    expect(resolveProjectile(tile())).toEqual({ cellsPerSecond: 20 });
  });

  /**
   * **The kind decides, not the block.** This is the whole reason the field is
   * stored rather than derived: a tile somebody re-kinded to a prop keeps its
   * block in the file, and it must stop meaning anything the moment the kind
   * changes rather than the moment somebody remembers to delete it.
   */
  it("refuses a tile whose kind is not projectile", () => {
    for (const kind of ["prop", "item", "battler"] as const) {
      expect(resolveProjectile(tile({ kind }))).toBeNull();
    }
  });

  it("refuses a tile with no block, and nothing at all", () => {
    expect(resolveProjectile(tile({ interactions: {} }))).toBeNull();
    expect(resolveProjectile(undefined)).toBeNull();
  });

  it("refuses a speed outside what a flight may take", () => {
    const speed = (cellsPerSecond: number) =>
      resolveProjectile(tile({ interactions: { projectile: { cellsPerSecond } } }));

    expect(speed(0)).toBeNull();
    expect(speed(MAX_PROJECTILE_SPEED + 1)).toBeNull();
    expect(speed(MAX_PROJECTILE_SPEED)).not.toBeNull();
  });

  it("carries the hit through whole", () => {
    const def = tile({
      interactions: { projectile: { cellsPerSecond: 20, hit: burst() } },
    });

    expect(resolveProjectile(def)?.hit).toMatchObject({ durationMs: 150 });
  });

  /**
   * A side that does not parse is dropped and the projectile still flies. The
   * alternative is a weapon that stops firing because somebody typed a bad
   * colour, which is the trade `parseTileTransitions` already made for tiles.
   */
  it("drops a malformed hit rather than the block", () => {
    const def = tile({
      interactions: {
        projectile: {
          cellsPerSecond: 20,
          hit: { durationMs: 150, particles: { ramp: "red" } },
        },
      },
    });

    expect(resolveProjectile(def)).toEqual({ cellsPerSecond: 20 });
  });

  /**
   * A burst is counted over its whole duration — see `burstParticleCount` — so
   * the way past {@link MAX_BURST_PARTICLES} is a high rate held for a long
   * time.
   */
  it("drops a hit that spends more than one burst may", () => {
    const def = tile({
      interactions: {
        projectile: {
          cellsPerSecond: 20,
          hit: { ...burst({ ratePerSecond: 200 }), durationMs: 3_000 },
        },
      },
    });

    expect(resolveProjectile(def)?.hit).toBeUndefined();
  });
});

/**
 * What a save writes, which is the half that was missing: the kind decides
 * whether a block is read, and a save that drops the block leaves a tile whose
 * kind claims a projectile nothing backs. Every picker still offers it, every
 * weapon pointed at it looses nothing, and `data/tiles.json` shows a
 * `kind: "projectile"` tile that looks finished.
 */
describe("saving a projectile block", () => {
  it("keeps the block, rather than dropping it on the way to disk", () => {
    expect(interactionsForSave({ projectile: { cellsPerSecond: 8 } })?.projectile).toEqual({
      cellsPerSecond: 8,
    });
  });

  it("keeps it on a tile that authored nothing else", () => {
    expect(hasAnyInteraction({ projectile: { cellsPerSecond: 8 } })).toBe(true);
  });

  it("carries the hit through whole", () => {
    const saved = interactionsForSave({
      projectile: { cellsPerSecond: 8, hit: burst() },
    });

    expect(saved?.projectile?.hit).toMatchObject({ durationMs: 150 });
  });

  /**
   * The Speed field is the only thing holding the range, so a draft that came
   * in from a hand-edited file can carry anything. Clamped rather than dropped:
   * a block refused on the way out is the same silent un-authoring this whole
   * describe exists to stop.
   */
  it("clamps a speed no flight may take", () => {
    const speedOf = (cellsPerSecond: number) =>
      interactionsForSave({ projectile: { cellsPerSecond } })?.projectile?.cellsPerSecond;

    expect(speedOf(0)).toBe(MIN_PROJECTILE_SPEED);
    expect(speedOf(MAX_PROJECTILE_SPEED + 1)).toBe(MAX_PROJECTILE_SPEED);
  });

  it("survives the round trip the editor puts it through", () => {
    const def = tile({
      interactions: interactionsForSave({ projectile: { cellsPerSecond: 8 } }),
    });

    expect(resolveProjectile(def)).toEqual({ cellsPerSecond: 8 });
  });
});

describe("which side a landing plays", () => {
  const SPARK = burst();
  const FIZZLE = burst({ ratePerSecond: 10 });

  /** `appear` and `disappear` are the tile's own, off the Effects tab. */
  it("reads appear and disappear off the tile's transitions", () => {
    const def = tile({ transitions: { appear: SPARK, disappear: FIZZLE } });

    expect(projectileEffect(def, "appear")).toMatchObject({ durationMs: 150 });
    expect(projectileEffect(def, "disappear")?.particles?.ratePerSecond).toBe(10);
  });

  it("plays the authored hit for a landing that connected", () => {
    const def = tile({
      interactions: { projectile: { cellsPerSecond: 20, hit: SPARK } },
      transitions: { disappear: FIZZLE },
    });

    expect(projectileEffect(def, "hit")?.particles?.ratePerSecond).toBe(60);
  });

  /**
   * **No fallback any more.** `hit` used to borrow `disappear` when nothing was
   * authored, because a landing played exactly one side and the fallback was
   * what stopped a connected shot ending in silence. A landing plays both now,
   * so borrowing would draw the same effect twice on every blow that lands.
   */
  it("plays nothing for a hit nobody authored, rather than the disappear", () => {
    const def = tile({ transitions: { disappear: FIZZLE } });

    expect(projectileEffect(def, "hit")).toBeUndefined();
  });

  /** And never the other way: a miss may not borrow the hit's sparks. */
  it("does not fall back from disappear to hit", () => {
    const def = tile({
      interactions: { projectile: { cellsPerSecond: 20, hit: SPARK } },
    });

    expect(projectileEffect(def, "disappear")).toBeUndefined();
  });

  it("plays nothing for a tile nothing resolved", () => {
    expect(projectileEffect(undefined, "hit")).toBeUndefined();
  });
});

describe("what a picker may offer", () => {
  it("is every tile of the projectile kind, and only those", () => {
    const offered = projectileTiles([
      tile(),
      tile({ id: "crate", kind: "prop" }),
      tile({ id: "bolt" }),
    ]);

    expect(offered.map((t) => t.id)).toEqual(["arrow", "bolt"]);
  });
});

/**
 * The shipped projectiles, which is a claim about content rather than about
 * code — and is allowed to be, on the terms `CLAUDE.md` sets: `data/tiles.json`
 * is the tile catalogue and stays real, because an invented entry would test
 * the fixture. What is asserted is the *join*, not any coordinate or number.
 */
describe("the projectiles we ship", () => {
  const tiles = normalizeTiles(tilesJson as unknown[]);
  const byId = tilesByIdFromList(tiles);

  it("ships at least one, and every one of them resolves", () => {
    const fired = projectileTiles(tiles);

    expect(fired.length).toBeGreaterThan(0);
    for (const def of fired) {
      expect(resolveProjectile(def), `${def.id} does not resolve`).not.toBeNull();
    }
  });

  /**
   * A weapon or a bolt pointed at a tile that is not a projectile looses
   * nothing, which is the right behaviour and completely invisible: the shot is
   * still taken, the blow still lands, and there is simply no arrow. Only a
   * check like this one ever notices.
   *
   * **The arcane shard is why this matters.** It is the coin the shopkeeper
   * trades in, so it cannot also be ammunition — what a stone throws is
   * `arcane-bolt`, which looks like a shard and is not one.
   */
  it("is what every weapon and bolt names", () => {
    const named = new Set<string>();
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "projectile" && typeof value === "string") named.add(value);
        else walk(value);
      }
    };
    walk(tilesJson);

    expect(named.size).toBeGreaterThan(0);
    for (const id of named) {
      expect(resolveProjectile(byId[id]), `${id} is not a projectile`).not.toBeNull();
    }
  });
});
