import { MAP_FILE_VERSION } from "../lib/types";
import { describe, expect, it } from "vitest";
import { parseClientMessage, parseServerMessage, type MotionEvent } from "./protocol";
import { SWING_OUTCOMES } from "../game/GameSession";
import { MAX_COMMAND_LENGTH } from "../game/commands";

function parsed(message: unknown) {
  return parseClientMessage(JSON.stringify(message));
}

describe("moveItem", () => {
  it("takes a move between two slots on the body", () => {
    expect(
      parsed({ type: "moveItem", from: { kind: "contents", index: 0 }, to: { kind: "weapon" } }),
    ).toEqual({
      type: "moveItem",
      from: { kind: "contents", index: 0 },
      to: { kind: "weapon" },
    });
  });

  it("takes a ground endpoint with its whole reference", () => {
    const from = {
      kind: "ground",
      ref: { x: -3, y: 4, z: 0, stackIndex: 1 },
      index: 2,
    };
    expect(parsed({ type: "moveItem", from, to: { kind: "contents", index: 0 } })).toEqual({
      type: "moveItem",
      from,
      to: { kind: "contents", index: 0 },
    });
  });

  it("takes the body as either end of a move", () => {
    expect(parsed({ type: "moveItem", from: { kind: "armor" }, to: { kind: "weapon" } })).toEqual({
      type: "moveItem",
      from: { kind: "armor" },
      to: { kind: "weapon" },
    });
    expect(
      parsed({
        type: "moveItem",
        from: { kind: "contents", index: 0 },
        to: { kind: "armor" },
      }),
    ).toEqual({
      type: "moveItem",
      from: { kind: "contents", index: 0 },
      to: { kind: "armor" },
    });
  });

  it("takes a contents slot naming the hand it is inside", () => {
    const from = { kind: "contents", index: 1, of: "offhand" };
    expect(parsed({ type: "moveItem", from, to: { kind: "weapon" } })).toEqual({
      type: "moveItem",
      from,
      to: { kind: "weapon" },
    });
  });

  it("drops a hand nobody has", () => {
    expect(
      parsed({
        type: "moveItem",
        from: { kind: "contents", index: 0, of: "bag" },
        to: { kind: "weapon" },
      }),
    ).toBeNull();
  });

  it("drops a slot kind nobody defined", () => {
    expect(parsed({ type: "moveItem", from: { kind: "hat" }, to: { kind: "weapon" } })).toBeNull();
  });

  it("drops a negative or fractional index", () => {
    expect(
      parsed({ type: "moveItem", from: { kind: "contents", index: -1 }, to: { kind: "weapon" } }),
    ).toBeNull();
    expect(
      parsed({ type: "moveItem", from: { kind: "contents", index: 1.5 }, to: { kind: "weapon" } }),
    ).toBeNull();
  });

  it("takes an index that is merely too big, and leaves the refusal to the board", () => {
    expect(
      parsed({ type: "moveItem", from: { kind: "contents", index: 9999 }, to: { kind: "weapon" } }),
    ).not.toBeNull();
  });

  it("drops a ground reference with a coordinate that is not a whole number", () => {
    const from = {
      kind: "ground",
      ref: { x: 0.5, y: 0, z: 0, stackIndex: 0 },
      index: 0,
    };
    expect(parsed({ type: "moveItem", from, to: { kind: "contents", index: 0 } })).toBeNull();
  });

  it("drops a ground reference with a negative stack index", () => {
    const from = {
      kind: "ground",
      ref: { x: 0, y: 0, z: 0, stackIndex: -1 },
      index: 0,
    };
    expect(parsed({ type: "moveItem", from, to: { kind: "contents", index: 0 } })).toBeNull();
  });

  it("drops one missing an end", () => {
    expect(parsed({ type: "moveItem", from: { kind: "weapon" } })).toBeNull();
  });
});

