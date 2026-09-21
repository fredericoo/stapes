import { describe, expect, it } from "vitest";
import { defFrom, maxHpFrom } from "../lib/battler";
import { emptyMap, replaceStack } from "../lib/mapData";
import { statusesById } from "../lib/status";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";
import { TICK_MS } from "./constants";
import { GameSession } from "./GameSession";
import { mayHarm } from "./pvp";
import { FRAME, tile } from "../lib/testTile";

/**
 * Two players do not hurt each other until both have asked to.
 *
 * The rule itself is four lines and is asserted as such below; everything after
 * that is the four places harm can pass from one body to another, each checked
 * against the same board with the switches in different positions.
 */

const BASE_HP = 8;
const TOUGHNESS = 92;
const MAX_HP = maxHpFrom(BASE_HP, TOUGHNESS);

/**
 * A blow felt through whatever armour Toughness grants, and then some — stated
 * as the target's defence rather than as a number, so these cases go on
 * asserting that a blow lands rather than re-deriving the defence curve.
 */
const FELT = defFrom(TOUGHNESS) + 5;

/** A body that always connects, so a blow landing is a fact rather than a roll. */
function body(id: string, extra: Record<string, unknown> = {}): TileDef {
  return tile({
    id,
    height: 4,
    kind: "battler",
    directional: true,
    walkable: false,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
    interactions: {
      battler: {
        baseHp: BASE_HP,
        masteries: { toughness: TOUGHNESS },
        naturalWeapon: {
          type: "weapon",
          damage: FELT,
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
  body("player", { affectedByGravity: true }),
  body("deer", { actor: true, affectedByGravity: true }),
  // Flat, so it neither buries what is under it nor stops anybody standing in it.
  tile({
    id: "fire",
    interactions: { addStatus: { trigger: "step", statusId: "burned" } },
  }),
  tile({
    id: "circle",
    interactions: { addStatus: { trigger: "step", statusId: "blessed" } },
  }),
];

const catalogue = statusesById([
  {
    id: "burned",
    name: "Burned",
    description: "Searing.",
    tone: "bad",
    fromMs: 4_000,
    toMs: 4_000,
    stacks: false,
    maxMs: 4_000,
    everyMs: 1_000,
    effects: { hp: "0 - 4" },
  },
  {
    id: "blessed",
    name: "Blessed",
    description: "Somebody laid this down to be stood in.",
    tone: "good",
    fromMs: 4_000,
    toMs: 4_000,
    stacks: false,
    maxMs: 4_000,
    everyMs: 0,
    effects: {},
  },
]);

/**
 * Long enough for the approach and a few blows, and short enough that the body
 * taking them is still standing — what these cases read is a health bar, and a
 * corpse has none.
 */
const A_FEW_ROUNDS_MS = 2_000;

function advance(session: GameSession, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) session.tick(TICK_MS);
}

/** Flat ground, with the viewer at the origin. */
function field(): MapFile {
  let map = emptyMap();
  for (let x = -2; x <= 2; x++) {
    for (let y = -2; y <= 2; y++) map = replaceStack(map, x, y, 0, [{ tileId: "grass" }]);
  }
  return replaceStack(map, 0, 0, 0, [
    { tileId: "grass" },
    { tileId: "player", direction: "e" },
  ]);
}

function session(map: MapFile = field()): GameSession {
  return new GameSession(map, tiles, { statuses: catalogue });
}

function hpOf(play: GameSession, id: string): number | null {
  return play.actorSnapshots().find((actor) => actor.id === id)?.hp ?? null;
}

/**
 * The viewer and a second player beside them, with the second one swinging.
 *
 * The attacker is the *other* body, so what is asserted is what a stranger can
 * do to the viewer rather than the other way round — and the viewer's own switch
 * is the interesting one either way, since both have to be on.
 */
function twoPlayers(mine: boolean, theirs: boolean) {
  const play = session();
  play.spawn("them", { at: { x: 1, y: 0, z: 0, direction: "w" } });
  play.setPvp(mine, "local");
  play.setPvp(theirs, "them");
  play.setTarget("local", "them");
  play.setAttackMode(true, "them");
  return play;
}

describe("whether harm may pass", () => {
  const player = (id: string, pvp: boolean) => ({ id, resident: false, pvp });
  const creature = (id: string) => ({ id, resident: true, pvp: false });

  it("passes between two players who have both asked for it", () => {
    expect(mayHarm(player("a", true), player("b", true))).toBe(true);
  });

  it("stops at a player who has not", () => {
    expect(mayHarm(player("a", true), player("b", false))).toBe(false);
  });

  it("stops at a player who has not asked for it themselves", () => {
    expect(mayHarm(player("a", false), player("b", true))).toBe(false);
  });

  it("is untouched wherever a creature is one of the two", () => {
    expect(mayHarm(player("a", false), creature("rat"))).toBe(true);
    expect(mayHarm(creature("rat"), player("a", false))).toBe(true);
    expect(mayHarm(creature("rat"), creature("wolf"))).toBe(true);
  });

  it("lets a body harm itself, whatever its switch says", () => {
    expect(mayHarm(player("a", false), player("a", false))).toBe(true);
  });
});

describe("swinging at another player", () => {
  it("takes nothing off somebody who is not in the fighting", () => {
    const play = twoPlayers(false, true);
    advance(play, A_FEW_ROUNDS_MS);
    expect(hpOf(play, "local")).toBe(MAX_HP);
  });

  it("takes nothing off anybody when the swinger is not in it either", () => {
    const play = twoPlayers(true, false);
    advance(play, A_FEW_ROUNDS_MS);
    expect(hpOf(play, "local")).toBe(MAX_HP);
  });

  it("lands once both switches are on", () => {
    const play = twoPlayers(true, true);
    advance(play, A_FEW_ROUNDS_MS);
    expect(hpOf(play, "local")!).toBeLessThan(MAX_HP);
  });

  it("leaves the target targeted, because pointing is not swinging", () => {
    const play = twoPlayers(false, false);
    advance(play, A_FEW_ROUNDS_MS);
    // Read off the refused attacker's own snapshot: a refusal that cleared the
    // slot would take away the one thing a player can still do to somebody they
    // cannot fight, which is look at them.
    expect(play.getSnapshot("them").targetId).toBe("local");
  });

  it("is untouched between a player and a creature", () => {
    const play = session(
      replaceStack(field(), 1, 0, 0, [
        { tileId: "grass" },
        { tileId: "deer", direction: "w" },
      ]),
    );
    // Nobody's switch on, which is every player in a world that has never heard
    // of this feature.
    const deer = play.actorIds().find((id) => id !== "local")!;
    play.setTarget(deer, "local");
    play.setAttackMode(true, "local");
    advance(play, A_FEW_ROUNDS_MS);
    expect(hpOf(play, deer)!).toBeLessThan(MAX_HP);
  });
});

describe("a fire somebody else conjured", () => {
  /** The viewer at the origin with a flame beside them, laid by `castBy`. */
  function beside(placed: PlacedTile) {
    const map = replaceStack(field(), 1, 0, 0, [{ tileId: "grass" }, placed]);
    const play = session(map);
    play.spawn("them", { at: { x: 2, y: 0, z: 0, direction: "w" } });
    return play;
  }

  /** Walk one cell east and let the arrival settle. */
  function stepEast(play: GameSession) {
    play.setInput({ directions: ["e"] });
    play.tick(TICK_MS);
    play.setInput({ directions: [] });
    advance(play, 400);
  }

  function heldBy(play: GameSession, id: string): string[] {
    return (play.statusesOf(id) ?? []).map((instance) => instance.defId);
  }

  it("does not burn a player who is not in the fighting", () => {
    const play = beside({ tileId: "fire", castBy: "them" });
    play.setPvp(true, "them");
    stepEast(play);
    expect(heldBy(play, "local")).toEqual([]);
  });

  it("burns them once both switches are on", () => {
    const play = beside({ tileId: "fire", castBy: "them" });
    play.setPvp(true, "them");
    play.setPvp(true, "local");
    stepEast(play);
    expect(heldBy(play, "local")).toContain("burned");
  });

  it("still blesses them, because only harm is refused", () => {
    const play = beside({ tileId: "circle", castBy: "them" });
    play.setPvp(true, "them");
    stepEast(play);
    expect(heldBy(play, "local")).toEqual(["blessed"]);
  });

  it("burns anybody where nobody conjured it", () => {
    const play = beside({ tileId: "fire" });
    stepEast(play);
    expect(heldBy(play, "local")).toContain("burned");
  });
});

describe("moving the switch", () => {
  it("starts off for somebody the world has never met", () => {
    const play = session();
    expect(play.getSnapshot("local").pvp).toEqual({
      on: false,
      changeable: true,
    });
  });

  it("goes on and off again", () => {
    const play = session();
    expect(play.setPvp(true)).toBe(true);
    expect(play.getSnapshot("local").pvp.on).toBe(true);
    expect(play.setPvp(false)).toBe(true);
    expect(play.getSnapshot("local").pvp.on).toBe(false);
  });

  it("is frozen while the body is in a fight", () => {
    const play = session(
      replaceStack(field(), 1, 0, 0, [
        { tileId: "grass" },
        { tileId: "deer", direction: "w" },
      ]),
    );
    play.setTarget(play.actorIds().find((id) => id !== "local")!, "local");
    play.setAttackMode(true, "local");
    advance(play, A_FEW_ROUNDS_MS);

    expect(play.getSnapshot("local").pvp.changeable).toBe(false);
    expect(play.setPvp(true)).toBe(false);
    expect(play.getSnapshot("local").pvp.on).toBe(false);
  });

  it("is never offered to a creature, whose aggression is its brain's", () => {
    const play = session(
      replaceStack(field(), 1, 0, 0, [
        { tileId: "grass" },
        { tileId: "deer", direction: "w" },
      ]),
    );
    const deer = play.actorIds().find((id) => id !== "local")!;
    expect(play.setPvp(true, deer)).toBe(false);
    expect(play.pvpOf(deer)).toBe(false);
  });

  it("comes back with a player the world remembers", () => {
    const play = session();
    play.spawn("them", { at: { x: 1, y: 0, z: 0 }, pvp: true });
    expect(play.pvpOf("them")).toBe(true);
  });
});
