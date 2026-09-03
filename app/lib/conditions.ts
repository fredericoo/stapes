import * as v from "valibot";

/**
 * Asking several questions at once, as data.
 *
 * The shape is react-querybuilder's — a group is `{ combinator, not, rules }`
 * and a rule is either a leaf or another group — and taking a shape somebody
 * else already settled is most of the point. It is the structure every
 * rule-builder UI in the world already knows how to draw, it survives a trip
 * through JSON without a parser, and nobody here has to defend a novel encoding
 * of "and".
 *
 * What is *not* borrowed is the leaf. react-querybuilder's rule is
 * `{ field, operator, value }`, which is the right answer to filtering rows of a
 * table and the wrong one for a question like "is my partner within five cells
 * and in plain view" — that has two parameters of different kinds, and squeezing
 * them into one `value` means encoding a selector back into a string. So this
 * module is generic over its leaf: it owns composition and nothing else, and
 * each caller brings the vocabulary it is composing. @see ../lib/brain
 *
 * **A bare leaf is a valid node.** That is the compatibility hinge and it is
 * deliberate: every condition ever authored — a whole `tiles.json` of them —
 * stays exactly as written, and a group only appears where somebody wanted one.
 * It also keeps the simple case simple, which is nearly every case.
 *
 * The one thing a leaf type may not have is a `rules` key, since that is how a
 * group is told from a leaf.
 */

/** The two ways a group joins its rules. */
export const COMBINATORS = ["and", "or"] as const;

export type Combinator = (typeof COMBINATORS)[number];

/**
 * Several questions joined into one.
 *
 * `not` inverts the whole group rather than any single rule, which is what makes
 * "everything except" one wrapper rather than a negated form of every leaf. A
 * group of one rule is the way to negate that rule alone, and that is not a
 * degenerate case — it is the normal shape of `not`.
 */
export type ConditionGroup<Leaf> = {
  combinator: Combinator;
  not?: boolean;
  /**
   * Never empty.
   *
   * An empty `and` is vacuously true and an empty `or` vacuously false, so the
   * combinator would decide whether a condition nobody finished writing fires
   * constantly or never. Both are worse than refusing it: this is parsed rather
   * than trusted, on the same terms the rest of an authored blob is, and a group
   * with nothing in it makes the whole thing inert instead of silently picking
   * one of the two.
   */
  rules: ConditionNode<Leaf>[];
};

export type ConditionNode<Leaf> = Leaf | ConditionGroup<Leaf>;

/**
 * Is this a group rather than a leaf?
 *
 * `rules` is the tell, and it is the one key a leaf vocabulary is asked to leave
 * alone. Checking the array rather than `combinator` means a hand-authored group
 * that lost its combinator still reads as a group and fails to parse as one,
 * rather than being mistaken for a leaf of some vocabulary that has no such
 * condition.
 */
export function isConditionGroup<Leaf extends object>(
  node: ConditionNode<Leaf>,
): node is ConditionGroup<Leaf> {
  return "rules" in node && Array.isArray((node as ConditionGroup<Leaf>).rules);
}

/** A group of one, which is how a single leaf is negated. */
export function group<Leaf>(
  combinator: Combinator,
  rules: ConditionNode<Leaf>[],
  not = false,
): ConditionGroup<Leaf> {
  return not ? { combinator, not, rules } : { combinator, rules };
}

/**
 * Does this hold, given something that can answer one leaf?
 *
 * Short-circuiting, and that matters beyond the wasted work: a leaf may be an
 * *event* query that records who set it off as it answers — which is exactly
 * what the brain's `heard` does — so an `and` whose first rule already failed
 * must not go on to ask the second and leave its fingerprints behind.
 *
 * The `negated` flag handed to `test` is the parity of the `not`s above this
 * leaf, and it exists for those same side-effecting leaves. A branch asking
 * whether something did *not* happen has nobody to name, so a caller whose
 * leaves record a subject uses this to put back what was there — see
 * `holds` in `../game/brainRuntime`. Callers with pure leaves ignore it.
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
 * Where a node sits, as the indices to walk from the root.
 *
 * react-querybuilder's own addressing, and the reason to keep it is that a tree
 * editor needs to name a node it is about to change without holding a reference
 * to it — React has just handed the row a copy, and the thing that must change
 * is the tree the copy came out of. An empty path is the root.
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
 * The tree with the node at `path` swapped for `next`.
 *
 * Returns the root unchanged when the path leads nowhere, on the terms every
 * other mutation here does: an editor asking about a row that has already gone
 * is a race, not a bug worth throwing over.
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
  rules[index] = replaceAt(rules[index]!, rest, next);
  return { ...root, rules };
}

/**
 * The tree with `node` added to the end of the group at `path`.
 *
 * Unchanged when the path names a leaf: there is nothing to add to, and an
 * editor that could turn a leaf into a group by adding to it would be doing
 * something the author did not ask for.
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
 * A group emptied by the removal goes with it, recursively — a bare `and` with
 * no rules is not a thing this module lets exist, so leaving one behind to be
 * refused at parse time would make deleting a row a way to break a brain.
 *
 * Null means the caller removed the last leaf in the tree. Whoever owns the
 * condition decides what that means; the brain's editor simply does not offer
 * the button, since a transition with no `if` has nothing to fire on.
 */
export function removeAt<Leaf extends object>(
  root: ConditionNode<Leaf>,
  path: ConditionPath,
): ConditionNode<Leaf> | null {
  const [index, ...rest] = path;
  if (index === undefined) return null;
  if (!isConditionGroup(root) || root.rules[index] === undefined) return root;

  const pruned = rest.length === 0 ? null : removeAt(root.rules[index], rest);
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