describe("consume", () => {
  it("takes a slot source", () => {
    const message = {
      type: "consume",
      from: { kind: "slot", slot: { kind: "contents", index: 1 } },
    };
    expect(parsed(message)).toEqual(message);
  });

  it("takes a floor source with its whole reference", () => {
    const message = {
      type: "consume",
      from: { kind: "floor", ref: { x: -2, y: 3, z: 1, stackIndex: 1 } },
    };
    expect(parsed(message)).toEqual(message);
  });

  it("drops a source kind nobody defined", () => {
    expect(parsed({ type: "consume", from: { kind: "mouth" } })).toBeNull();
  });

  it("drops a floor reference with a coordinate that is not a whole number", () => {
    expect(
      parsed({
        type: "consume",
        from: { kind: "floor", ref: { x: 0.5, y: 0, z: 0, stackIndex: 0 } },
      }),
    ).toBeNull();
  });

  it("drops a slot source with a negative index", () => {
    expect(
      parsed({
        type: "consume",
        from: { kind: "slot", slot: { kind: "contents", index: -1 } },
      }),
    ).toBeNull();
  });

  it("drops one missing its source", () => {
    expect(parsed({ type: "consume" })).toBeNull();
  });
});

describe("craft", () => {
  it("carries the placement and which of its recipes was pressed", () => {
    const message = {
      type: "craft",
      ref: { x: -2, y: 3, z: 1, stackIndex: 2 },
      recipe: 1,
    };
    expect(parsed(message)).toEqual(message);
  });

  it("drops one with no recipe named", () => {
    expect(parsed({ type: "craft", ref: { x: 0, y: 0, z: 0, stackIndex: 0 } })).toBeNull();
  });

  it("drops a negative recipe, which is no position at all", () => {
    expect(
      parsed({
        type: "craft",
        ref: { x: 0, y: 0, z: 0, stackIndex: 0 },
        recipe: -1,
      }),
    ).toBeNull();
  });

  it("keeps a recipe past the end, which the session refuses instead", () => {
    const message = {
      type: "craft",
      ref: { x: 0, y: 0, z: 0, stackIndex: 0 },
      recipe: 99,
    };
    expect(parsed(message)).toEqual(message);
  });
});

describe("command", () => {
  it("carries the line as typed, because the grammar is not the wire's business", () => {
    const message = { type: "command", text: "/mastery sharp 10 self" };
    expect(parsed(message)).toEqual(message);
  });

  it("drops one long enough to be an attack rather than a command", () => {
    expect(parsed({ type: "command", text: "/".repeat(MAX_COMMAND_LENGTH + 1) })).toBeNull();
  });
});

describe("cancelCast", () => {
  it("carries nothing but its name", () => {
    expect(parsed({ type: "cancelCast" })).toEqual({ type: "cancelCast" });
  });
});

describe("the frame itself", () => {
  it("drops something that is not JSON at all", () => {
    expect(parseClientMessage("{not json")).toBeNull();
  });

  it("drops a type nobody handles", () => {
    expect(parsed({ type: "selfDestruct" })).toBeNull();
  });

  it("still takes the messages that were already here", () => {
    expect(parsed({ type: "pickUp", ref: { x: 1, y: 2, z: 0, stackIndex: 3 } })).toEqual({
      type: "pickUp",
      ref: { x: 1, y: 2, z: 0, stackIndex: 3 },
    });
    expect(parsed({ type: "interact", ref: { x: 1.5, y: 0, z: 0, stackIndex: 0 } })).toBeNull();
  });
});

describe("drop", () => {
  it("takes a slot and a cell", () => {
    expect(
      parsed({
        type: "drop",
        from: { kind: "contents", index: 1 },
        to: { x: -2, y: 3, z: 0 },
      }),
    ).toEqual({
      type: "drop",
      from: { kind: "contents", index: 1 },
      to: { x: -2, y: 3, z: 0 },
    });
  });

  it("takes the bag off your back", () => {
    expect(
      parsed({ type: "drop", from: { kind: "bag" }, to: { x: 0, y: 0, z: 0 } }),
    ).not.toBeNull();
  });

  it("drops a cell that is not whole numbers", () => {
    expect(
      parsed({
        type: "drop",
        from: { kind: "weapon" },
        to: { x: 0.5, y: 0, z: 0 },
      }),
    ).toBeNull();
  });

  it("keeps a stray stack index out of the cell it parses", () => {
    expect(
      parsed({
        type: "drop",
        from: { kind: "weapon" },
        to: { x: 0, y: 0, z: 0, stackIndex: 2 },
      }),
    ).toEqual({
      type: "drop",
      from: { kind: "weapon" },
      to: { x: 0, y: 0, z: 0 },
    });
  });

  it("drops one missing its destination", () => {
    expect(parsed({ type: "drop", from: { kind: "weapon" } })).toBeNull();
  });
});

