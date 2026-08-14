import { describe, expect, it } from "vitest";
import { parseClientMessage } from "./protocol";

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
