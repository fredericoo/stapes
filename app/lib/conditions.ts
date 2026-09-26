import * as v from "valibot";

export const COMBINATORS = ["and", "or"] as const;

export type Combinator = (typeof COMBINATORS)[number];

export type ConditionGroup<Leaf> = {
  combinator: Combinator;
  not?: boolean;
  rules: ConditionNode<Leaf>[];
};

export type ConditionNode<Leaf> = Leaf | ConditionGroup<Leaf>;

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

export function conditionLeaves<Leaf extends object>(node: ConditionNode<Leaf>): Leaf[] {
  if (!isConditionGroup(node)) return [node];
  return node.rules.flatMap(conditionLeaves);
}

export type ConditionPath = number[];

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

export function appendTo<Leaf extends object>(
  root: ConditionNode<Leaf>,
  path: ConditionPath,
  node: ConditionNode<Leaf>,
): ConditionNode<Leaf> {
  const target = nodeAt(root, path);
  if (target === null || !isConditionGroup(target)) return root;
  return replaceAt(root, path, { ...target, rules: [...target.rules, node] });
}

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