describe("a kit that will not parse", () => {
  const badItem = { tileId: "rusty-sword" };

  const EMPTY_KIT = {
    weapon: null,
    offhand: null,
    armor: null,
    head: null,
    charm: null,
    footwear: null,
    bag: null,
  };

  function helloWith(equipment: unknown) {
    return JSON.stringify({
      type: "hello",
      selfId: "a",
      map: { version: MAP_FILE_VERSION, levels: {} },
      actorIds: ["a"],
      playerCount: 1,
      minutesOfDay: 480,
      hps: [],
      carriedLights: [],
      equipment,
      tags: [],
      statuses: [],
    });
  }

  it("still lets the world through, and hands back an empty kit", () => {
    const message = parseServerMessage(
      helloWith({
        weapon: null,
        offhand: null,
        armor: null,
        bag: { id: "itm_bag", tileId: "basic-bag", contents: [badItem] },
      }),
    );
    expect(message).not.toBeNull();
    expect(message).toMatchObject({ type: "hello", selfId: "a" });
    expect(message?.type === "hello" && message.equipment).toEqual(EMPTY_KIT);
  });

  it("empties the kit rather than salvaging the half it could read", () => {
    const message = parseServerMessage(
      helloWith({
        weapon: { id: "itm_w", tileId: "rusty-sword" },
        offhand: null,
        armor: null,
        bag: { id: "itm_bag", tileId: "basic-bag", contents: [badItem] },
      }),
    );
    expect(message?.type === "hello" && message.equipment.weapon).toBeNull();
  });

  it("does the same for the equipment message on its own", () => {
    const message = parseServerMessage(
      JSON.stringify({
        type: "equipment",
        equipment: { weapon: badItem, offhand: null, armor: null, bag: null },
      }),
    );
    expect(message).not.toBeNull();
    expect(message?.type === "equipment" && message.equipment).toEqual(EMPTY_KIT);
  });

  it("reads a kit saved before the worn slots existed", () => {
    const message = parseServerMessage(
      JSON.stringify({
        type: "equipment",
        equipment: {
          weapon: { id: "itm_w", tileId: "rusty-sword" },
          offhand: null,
          bag: null,
        },
      }),
    );
    expect(message?.type === "equipment" && message.equipment).toEqual({
      ...EMPTY_KIT,
      weapon: { id: "itm_w", tileId: "rusty-sword" },
    });
  });

  it("still takes a kit it can read", () => {
    const equipment = {
      ...EMPTY_KIT,
      weapon: { id: "itm_w", tileId: "rusty-sword" },
      armor: { id: "itm_a", tileId: "chain-mail" },
      head: { id: "itm_h", tileId: "iron-helm" },
      charm: { id: "itm_r", tileId: "copper-ring" },
      footwear: { id: "itm_f", tileId: "worn-boots" },
      bag: {
        id: "itm_b",
        tileId: "basic-bag",
        contents: [{ id: "itm_c", tileId: "hand-lantern" }],
      },
    };
    const message = parseServerMessage(JSON.stringify({ type: "equipment", equipment }));
    expect(message?.type === "equipment" && message.equipment).toEqual(equipment);
  });

  it("is not a licence for the rest of the message", () => {
    expect(
      parseServerMessage(
        helloWith({ weapon: null, offhand: null, bag: null }).replace(
          '"playerCount":1',
          '"playerCount":"lots"',
        ),
      ),
    ).toBeNull();
  });
});

