import { describe, expect, it } from "vitest";
import statusesJson from "../../data/statuses.json";
import tilesJson from "../../data/tiles.json";
import { interactionKinds, interactionsForSave, resolveRemoveStatus } from "../lib/interactions";
import { emptyMap, replaceStack } from "../lib/mapData";
import { statusesById } from "../lib/status";
import type { Direction, MapFile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { canRemoveStatusFrom, reachableRemoveStatusAt } from "./affordances";
import { TICK_MS, WALK_DURATION_MS } from "./constants";
import { GameSession } from "./GameSession";
import { FRAME, tile } from "../lib/testTile";

/**
 * A tile that takes a condition off whoever sets it off — water putting out a
 * burn. The reach rules are `addStatus`'s and are tested there; what is tested
 * here is that the status goes, that only the named one goes, and that standing
 * in the water keeps putting out a burn that lands on you there.
 */

const TICKS_PER_STEP = Math.ceil(WALK_DURATION_MS / TICK_MS) + 1;
const TICKS_PER_SECOND = Math.round(1_000 / TICK_MS);
const BURN_MS = 4_000;

const PLAYER_BASE_HP = 8;
const PLAYER_TOUGHNESS = 92;

function body(id: string, extra: Record<string, unknown> = {}): TileDef {
  return tile({
    id,
    height: 4,
    kind: "battler",
    directional: true,
    walkable: false,
    affectedByGravity: true,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
    interactions: {
      battler: {
        baseHp: PLAYER_BASE_HP,
        masteries: { toughness: PLAYER_TOUGHNESS },
        naturalWeapon: {
          type: "weapon",
          damage: 5,
          def: 0,
          accuracy: 100,
          variance: 0,
          spd: 100,
          mastery: "fist",
        },
      },
    },
    ...extra,
  });
}

const tiles: TileDef[] = [
  tile({ id: "grass" }),
  body("player"),
  body("deer", { actor: true }),
  tile({ id: "fire", interactions: { addStatus: { trigger: "step", statusId: "burned" } } }),
  tile({ id: "nettles", interactions: { addStatus: { trigger: "step", statusId: "poison" } } }),
  tile({
    id: "brazier",
    height: 2,
    interactions: { addStatus: { trigger: "interact", statusId: "burned" } },
  }),
  tile({
    id: "water",
    wade: true,
    interactions: { removeStatus: { trigger: "step", statusId: "burned" } },
  }),
  tile({
    id: "basin",
    height: 2,
    interactions: {
      removeStatus: { actionName: "Wash", trigger: "interact", statusId: "burned" },
    },
  }),
  // Switched on and never filled in, which reads as unauthored.
  tile({ id: "dry", interactions: { removeStatus: { trigger: "step", statusId: "" } } }),
];

const tilesById = tilesByIdFromList(tiles);

const catalogue = statusesById([
  {
    id: "burned",
    name: "Burned",
    description: "Searing.",
    tone: "bad",
    fromMs: BURN_MS,
    toMs: BURN_MS,
    stacks: true,
    maxMs: BURN_MS * 3,
    everyMs: 1_000,
    effects: { hp: "0 - 1" },
  },
  {
    id: "poison",
    name: "Poisoned",
    description: "Slow.",
    tone: "bad",
    fromMs: BURN_MS * 4,
    toMs: BURN_MS * 4,
    stacks: false,
    maxMs: BURN_MS * 4,
    everyMs: 0,
    effects: {},
  },
]);

function run(session: GameSession, ticks: number) {
  for (let i = 0; i < ticks; i++) session.tick(TICK_MS);
}

function step(session: GameSession, direction: Direction) {
  session.setInput({ directions: [direction] });
  session.tick(TICK_MS);
  session.setInput({ directions: [] });
  run(session, TICKS_PER_STEP);
}

function held(session: GameSession, id = "local"): string[] {
  return (session.statusesOf(id) ?? []).map((instance) => instance.defId);
}

/** The player at the origin facing east, and a row of cells to walk along. */
function world(row: string[], tileId = "player"): MapFile {
  let map = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }, { tileId, direction: "e" }]);
  if (tileId !== "player") {
    map = replaceStack(map, 9, 9, 0, [{ tileId: "grass" }, { tileId: "player", direction: "s" }]);
  }
  row.forEach((tileId, i) => {
    map = replaceStack(map, i + 1, 0, 0, [{ tileId: "grass" }, { tileId }]);
  });
  return map;
}

function session(map: MapFile, opts: Record<string, unknown> = {}): GameSession {
  return new GameSession(map, tiles, { statuses: catalogue, ...opts });
}

