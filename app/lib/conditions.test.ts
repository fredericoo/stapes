import { describe, expect, it, vi } from "vitest";
import * as v from "valibot";
import {
  appendTo,
  conditionLeaves,
  conditionSchema,
  evaluateCondition,
  group,
  isConditionGroup,
  nodeAt,
  removeAt,
  replaceAt,
  type ConditionNode,
} from "./conditions";

/**
 * Composing questions, with a leaf vocabulary invented for the test.
 *
 * Deliberately not the brain's: this module's whole claim is that it knows
 * nothing about what a leaf means, and a test written against `in_range` would
 * quietly stop checking that. Here a leaf is a letter and whether it holds is a
 * lookup, which is the least this module could possibly be told.
 */
type Leaf = { name: string };

const leafSchema = v.object({ name: v.string() });

function leaf(name: string): Leaf {
  return { name };
}

/** A test that answers from a set, and records the order it was asked in. */
function asking(holding: string[], asked: string[] = []) {
  return (node: Leaf) => {
    asked.push(node.name);
    return holding.includes(node.name);
  };
}

describe("telling a group from a leaf", () => {
  it("reads a group by its rules, and anything else as a leaf", () => {
    expect(isConditionGroup(group("and", [leaf("a")]))).toBe(true);
    expect(isConditionGroup(leaf("a"))).toBe(false);
  });

  /**
   * `rules` is the one key a leaf vocabulary is asked to leave alone, so a
   * malformed group keeps reading as a group — and fails to parse as one —
   * rather than passing itself off as a leaf of some vocabulary.
   */
  it("still reads a group that lost its combinator as a group", () => {
    const broken = { rules: [leaf("a")] } as unknown as ConditionNode<Leaf>;
    expect(isConditionGroup(broken)).toBe(true);
    expect(v.safeParse(conditionSchema(leafSchema), broken).success).toBe(
      false,
    );
  });
});

describe("evaluating", () => {
  it("asks the leaf itself when there is no group at all", () => {
    expect(evaluateCondition(leaf("a"), asking(["a"]))).toBe(true);
    expect(evaluateCondition(leaf("a"), asking([]))).toBe(false);
  });

  it("wants every rule for and, and any one for or", () => {
    const both = group("and", [leaf("a"), leaf("b")]);
    const either = group("or", [leaf("a"), leaf("b")]);

    expect(evaluateCondition(both, asking(["a", "b"]))).toBe(true);
    expect(evaluateCondition(both, asking(["a"]))).toBe(false);
    expect(evaluateCondition(either, asking(["a"]))).toBe(true);
    expect(evaluateCondition(either, asking([]))).toBe(false);
  });

  it("inverts the whole group, not one rule of it", () => {
    const neither = group("or", [leaf("a"), leaf("b")], true);
    expect(evaluateCondition(neither, asking([]))).toBe(true);
    expect(evaluateCondition(neither, asking(["b"]))).toBe(false);
  });

  it("nests", () => {
    // a and (b or c)
    const nested = group("and", [
      leaf("a"),
      group("or", [leaf("b"), leaf("c")]),
    ]);
    expect(evaluateCondition(nested, asking(["a", "c"]))).toBe(true);
    expect(evaluateCondition(nested, asking(["b", "c"]))).toBe(false);
  });

  /**
   * The reason short-circuiting is a documented promise rather than an
   * incidental use of `every`. A leaf may record who set it off as it answers —
   * the brain's `heard` does — so a rule whose siblings have already settled the
   * group must not be asked and leave a fingerprint behind.
   */
  it("stops asking as soon as the answer is settled", () => {
    const asked: string[] = [];
    evaluateCondition(group("and", [leaf("a"), leaf("b")]), asking([], asked));
    expect(asked).toEqual(["a"]);

    const alsoAsked: string[] = [];
    evaluateCondition(
      group("or", [leaf("a"), leaf("b")]),
      asking(["a"], alsoAsked),
    );
    expect(alsoAsked).toEqual(["a"]);
  });

  /**
   * The parity a side-effecting leaf needs to know about. One `not` above it
   * means the branch is asking whether something did *not* happen; two cancel
   * out, because a question asked twice backwards is asked forwards.
   */
  it("tells a leaf how many nots it is under, by parity", () => {
    const seen: Array<[string, boolean]> = [];
    const record = (node: Leaf, negated: boolean) => {
      seen.push([node.name, negated]);
      return true;
    };

    evaluateCondition(
      group("and", [
        leaf("plain"),
        group("and", [leaf("once"), group("and", [leaf("twice")], true)], true),
      ]),
      record,
    );

    expect(seen).toEqual([
      ["plain", false],
      ["once", true],
      ["twice", false],
    ]);
  });
});

