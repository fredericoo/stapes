import { ANY_STATE, fromStates, isSelector, type BrainDef } from "../lib/brain";
import { ACTIONS, CONDITIONS, EFFECTS, type ParamSpec } from "../lib/brainCatalog";
import { isConditionGroup } from "../lib/conditions";
import { isArgRef, type AuthoredCondition } from "../lib/traits";

export function describeSelector(selector: unknown): string {
  if (isArgRef(selector)) return selector.arg;
  if (!isSelector(selector)) return "?";
  switch (selector.type) {
    case "nearest":
      return `nearest ${tileList(selector.data.tileIds)}`;
    case "thing":
      return `nearest ${tileList(selector.data.tileIds)} lying about`;
    case "slot":
      return `$${selector.data.name}`;
    default:
      return selector.type;
  }
}

function tileList(tileIds: unknown): string {
  if (isArgRef(tileIds)) return tileIds.arg;
  return Array.isArray(tileIds) ? tileIds.join(", ") : "?";
}

function describeValue(spec: ParamSpec, value: unknown): string | null {
  if (value === undefined) return null;
  if (isArgRef(value)) return `${spec.label} ${value.arg}`;
  switch (spec.kind) {
    case "selector":
    case "aim":
    case "ground":
      return describeSelector(value);
    case "speaker": {
      const filter = value as { match: "is" | "not"; of: unknown };
      return `${filter.match === "not" ? "not " : ""}${describeSelector(filter.of)}`;
    }
    case "boolean":
      return value === true ? spec.label : null;
    case "text":
      return JSON.stringify(value);
    default:
      return `${spec.label} ${String(value)}`;
  }
}

function describeVerb(
  registry: Record<string, { label: string; params: ParamSpec[] }>,
  key: unknown,
  item: Record<string, unknown>,
): string {
  const entry = typeof key === "string" && Object.hasOwn(registry, key) ? registry[key] : undefined;
  if (!entry) return String(key);
  const parts = entry.params
    .map((spec) => describeValue(spec, item[spec.key]))
    .filter((part): part is string => part !== null);
  return parts.length > 0 ? `${entry.label}(${parts.join(", ")})` : entry.label;
}

export function describeCondition(node: AuthoredCondition): string {
  if (isArgRef(node)) return node.arg;
  if (isConditionGroup(node)) {
    const inner = node.rules.map(describeCondition).join("; ");
    return `${node.not ? "not " : ""}${node.combinator === "and" ? "all" : "any"}(${inner})`;
  }
  return describeVerb(CONDITIONS, node.cond, node as unknown as Record<string, unknown>);
}

export function describeActions(actions: unknown): string {
  if (isArgRef(actions)) return actions.arg;
  if (!Array.isArray(actions)) return "?";
  return actions
    .map((action: Record<string, unknown>) => describeVerb(ACTIONS, action.action, action))
    .join("; ");
}

export function describeEffects(effects: unknown): string {
  if (!Array.isArray(effects)) return "";
  return effects
    .map((effect: Record<string, unknown>) => describeVerb(EFFECTS, effect.effect, effect))
    .join("; ");
}

export function describeFrom(from: BrainDef["transitions"][number]["from"]): string {
  return from === ANY_STATE ? "any state" : fromStates(from).join(", ");
}
