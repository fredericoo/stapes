import * as v from "valibot";

/**
 * Composable conditions, as data.
 *
 * The shape is react-querybuilder's: a group is `{ combinator, not, rules }`
 * and a rule is either a leaf or another group. It survives JSON as is and
 * every rule-builder UI already draws it.
 *
 * The leaf is not borrowed. react-querybuilder's `{ field, operator, value }`
 * cannot hold a question with two parameters of different kinds ("is my
 * partner within five cells and in plain view") without encoding a selector
 * into a string, so this module is generic over its leaf and owns only the
 * composition. @see ../lib/brain
 *
 * A bare leaf is a valid node; a group only appears where somebody wanted one.
 * The one thing a leaf type may not have is a `rules` key, since that is how a
 * group is told from a leaf.
 */

export const COMBINATORS = ["and", "or"] as const;

export type Combinator = (typeof COMBINATORS)[number];

/**
 * `not` inverts the whole group rather than any single rule. A group of one
 * rule is the way to negate that rule alone.
 */
export type ConditionGroup<Leaf> = {
  combinator: Combinator;
  not?: boolean;
  /**
   * Never empty. An empty `and` is vacuously true and an empty `or` vacuously
   * false, so a group nobody finished writing would fire constantly or never;
   * the schema refuses it instead.
   */
  rules: ConditionNode<Leaf>[];
};

export type ConditionNode<Leaf> = Leaf | ConditionGroup<Leaf>;

/**
 * Checks `rules` rather than `combinator` so a hand-authored group that lost
 * its combinator still reads as a group and fails to parse as one, rather than
 * being mistaken for a leaf.
 */
export function isConditionGroup<Leaf extends object>(
  node: ConditionNode<Leaf>,
): node is ConditionGroup<Leaf> {
  return "rules" in node && Array.isArray((node as ConditionGroup<Leaf>).rules);
}

export function group<Leaf>(
  combinator: Combinator,
  rules: ConditionNode<Leaf>[],
  not = false,
): ConditionGroup<Leaf> {
  return not ? { combinator, not, rules } : { combinator, rules };
}

/**
 * Short-circuits, and that matters beyond the wasted work: a leaf may be an
 * event query that records who set it off as it answers (the brain's `heard`),
 * so an `and` whose first rule failed must not go on to ask the second.
 *
 * The `negated` flag handed to `test` is the parity of the `not`s above this
 * leaf, for those same side-effecting leaves: a branch asking whether something
 * did not happen has nobody to name, so a caller whose leaves record a subject
 * uses it to put back what was there — see `holds` in `../game/brainRuntime`.
 * Callers with pure leaves ignore it.
 */
export function evaluateCondition<Leaf extends object>(
  node: ConditionNode<Leaf>,
  test: (leaf: Leaf, negated: boolean) => boolean,
): boolean {
  return holdsUnder(node, test, false);
}

function holdsUnder<Leaf extends object>(
  node: ConditionNode<Leaf>,
  test: (leaf: Leaf, negated: boolean) => boolean,
  negated: boolean,
): boolean {
  if (!isConditionGroup(node)) return test(node, negated);

  const inside = node.not ? !negated : negated;
  const held =
    node.combinator === "and"
      ? node.rules.every((rule) => holdsUnder(rule, test, inside))
      : node.rules.some((rule) => holdsUnder(rule, test, inside));
  return node.not ? !held : held;
}

/** Every leaf in the tree, in the order they are asked. */
export function conditionLeaves<Leaf extends object>(
  node: ConditionNode<Leaf>,
): Leaf[] {
  if (!isConditionGroup(node)) return [node];
  return node.rules.flatMap(conditionLeaves);
}

/**
 * Where a node sits, as the indices to walk from the root. An empty path is
 * the root. A tree editor needs to name a node without holding a reference to
 * it, since React hands the row a copy and the tree is what must change.
 */
export type ConditionPath = number[];

/** The node at `path`, or null when the path leads nowhere. */
export function nodeAt<Leaf extends object>(
  root: ConditionNode<Leaf>,
  path: ConditionPath,
): ConditionNode<Leaf> | null {
  let node: ConditionNode<Leaf> | undefined = root;
  for (const index of path) {
    if (node === undefined || !isConditionGroup(node)) return null;
    node = node.rules[index];
  }
  return node ?? null;
}

/**
 * The tree with the node at `path` swapped for `next`. Returns the root
 * unchanged when the path leads nowhere, as every mutation here does: an
 * editor asking about a row that has already gone is a race, not a bug.
 */
export function replaceAt<Leaf extends object>(
  root: ConditionNode<Leaf>,
  path: ConditionPath,
  next: ConditionNode<Leaf>,
): ConditionNode<Leaf> {
  const [index, ...rest] = path;
  if (index === undefined) return next;
  if (!isConditionGroup(root) || root.rules[index] === undefined) return root;

  const rules = [...root.rules];
  rules[index] = replaceAt(rules[index], rest, next);
  return { ...root, rules };
}

/**
 * The tree with `node` added to the end of the group at `path`. Unchanged when
 * the path names a leaf: adding to a leaf must not turn it into a group.
 */
export function appendTo<Leaf extends object>(
  root: ConditionNode<Leaf>,
  path: ConditionPath,
  node: ConditionNode<Leaf>,
): ConditionNode<Leaf> {
  const target = nodeAt(root, path);
  if (target === null || !isConditionGroup(target)) return root;
  return replaceAt(root, path, { ...target, rules: [...target.rules, node] });
}

/**
 * The tree with the node at `path` taken out, or null when nothing is left.
 *
 * A group emptied by the removal goes with it, recursively, because an empty
 * group is refused at parse time. Null means the last leaf was removed; the
 * owner of the condition decides what that means.
 */
export function removeAt<Leaf extends object>(
  root: ConditionNode<Leaf>,
  path: ConditionPath,
): ConditionNode<Leaf> | null {
  const [index, ...rest] = path;
  if (index === undefined) return null;
  if (!isConditionGroup(root) || root.rules[index] === undefined) return root;

  const pruned =
    rest.length === 0 ? null : removeAt(root.rules[index], rest);
  const rules =
    pruned === null
      ? root.rules.filter((_rule, at) => at !== index)
      : root.rules.map((rule, at) => (at === index ? pruned : rule));

  return rules.length === 0 ? null : { ...root, rules };
}

/**
 * The schema for a tree of `leafSchema`, refusing anything else.
 *
 * Recursive through `v.lazy`, which is what lets a group hold groups. Groups are
 * tried before leaves so a vocabulary that happened to accept a stray object
 * cannot swallow one.
 */
export function conditionSchema<Leaf extends object>(
  leafSchema: v.GenericSchema<unknown, Leaf>,
): v.GenericSchema<unknown, ConditionNode<Leaf>> {
  const node: v.GenericSchema<unknown, ConditionNode<Leaf>> = v.lazy(() =>
    v.union([groupSchema, leafSchema]),
  );
  const groupSchema: v.GenericSchema<unknown, ConditionGroup<Leaf>> = v.object({
    combinator: v.picklist(COMBINATORS),
    not: v.optional(v.boolean()),
    rules: v.pipe(v.array(node), v.minLength(1)),
  }) as v.GenericSchema<unknown, ConditionGroup<Leaf>>;
  return node;
}