describe("reading the tree", () => {
  const tree = group("and", [leaf("a"), group("or", [leaf("b"), leaf("c")])]);

  it("lists every leaf in the order they are asked", () => {
    expect(conditionLeaves(tree)).toEqual([leaf("a"), leaf("b"), leaf("c")]);
    expect(conditionLeaves(leaf("lonely"))).toEqual([leaf("lonely")]);
  });

  it("walks to a node by its path, and answers nothing for a path that leads nowhere", () => {
    expect(nodeAt(tree, [])).toBe(tree);
    expect(nodeAt(tree, [0])).toEqual(leaf("a"));
    expect(nodeAt(tree, [1, 1])).toEqual(leaf("c"));
    expect(nodeAt(tree, [9])).toBeNull();
    // A leaf has no insides to walk into.
    expect(nodeAt(tree, [0, 0])).toBeNull();
  });
});

describe("editing the tree", () => {
  const tree = group("and", [leaf("a"), group("or", [leaf("b"), leaf("c")])]);

  it("swaps a nested node without touching its siblings", () => {
    const next = replaceAt(tree, [1, 0], leaf("z"));
    expect(conditionLeaves(next)).toEqual([leaf("a"), leaf("z"), leaf("c")]);
    // And the original is untouched, which is what React is relying on.
    expect(conditionLeaves(tree)).toEqual([leaf("a"), leaf("b"), leaf("c")]);
  });

  it("replaces the whole tree at the empty path", () => {
    expect(replaceAt(tree, [], leaf("z"))).toEqual(leaf("z"));
  });

  it("adds to the end of the group a path names", () => {
    const next = appendTo(tree, [1], leaf("d"));
    expect(conditionLeaves(next)).toEqual([
      leaf("a"),
      leaf("b"),
      leaf("c"),
      leaf("d"),
    ]);
  });

  it("will not add to a leaf, which has nothing to add to", () => {
    expect(appendTo(tree, [0], leaf("d"))).toBe(tree);
  });

  it("takes a rule out and leaves the rest in order", () => {
    const next = removeAt(tree, [1, 0]);
    expect(conditionLeaves(next!)).toEqual([leaf("a"), leaf("c")]);
  });

  /**
   * A group with nothing in it is refused at parse time, so leaving one behind
   * would make deleting a row a way to break the thing being edited.
   */
  it("takes an emptied group with it, all the way up", () => {
    const deep = group("and", [group("or", [group("and", [leaf("only")])])]);
    expect(removeAt(deep, [0, 0, 0])).toBeNull();

    const beside = group("and", [leaf("a"), group("or", [leaf("b")])]);
    expect(removeAt(beside, [1, 0])).toEqual(group("and", [leaf("a")]));
  });

  it("answers nothing once the last leaf is gone", () => {
    expect(removeAt(group("and", [leaf("a")]), [0])).toBeNull();
    expect(removeAt(leaf("a"), [])).toBeNull();
  });
});

describe("parsing", () => {
  const schema = conditionSchema(leafSchema);

  /**
   * The compatibility hinge. Every condition ever authored is a bare leaf, and
   * they all have to keep parsing without a migration.
   */
  it("takes a bare leaf as a whole condition", () => {
    expect(v.parse(schema, { name: "a" })).toEqual(leaf("a"));
  });

  it("takes a group, nested as deep as it likes", () => {
    const tree = group("and", [
      leaf("a"),
      group("or", [leaf("b"), group("and", [leaf("c")], true)]),
    ]);
    expect(v.parse(schema, tree)).toEqual(tree);
    // And through the actual disk trip.
    expect(v.parse(schema, JSON.parse(JSON.stringify(tree)))).toEqual(tree);
  });

  /**
   * An empty `and` is vacuously true and an empty `or` vacuously false, so the
   * combinator would decide whether an unfinished condition fires constantly or
   * never. Refusing is the only answer that does not silently pick one.
   */
  it("refuses a group with nothing in it", () => {
    expect(v.safeParse(schema, { combinator: "and", rules: [] }).success).toBe(
      false,
    );
  });

  it("refuses a combinator it does not have", () => {
    const bad = { combinator: "xor", rules: [leaf("a")] };
    expect(v.safeParse(schema, bad).success).toBe(false);
  });

  it("refuses a rule the leaf vocabulary does not accept", () => {
    const bad = { combinator: "and", rules: [{ nome: "a" }] };
    expect(v.safeParse(schema, bad).success).toBe(false);
  });
});

describe("building", () => {
  it("leaves `not` off entirely when it is not set", () => {
    expect(group("and", [leaf("a")])).toEqual({
      combinator: "and",
      rules: [leaf("a")],
    });
    expect(group("and", [leaf("a")], true)).toEqual({
      combinator: "and",
      not: true,
      rules: [leaf("a")],
    });
  });

  it("never asks a leaf twice for one evaluation", () => {
    const test = vi.fn(() => true);
    evaluateCondition(group("and", [leaf("a")]), test);
    expect(test).toHaveBeenCalledTimes(1);
  });
});
