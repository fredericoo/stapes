import type { ReactNode } from "react";
import {
  appendTo,
  group,
  isConditionGroup,
  removeAt,
  replaceAt,
  type Combinator,
  type ConditionGroup,
  type ConditionNode,
  type ConditionPath,
} from "../lib/conditions";
import { Button, Segmented, Switch } from "../ui";

/**
 * An `if`, however deep it goes — for any vocabulary of leaves.
 *
 * `../lib/conditions` owns composition and nothing else, and this is the same
 * split drawn: the tree knows how to add, nest, invert and remove, and the
 * caller brings the one row that knows what a leaf *is*. The brain hands over
 * its condition picker; a dialog hands over its own. Two vocabularies, one
 * editor, and no way for either to grow a different idea of "and".
 *
 * Two shapes, and which one is on screen is the authored shape rather than a
 * normalisation: a bare condition draws as one row with nothing around it, and
 * only somebody reaching for "and" turns it into a box. Nearly every condition
 * ever written asks one question, and wrapping all of them in a group with a
 * combinator nobody chose would put a decision on screen the author never made.
 *
 * The tree is edited by *path* rather than by handing each row a callback that
 * closes over its own copy. A row is a copy React already rendered; what has to
 * change is the tree it came from, and naming the position is the only way a
 * nested row can say which node it means.
 */

/** What a vocabulary brings: how to draw one leaf, and what a new one says. */
export type LeafEditor<Leaf extends object> = {
  render: (leaf: Leaf, onChange: (next: Leaf) => void) => ReactNode;
  /** What a newly added row asks until the author says otherwise. */
  fresh: () => Leaf;
};

export function ConditionTreeEditor<Leaf extends object>({
  root,
  leaf,
  onChange,
}: {
  root: ConditionNode<Leaf>;
  leaf: LeafEditor<Leaf>;
  onChange: (next: ConditionNode<Leaf>) => void;
}) {
  if (isConditionGroup(root)) {
    return (
      <GroupBox
        root={root}
        path={[]}
        node={root}
        leaf={leaf}
        onChange={onChange}
      />
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {leaf.render(root, (next) => onChange(next))}
      <AddButtons
        onAddCondition={() => onChange(group("and", [root, leaf.fresh()]))}
        onAddGroup={() =>
          onChange(group("and", [root, group("and", [leaf.fresh()])]))
        }
      />
    </div>
  );
}

/**
 * One group and everything under it.
 *
 * Carries the whole tree plus its own path rather than just its own subtree,
 * because every edit it makes is a rewrite of the root: there is no way to hand
 * a nested group a setter for itself without threading one through every level
 * above it, and the path already says everything such a setter would know.
 */
function GroupBox<Leaf extends object>({
  root,
  path,
  node,
  leaf,
  onChange,
}: {
  root: ConditionNode<Leaf>;
  path: ConditionPath;
  node: ConditionGroup<Leaf>;
  leaf: LeafEditor<Leaf>;
  onChange: (next: ConditionNode<Leaf>) => void;
}) {
  const set = (next: ConditionGroup<Leaf>) =>
    onChange(replaceAt(root, path, next));

  // A tree of one leaf has nothing to delete down to: a condition with no
  // question has nothing to answer, so the button is simply not offered rather
  // than offered and refused.
  const prune = (at: ConditionPath) => {
    const next = removeAt(root, at);
    if (next !== null) onChange(next);
  };

  return (
    <div className="flex flex-col gap-1 border-2 border-border p-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={node.combinator}
          onChange={(combinator: Combinator) => set({ ...node, combinator })}
          options={[
            { value: "and" as Combinator, label: "All" },
            { value: "or" as Combinator, label: "Any" },
          ]}
          size="sm"
          ariaLabel="Combinator"
        />
        <label className="flex items-center gap-1 text-[10px] uppercase text-muted">
          <Switch
            checked={Boolean(node.not)}
            onCheckedChange={(not) => {
              const { not: _drop, ...rest } = node;
              set(not ? { ...rest, not } : rest);
            }}
            ariaLabel="Invert group"
          />
          not
        </label>
        <AddButtons
          onAddCondition={() => onChange(appendTo(root, path, leaf.fresh()))}
          onAddGroup={() =>
            onChange(appendTo(root, path, group("and", [leaf.fresh()])))
          }
        />
        {path.length > 0 ? (
          <Button
            size="sm"
            variant="danger"
            onClick={() => prune(path)}
            aria-label="Remove group"
          >
            ✕
          </Button>
        ) : null}
      </div>
      {node.rules.map((rule, i) => {
        const at = [...path, i];
        return (
          <div key={i} className="flex flex-wrap items-center gap-2 pl-3">
            {isConditionGroup(rule) ? (
              <GroupBox
                root={root}
                path={at}
                node={rule}
                leaf={leaf}
                onChange={onChange}
              />
            ) : (
              <>
                {leaf.render(rule, (next) =>
                  onChange(replaceAt(root, at, next)),
                )}
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => prune(at)}
                  aria-label="Remove condition"
                >
                  ✕
                </Button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AddButtons({
  onAddCondition,
  onAddGroup,
}: {
  onAddCondition: () => void;
  onAddGroup: () => void;
}) {
  return (
    <>
      <Button size="sm" variant="secondary" onClick={onAddCondition}>
        + condition
      </Button>
      <Button size="sm" variant="secondary" onClick={onAddGroup}>
        + group
      </Button>
    </>
  );
}
