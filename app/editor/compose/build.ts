import * as v from "valibot";
import { MapDraft, emptyMap, getStack, setStacks, type StackEdit } from "../../lib/mapData";
import type { MapFile, PlacedTile, TileDef } from "../../lib/types";
import type { Bounds, GeneratedPlan } from "../generator";
import type { MapDoc, MapNode, Point } from "./doc";
import { layOut, pointFrame, pointIn, type Layout, type Placement } from "./layout";

export type BuildContext = {
  readonly map: MapFile;
  readonly tilesById: Record<string, TileDef>;
  readonly bounds: Bounds;
  readonly z: number;
  readonly seed: number;
  stackAt(x: number, y: number, z?: number): PlacedTile[];
  point(point: Point): { x: number; y: number } | null;
};

export type Component<Props> = {
  readonly type: string;
  readonly label: string;
  readonly schema: v.GenericSchema<unknown, Props>;
  build(ctx: BuildContext, props: Props): GeneratedPlan;
};

export type ComponentRegistry = Record<string, Component<never>>;

export type BuildProblem = { key: string; reason: string };

export type BuildResult = {
  map: MapFile;
  layout: Layout;
  problems: BuildProblem[];
};

function inside(b: Bounds, x: number, y: number): boolean {
  return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
}

/**
 * Builds the tree depth first: a node is built against the map every node
 * before it left, then its children are. A node that cannot be built writes
 * nothing and its children still run, so one refusal does not blank a town.
 * A hidden node is skipped with everything under it.
 */
export function buildMap(
  doc: MapDoc,
  tilesById: Record<string, TileDef>,
  components: ComponentRegistry,
  base: MapFile = emptyMap(),
): BuildResult {
  const layout = layOut(doc);
  const problems: BuildProblem[] = [...layout.problems];
  const draft = new MapDraft();
  let map = base;

  const contextFor = (placement: Placement): BuildContext => ({
    get map() {
      return map;
    },
    tilesById,
    bounds: placement.bounds,
    z: placement.z,
    seed: placement.seed,
    stackAt: (x, y, z = placement.z) => getStack(map, x, y, z),
    point: (point) => {
      const frame = pointFrame(layout, placement, point);
      return frame ? pointIn(point, frame) : null;
    },
  });

  const visit = (node: MapNode) => {
    if (node.hidden) return;
    const placement = layout.placements.get(node.key);
    if (placement?.node !== node) return;
    const component = components[node.type];
    if (!component) {
      problems.push({ key: node.key, reason: `There is no component called ${node.type}` });
    } else {
      const parsed = v.safeParse(component.schema, node.props ?? {});
      if (!parsed.success) {
        const issue = parsed.issues[0];
        const path = issue.path?.map((item) => String(item.key)).join(".");
        problems.push({
          key: node.key,
          reason: path ? `${path}: ${issue.message}` : issue.message,
        });
      } else {
        const plan = component.build(contextFor(placement), parsed.output as never);
        if (!plan.ok) problems.push({ key: node.key, reason: plan.reason });
        else {
          const kept: StackEdit[] = plan.edits.filter((e) => inside(placement.clip, e.x, e.y));
          map = setStacks(map, kept, draft);
        }
      }
    }
    for (const child of node.children ?? []) visit(child);
  };

  visit(doc.root);
  draft.seal();
  return { map, layout, problems };
}
