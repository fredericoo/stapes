import { describe, expect, it } from "vitest";
import { GameSession } from "./GameSession";
import { TICK_MS, WALK_DURATION_MS } from "./constants";
import { chooseStep } from "./stepping";
import { getStack } from "../lib/mapData";
import { chunkifyMap } from "../lib/mapData";
import type { FlatMapFile, MapFile, PlacedTile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";

/**
 * The rule both machines walk by.
 *
 * Client-side prediction only works while the browser and the server agree
 * about what a held direction means — a client stepping by a rule of its own
 * would draw steps the server then takes back, and every disagreement is a
 * visible snap. So the rule lives in one function, and this covers the parts of
 * it that are easy to get subtly different: which held direction wins, and what
 * happens to facing when none of them can be walked.
 */

const frame = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

function tile(
  partial: Record<string, unknown> & Pick<TileDef, "id" | "height">,
): TileDef {
  return normalizeTileDef({
    name: partial.id,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    ...partial,
  });
}

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  // Tall and not walkable: the one thing on this board that genuinely stops a
  // step, as opposed to an empty cell, which is a step into a hole.
  tile({ id: "wall", height: 4, walkable: false }),
  tile({
    id: "player",
    height: 4,
    directional: true,
    affectedByGravity: true,
    walkable: false,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
  }),
];

const tilesById = tilesByIdFromList(tiles);

const grass: PlacedTile = { tileId: "grass" } as PlacedTile;
const wall: PlacedTile = { tileId: "wall" } as PlacedTile;

/** A grass strip along y=0 with a wall at x=2, so a walk east runs into it. */
function strip(): Record<string, PlacedTile[]> {
  const cells: Record<string, PlacedTile[]> = {};
  for (let x = 0; x < 4; x++) cells[`${x},0`] = [grass];
  cells["2,0"] = [grass, wall];
  return cells;
}

/** The strip with an actor standing on x=1: east blocked, west open. */
function walledMap(): MapFile {
  const cells = strip();
  cells["1,0"] = [grass, { tileId: "player", direction: "s" } as PlacedTile];
  return chunkifyMap({
    version: 1,
    levels: { "0": cells },
  } as unknown as FlatMapFile);
}

const AT = { x: 1, y: 0, z: 0, stackIndex: 1 };