describe("resolveRemoveStatus", () => {
  it("reads an authored block", () => {
    expect(resolveRemoveStatus(tilesById.water!)).toEqual({ trigger: "step", statusId: "burned" });
  });

  it("refuses a block naming no status", () => {
    expect(resolveRemoveStatus(tilesById.dry!)).toBeNull();
  });

  it("is a row only when it waits for a press", () => {
    expect(interactionKinds(tilesById.water!)).not.toContain("removeStatus");
    expect(interactionKinds(tilesById.basin!)).toContain("removeStatus");
  });

  it("saves only a block that names a status", () => {
    expect(
      interactionsForSave({
        removeStatus: { actionName: " ", trigger: "step", statusId: "burned" },
      }),
    ).toEqual({ removeStatus: { trigger: "step", statusId: "burned" } });
    expect(
      interactionsForSave({ removeStatus: { trigger: "step", statusId: "  " } }),
    ).toBeUndefined();
  });
});

describe("reachableRemoveStatusAt", () => {
  const ref = { x: 1, y: 0, z: 0, stackIndex: 1 };

  it("offers a basin from the next square over", () => {
    const map = world(["basin"]);
    expect(reachableRemoveStatusAt(map, tilesById, { x: 0, y: 0, z: 0 }, ref)).toMatchObject({
      trigger: "interact",
    });
  });

  it("never offers water you walk into", () => {
    const map = world(["water"]);
    expect(canRemoveStatusFrom(map, tilesById, { x: 0, y: 0, z: 0 }, ref)).toBe(false);
    expect(canRemoveStatusFrom(map, tilesById, { x: 1, y: 0, z: 0 }, ref)).toBe(false);
  });
});

describe("stepping into water", () => {
  it("puts out a burn", () => {
    const play = session(world(["fire", "water"]));
    step(play, "e");
    expect(held(play)).toEqual(["burned"]);
    step(play, "e");
    expect(held(play)).toEqual([]);
  });

  it("leaves every other status alone", () => {
    const play = session(world(["nettles", "fire", "water"]));
    step(play, "e");
    step(play, "e");
    expect(held(play).sort()).toEqual(["burned", "poison"]);
    step(play, "e");
    expect(held(play)).toEqual(["poison"]);
  });

  it("puts out a creature too — a body is a body", () => {
    const play = session(world(["fire", "water"], "deer"), { actorIds: [] });
    const id = "npc:0,0,0,1";
    expect(play.requestStep(id, "e")).toBe("started");
    run(play, TICKS_PER_STEP);
    expect(held(play, id)).toEqual(["burned"]);
    expect(play.requestStep(id, "e")).toBe("started");
    run(play, TICKS_PER_STEP);
    expect(held(play, id)).toEqual([]);
  });

  it("puts out a burn that lands while you stand in it, within a second", () => {
    const play = session(world(["water", "brazier"]));
    step(play, "e");
    expect(play.activateAddStatus({ x: 2, y: 0, z: 0, stackIndex: 1 })).toBe(true);
    expect(held(play)).toEqual(["burned"]);
    run(play, TICKS_PER_SECOND);
    expect(held(play)).toEqual([]);
  });
});

describe("pressing something that removes a status", () => {
  const ref = { x: 2, y: 0, z: 0, stackIndex: 1 };

  it("takes the condition off whoever pressed it", () => {
    const play = session(world(["fire", "basin"]));
    step(play, "e");
    expect(held(play)).toEqual(["burned"]);
    expect(play.canRemoveStatus(ref)).toBe(true);
    expect(play.interact(ref)).toBe(true);
    expect(held(play)).toEqual([]);
  });

  it("still takes the tap when there is nothing to remove", () => {
    const play = session(world(["grass", "basin"]));
    step(play, "e");
    expect(play.activateRemoveStatus(ref)).toBe(true);
    expect(held(play)).toEqual([]);
  });

  it("refuses water, which answers to no press", () => {
    const play = session(world(["water"]));
    expect(play.activateRemoveStatus({ x: 1, y: 0, z: 0, stackIndex: 1 })).toBe(false);
  });
});

describe("the water, as authored", () => {
  it("removes on step a status the catalogue holds", () => {
    const raw = (tilesJson as { id: string }[]).find((t) => t.id === "water")!;
    const water = tilesByIdFromList([normalizeTileDef(raw as TileDef)]).water!;
    const gesture = resolveRemoveStatus(water);
    expect(gesture).toEqual({ trigger: "step", statusId: "burned" });
    expect(statusesById(statusesJson)[gesture!.statusId]).toBeDefined();
  });
});