describe("nothing is quietly dropped in transit", () => {
  const damageEvent = {
    kind: "damage" as const,
    id: "hit-1",
    targetId: "rat",
    outcome: "miss" as const,
    amount: 0,
    x: 1,
    y: 2,
    z: 0,
    stackIndex: 1,
  };

  it("carries a damage event through whole", () => {
    const message = parseServerMessage(
      JSON.stringify({
        type: "patch",
        cells: [],
        events: [damageEvent],
        hps: [],
        carriedLights: [],
      }),
    );

    expect(message?.type === "patch" && message.events[0]).toEqual(damageEvent);
  });

  it("keeps every outcome a swing can have", () => {
    for (const outcome of SWING_OUTCOMES) {
      const message = parseServerMessage(
        JSON.stringify({
          type: "patch",
          cells: [],
          events: [{ ...damageEvent, outcome }],
          hps: [],
          carriedLights: [],
        }),
      );
      expect(message?.type === "patch" && message.events[0]).toEqual({
        ...damageEvent,
        outcome,
      });
    }
  });

  it("carries a body's rating beside its hit points", () => {
    const hp = { actorId: "rat", hp: 3, maxHp: 11, rating: 8 };
    const message = parseServerMessage(
      JSON.stringify({
        type: "patch",
        cells: [],
        events: [],
        hps: [hp],
        carriedLights: [],
      }),
    );

    expect(message?.type === "patch" && message.hps[0]).toEqual(hp);
  });

  it("carries who a cast is aimed at", () => {
    const cast = {
      actorId: "wolf",
      progress: {
        remainingMs: 1_500,
        durationMs: 3_000,
        slot: { from: "natural", name: "Howl" },
        targetId: "rat",
      },
    };
    const message = parseServerMessage(
      JSON.stringify({
        type: "patch",
        cells: [],
        events: [],
        hps: [],
        carriedLights: [],
        castings: [cast],
      }),
    );

    expect(message?.type === "patch" && message.castings[0]).toEqual(cast);
  });

  it("carries a body's pull, and reads its absence as nobody pulling", () => {
    const pull = { actorId: "deer", progress: { remainingMs: 1_500, durationMs: 2_000 } };
    const patchOf = (extra: Record<string, unknown>) =>
      parseServerMessage(
        JSON.stringify({
          type: "patch",
          cells: [],
          events: [],
          hps: [],
          carriedLights: [],
          ...extra,
        }),
      );

    const withPull = patchOf({ extractions: [pull] });
    expect(withPull?.type === "patch" && withPull.extractions).toEqual([pull]);

    const without = patchOf({});
    expect(without?.type === "patch" && without.extractions).toEqual([]);
  });

  it("carries one of every event kind through whole", () => {
    const oneOfEach: {
      [K in MotionEvent["kind"]]: Extract<MotionEvent, { kind: K }>;
    } = {
      walkStarted: {
        kind: "walkStarted",
        actorId: "rat",
        from: { x: 0, y: 0, z: 0 },
        to: { x: 1, y: 0, z: 0 },
        direction: "e",
      },
      fallStarted: { kind: "fallStarted", actorId: "rat", feetAbs: 4, landingAbs: 0 },
      slideStarted: {
        kind: "slideStarted",
        actorId: "rat",
        object: { x: 1, y: 0, z: 0, stackIndex: 1 },
        from: { x: 0, y: 0, z: 0 },
        count: 1,
      },
      strikeStarted: {
        kind: "strikeStarted",
        actorId: "rat",
        strike: "swing",
        dx: 1,
        dy: 0,
        dElev: 0,
      },
      teleported: { kind: "teleported", actorId: "rat" },
      swung: { kind: "swung", actorId: "rat" },
      joined: { kind: "joined", actorId: "rat" },
      left: { kind: "left", actorId: "rat" },
      spawned: {
        kind: "spawned",
        actorId: "rat",
        at: { x: 1, y: 0, z: 0, stackIndex: 1 },
      },
      despawned: { kind: "despawned", actorId: "rat" },
      projectileFired: {
        kind: "projectileFired",
        id: "shot-1",
        tileId: "arrow",
        from: { x: 0, y: 0, elevAbs: 2 },
        to: { x: 3, y: 0, elevAbs: 2 },
        targetId: "rat",
        hit: true,
      },
      tileTransition: {
        kind: "tileTransition",
        id: "transition-1",
        side: "appear",
        tileId: "flame",
        x: 1,
        y: 0,
        z: 0,
        stackIndex: 1,
      },
      damage: damageEvent,
    };

    for (const event of Object.values(oneOfEach)) {
      const message = parseServerMessage(
        JSON.stringify({
          type: "patch",
          cells: [],
          events: [event],
          hps: [],
          carriedLights: [],
        }),
      );
      expect(message?.type === "patch" && message.events[0]).toEqual(event);
    }
  });

  it("carries a struck body's borrowed effect through whole", () => {
    const event = {
      kind: "tileTransition" as const,
      id: "transition-2",
      side: "appear" as const,
      tileId: "rat",
      x: 1,
      y: 0,
      z: 0,
      stackIndex: 1,
      struckBy: "arrow",
    };

    const message = parseServerMessage(
      JSON.stringify({
        type: "patch",
        cells: [],
        events: [event],
        hps: [],
        carriedLights: [],
      }),
    );

    expect(message?.type === "patch" && message.events[0]).toEqual(event);
  });
});
