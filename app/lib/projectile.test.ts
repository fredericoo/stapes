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

  it("plays nothing for a hit nobody authored, rather than the disappear", () => {
    const def = tile({ transitions: { disappear: FIZZLE } });

    expect(projectileEffect(def, "hit")).toBeUndefined();
  });

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
