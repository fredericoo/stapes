import { describe, expect, it } from "vitest";
import { parseClientMessage, parseServerMessage } from "./protocol";

/**
 * What a browser is allowed to say.
 *
 * Everything inbound arrives from a machine nobody controls, so the standard is
 * that a malformed message is a *dropped* message and never a crashed world. The
 * cases worth pinning are the ones where a number reaches a map lookup:
 * coordinates have to be whole, and a slot index has to be a number that can be
 * compared against a container's size.
 */

function parsed(message: unknown) {
  return parseClientMessage(JSON.stringify(message));
}

describe("moveItem", () => {
  it("takes a move between two slots on the body", () => {
    expect(
      parsed({ type: "moveItem", from: { kind: "contents",
index: 0 }, to: { kind: "weapon" } }),
    ).toEqual({
      type: "moveItem",
      from: { kind: "contents",
index: 0 },
      to: { kind: "weapon" },
    });
  });

  it("takes a ground endpoint with its whole reference", () => {
    const from = {
      kind: "ground",
      ref: { x: -3, y: 4, z: 0, stackIndex: 1 },
      index: 2,
    };
    expect(parsed({ type: "moveItem", from, to: { kind: "contents",
index: 0 } })).toEqual({
      type: "moveItem",
      from,
      to: { kind: "contents",
index: 0 },
    });
  });

  it("drops a slot kind nobody defined", () => {
    expect(
      parsed({ type: "moveItem", from: { kind: "hat" }, to: { kind: "weapon" } }),
    ).toBeNull();
  });

  it("drops a negative or fractional index", () => {
    expect(
      parsed({ type: "moveItem", from: { kind: "contents",
index: -1 }, to: { kind: "weapon" } }),
    ).toBeNull();
    expect(
      parsed({ type: "moveItem", from: { kind: "contents",
index: 1.5 }, to: { kind: "weapon" } }),
    ).toBeNull();
  });

  /**
   * An index past the end of a container is *not* refused here. What an index
   * may be depends on the size of the thing it is read against, which the
   * session knows and this schema does not — so it parses, reads as an empty
   * slot, and is refused in the one place capacity is understood.
   */
  it("takes an index that is merely too big, and leaves the refusal to the board", () => {
    expect(
      parsed({ type: "moveItem", from: { kind: "contents",
index: 9999 }, to: { kind: "weapon" } }),
    ).not.toBeNull();
  });

  it("drops a ground reference with a coordinate that is not a whole number", () => {
    const from = {
      kind: "ground",
      ref: { x: 0.5, y: 0, z: 0, stackIndex: 0 },
      index: 0,
    };
    expect(parsed({ type: "moveItem", from, to: { kind: "contents",
index: 0 } })).toBeNull();
  });

  it("drops a ground reference with a negative stack index", () => {
    const from = {
      kind: "ground",
      ref: { x: 0, y: 0, z: 0, stackIndex: -1 },
      index: 0,
    };
    expect(parsed({ type: "moveItem", from, to: { kind: "contents",
index: 0 } })).toBeNull();
  });

  it("drops one missing an end", () => {
    expect(parsed({ type: "moveItem", from: { kind: "weapon" } })).toBeNull();
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
    expect(parsed({ type: "pickUp", ref: { x: 1, y: 2, z: 0, stackIndex: 3 } })).toEqual(
      { type: "pickUp", ref: { x: 1, y: 2, z: 0, stackIndex: 3 } },
    );
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

  /**
   * A cell, never a stack slot: you choose where, and gravity chooses how high.
   * An extra field is *stripped* rather than refused — these are `v.object`
   * throughout, which is the standard this protocol already holds itself to, and
   * the parsed message is the cell with nothing else riding along.
   */
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

/**
 * A kit the client cannot read must cost the client its kit, and nothing else.
 *
 * The failure this replaces was total: `hello` carries the map, and one item in
 * one pocket that did not satisfy the schema took the whole message with it —
 * so a player who had touched the wrong sword connected, streamed patches, and
 * never finished joining, with nothing in the game they could do about it.
 */
describe("a kit that will not parse", () => {
  const badItem = { tileId: "rusty-sword" };

  function helloWith(equipment: unknown) {
    return JSON.stringify({
      type: "hello",
      selfId: "a",
      map: { version: 1, levels: {} },
      actorIds: ["a"],
      playerCount: 1,
      minutesOfDay: 480,
      hps: [],
      carriedLights: [],
      equipment,
    });
  }

  it("still lets the world through, and hands back an empty kit", () => {
    const message = parseServerMessage(
      helloWith({ weapon: null, bag: { id: "itm_bag", tileId: "basic-bag", contents: [badItem] } }),
    );
    expect(message).not.toBeNull();
    expect(message).toMatchObject({ type: "hello", selfId: "a", playerCount: 1 });
    expect(message?.type === "hello" && message.equipment).toEqual({
      weapon: null,
      bag: null,
    });
  });

  it("empties the kit rather than salvaging the half it could read", () => {
    // A readable weapon beside an unreadable bag. Keeping the weapon would be
    // the client deciding what somebody is holding, which is the server's to
    // say — and two clients deciding differently is how one sword becomes two.
    const message = parseServerMessage(
      helloWith({
        weapon: { id: "itm_w", tileId: "rusty-sword" },
        bag: { id: "itm_bag", tileId: "basic-bag", contents: [badItem] },
      }),
    );
    expect(message?.type === "hello" && message.equipment.weapon).toBeNull();
  });

  it("does the same for the equipment message on its own", () => {
    const message = parseServerMessage(
      JSON.stringify({ type: "equipment", equipment: { weapon: badItem, bag: null } }),
    );
    expect(message).not.toBeNull();
    expect(message?.type === "equipment" && message.equipment).toEqual({
      weapon: null,
      bag: null,
    });
  });

  it("still takes a kit it can read", () => {
    const equipment = {
      weapon: { id: "itm_w", tileId: "rusty-sword" },
      bag: { id: "itm_b", tileId: "basic-bag", contents: [{ id: "itm_c", tileId: "hand-lantern" }] },
    };
    const message = parseServerMessage(JSON.stringify({ type: "equipment", equipment }));
    expect(message?.type === "equipment" && message.equipment).toEqual(equipment);
  });

  // The tolerance is the equipment field's alone: a `hello` whose *world* cannot
  // be read is still a message with nothing to draw.
  it("is not a licence for the rest of the message", () => {
    expect(parseServerMessage(helloWith({ weapon: null, bag: null }).replace('"playerCount":1', '"playerCount":"lots"'))).toBeNull();
  });
});
