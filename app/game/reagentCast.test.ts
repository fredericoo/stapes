import { describe, expect, it } from "vitest";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import { statusesById } from "../lib/status";
import { FRAME, tile } from "../lib/testTile";
import type { Coord, MapFile, TileDef } from "../lib/types";
import { squareSlot } from "./casting";
import { TICK_MS } from "./constants";
import { GameSession } from "./GameSession";

const FIELD_SIZE = 9;
const CASTER: Coord = { x: 2, y: 4, z: 0 };
const TARGET: Coord = { x: 6, y: 4, z: 0 };
const TARGET_ID = `npc:${TARGET.x},${TARGET.y},${TARGET.z}`;
const WINDUP_MS = 1_000;

function body(id: string, kit: { slot: string; tileId: string }[] = []): TileDef {
  return tile({
    id,
    height: 4,
    kind: "battler",
    directional: true,
    walkable: false,
    affectedByGravity: true,
    actor: id !== "player",
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
    interactions: {
      battler: {
        baseHp: 20,
        masteries: {},
        naturalWeapon: {
          type: "weapon",
          damage: 1,
          def: 0,
          accuracy: 0,
          variance: 0,
          spd: 1,
          mastery: "fist",
        },
        ...(kit.length ? { kit: kit.map((entry) => ({ ...entry, chance: 100 })) } : {}),
      },
    },
  });
}

function venomStone(id: string, extra: Record<string, unknown> = {}): TileDef {
  return tile({
    id,
    kind: "item",
    lightPassing: true,
    intangible: true,
    interactions: {
      item: {
        type: "stone",
        effect: {
          kind: "conjure",
          tileId: "cloud",
          area: { shape: "circle", radius: 1, on: "target" },
        },
        cooldownMs: 10_000,
        reach: { cells: 8, height: 2 },
        reagents: [{ tileId: "vial", count: 1 }],
        ...extra,
      },
    },
  });
}

const statuses = statusesById([
  {
    id: "poison",
    name: "Poisoned",
    description: "Sick.",
    tone: "bad",
    fromMs: 10_000,
    toMs: 10_000,
    everyMs: 5_000,
    effects: { hp: "0 - 1" },
  },
]);

function session(kit: { slot: string; tileId: string }[]): GameSession {
  const tiles = [
    tile({ id: "grass" }),
    tile({ id: "vial", kind: "item", interactions: { item: { type: "artifact", pile: 4 } } }),
    tile({
      id: "cloud",
      intangible: true,
      lightPassing: true,
      interactions: { addStatus: { trigger: "step", statusId: "poison" } },
    }),
    venomStone("venom-stone"),
    venomStone("slow-venom-stone", { castTimeMs: WINDUP_MS }),
    body("player", kit),
    body("rat"),
  ];
  let map: MapFile = emptyMap();
  for (let y = 0; y < FIELD_SIZE; y++) {
    for (let x = 0; x < FIELD_SIZE; x++) map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
  }
  map = replaceStack(map, CASTER.x, CASTER.y, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "e" },
  ]);
  map = replaceStack(map, TARGET.x, TARGET.y, 0, [
    { tileId: "grass" },
    { tileId: "rat", direction: "w", owner: TARGET_ID },
  ]);
  const play = new GameSession(map, tiles, { statuses });
  play.setTarget(TARGET_ID);
  return play;
}

function cloudCells(play: GameSession): string[] {
  const cells: string[] = [];
  for (let y = 0; y < FIELD_SIZE; y++) {
    for (let x = 0; x < FIELD_SIZE; x++) {
      const stack = getStack(play.getMap(), x, y, 0);
      if (stack.some((placed) => placed.tileId === "cloud")) cells.push(`${x},${y}`);
    }
  }
  return cells.sort();
}

const poisoned = (play: GameSession, id: string) =>
  (play.statusesOf(id) ?? []).some((status) => status.defId === "poison");

describe("a stone that spends a reagent", () => {
  it("takes the reagent and lays its shape around the target, sparing the caster", () => {
    const play = session([
      { slot: "weapon", tileId: "venom-stone" },
      { slot: "offhand", tileId: "vial" },
    ]);

    expect(play.cast(squareSlot("weapon"))).toBe(true);

    expect(play.equipmentOf("local")?.offhand).toBeNull();
    expect(cloudCells(play)).toEqual(
      ["5,3", "5,4", "5,5", "6,3", "6,4", "6,5", "7,3", "7,4", "7,5"].sort(),
    );
    expect(poisoned(play, TARGET_ID)).toBe(true);
    expect(poisoned(play, "local")).toBe(false);
  });

  it("is refused without the reagent, and nothing lands", () => {
    const play = session([{ slot: "weapon", tileId: "venom-stone" }]);

    expect(play.cast(squareSlot("weapon"))).toBe(false);

    expect(cloudCells(play)).toEqual([]);
    expect(play.equipmentOf("local")?.weapon?.cooldownMs ?? 0).toBe(0);
  });

  it("does not land when the reagent leaves the kit while the cast winds up", () => {
    const play = session([
      { slot: "weapon", tileId: "slow-venom-stone" },
      { slot: "offhand", tileId: "vial" },
    ]);

    expect(play.cast(squareSlot("weapon"))).toBe(true);
    expect(play.drop({ kind: "offhand" }, { x: CASTER.x, y: CASTER.y - 1, z: 0 })).toBe(true);
    for (let ms = 0; ms <= WINDUP_MS; ms += TICK_MS) play.tick();

    expect(cloudCells(play)).toEqual([]);
    expect(play.equipmentOf("local")?.weapon?.cooldownMs ?? 0).toBe(0);
  });
});
