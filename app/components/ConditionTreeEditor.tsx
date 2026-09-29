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

export type LeafEditor<Leaf extends object> = {
  render: (leaf: Leaf, onChange: (next: Leaf) => void) => ReactNode;
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
    return <GroupBox root={root} path={[]} node={root} leaf={leaf} onChange={onChange} />;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {leaf.render(root, (next) => onChange(next))}
      <AddButtons
        onAddCondition={() => onChange(group("and", [root, leaf.fresh()]))}
        onAddGroup={() => onChange(group("and", [root, group("and", [leaf.fresh()])]))}
      />
    </div>
  );
}

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
  const set = (next: ConditionGroup<Leaf>) => onChange(replaceAt(root, path, next));

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
          onAddGroup={() => onChange(appendTo(root, path, group("and", [leaf.fresh()])))}
        />
        {path.length > 0 ? (
          <Button size="sm" variant="danger" onClick={() => prune(path)} aria-label="Remove group">
            ✕
          </Button>
        ) : null}
      </div>
      {node.rules.map((rule, i) => {
        const at = [...path, i];
        return (
          <div key={i} className="flex flex-wrap items-center gap-2 pl-3">
            {isConditionGroup(rule) ? (
              <GroupBox root={root} path={at} node={rule} leaf={leaf} onChange={onChange} />
            ) : (
              <>
                {leaf.render(rule, (next) => onChange(replaceAt(root, at, next)))}
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