describe("chooseStep", () => {
  const map = walledMap();
  const player = tilesById.player!;

  it("asks for nothing when nothing is held", () => {
    expect(
      chooseStep(map, AT, { directions: [] }, player, tilesById),
    ).toBeNull();
  });

  it("takes the direction pressed last", () => {
    const choice = chooseStep(
      map,
      AT,
      { directions: ["n", "w"] },
      player,
      tilesById,
    );
    expect(choice?.step?.direction).toBe("w");
    expect(choice?.step?.to).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("falls back to an older direction when the newest is blocked", () => {
    const choice = chooseStep(
      map,
      AT,
      { directions: ["w", "e"] },
      player,
      tilesById,
    );
    expect(choice?.step?.direction).toBe("w");
  });

  it("faces a wall it cannot walk into", () => {
    const choice = chooseStep(
      map,
      AT,
      { directions: ["e"] },
      player,
      tilesById,
    );
    expect(choice?.facing).toBe("e");
    expect(choice?.step).toBeNull();
  });

  it("turns without walking when asked only to face", () => {
    const choice = chooseStep(
      map,
      AT,
      { directions: ["w"], faceOnly: true },
      player,
      tilesById,
    );
    expect(choice?.facing).toBe("w");
    expect(choice?.step).toBeNull();
  });

  it("leaves a cell somebody else is walking into alone", () => {
    const choice = chooseStep(
      map,
      AT,
      { directions: ["w"] },
      player,
      tilesById,
      (to) => to.x === 0,
    );
    expect(choice?.step).toBeNull();
  });
});

/** Which cell the actor's tile is in, as an x. */
function actorX(session: GameSession, id: string): number {
  const actor = session.actorSnapshots().find((a) => a.id === id);
  if (!actor) throw new Error(`no actor ${id}`);
  return actor.x;
}

/**
 * One owned actor on x=0 of the walled strip. The map carries no player tile of
 * its own — the actor's body is the one `spawn` puts there, and a second,
 * unowned one would just be scenery in the way.
 */
function sessionOnStrip(): GameSession {
  const map = chunkifyMap({
    version: 1,
    levels: { "0": strip() },
  } as unknown as FlatMapFile);
  return new GameSession(map, tiles, {
    actorIds: ["a"],
    spawnAt: {
      x: 0,
      y: 0,
      z: 0,
      stackIndex: 1,
    },
  });
}

describe("GameSession.requestStep", () => {
  it("walks an actor that says it has already stepped", () => {
    const session = sessionOnStrip();
    expect(session.requestStep("a", "e")).toBe("started");

    for (let t = 0; t < WALK_DURATION_MS; t += TICK_MS) session.tick(TICK_MS);
    expect(actorX(session, "a")).toBe(1);
  });

  it("turns an actor towards a step it refuses", () => {
    const session = sessionOnStrip();
    session.requestStep("a", "e");
    for (let t = 0; t < WALK_DURATION_MS; t += TICK_MS) session.tick(TICK_MS);

    // On x=1 now, with the wall at x=2.
    expect(session.requestStep("a", "e")).toBe("refused");
    const actor = session.actorSnapshots().find((a) => a.id === "a");
    expect(actor?.direction).toBe("e");
    expect(actor?.x).toBe(1);
  });

  it("holds a step that arrives mid-walk rather than refusing it", () => {
    const session = sessionOnStrip();
    session.requestStep("a", "e");
    session.tick(TICK_MS);

    // The client is half a round trip ahead by design, so its next intent
    // routinely lands before this side is done with the last one. Refusing it
    // would make the world unwalkable.
    expect(session.requestStep("a", "e")).toBe("later");
  });

  /**
   * The invariant the server's queue is built on.
   *
   * A held key has always started the next step inside the very tick that
   * committed the last one. A queued step has to be takeable in that same tick
   * or every cell walked costs a tick of dead time, and the server falls
   * steadily further behind the client that is predicting it.
   */
  it("frees the actor in the same tick the walk commits", () => {
    const session = sessionOnStrip();
    session.requestStep("a", "e");

    let ticks = 0;
    while (session.requestStep("a", "e") === "later") {
      session.tick(TICK_MS);
      ticks += 1;
      if (ticks > 100) throw new Error("walk never committed");
    }

    // Free on the commit tick itself, standing on the cell it just reached.
    expect(actorX(session, "a")).toBe(1);
    expect(ticks).toBe(Math.ceil(WALK_DURATION_MS / TICK_MS));
  });

  it("refuses a step from an actor the board is still dropping", () => {
    // Spawned a level up with nothing under them: gravity takes over on the
    // first tick, and a fall is motion the client never predicted.
    const map = chunkifyMap({
      version: 1,
      levels: { "0": { "0,0": [grass], "1,0": [grass] }, "1": {} },
    } as unknown as FlatMapFile);
    const session = new GameSession(map, tiles, {
      actorIds: ["a"],
      spawnAt: {
        x: 0,
        y: 0,
        z: 1,
        stackIndex: 0,
      },
    });
    session.tick(TICK_MS);

    expect(session.requestStep("a", "e")).toBe("refused");
  });
});

describe("GameSession.faceActor", () => {
  it("turns an actor on the spot", () => {
    const session = sessionOnStrip();
    session.faceActor("a", "n");

    const stack = getStack(session.getMap(), 0, 0, 0);
    expect(stack[stack.length - 1]?.direction).toBe("n");
    expect(actorX(session, "a")).toBe(0);
  });
});
