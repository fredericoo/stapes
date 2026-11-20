import * as v from "valibot";
import { emptyMap, getStack, setStacks } from "../../lib/mapData";
import type { ChunkCells, MapFile, PlacedTile, TileDef } from "../../lib/types";
import type { Bounds, GeneratedPlan } from "../generator";
import type { Frame, MapDoc, MapNode, Point } from "./doc";
import { wrongTile } from "./field";
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

/** What a node of this type starts as when the editor adds one. */
export type Starter = { frame?: Frame; props?: Record<string, unknown> };

export type Component<Props> = {
  readonly type: string;
  readonly label: string;
  readonly starter: Starter;
  readonly schema: v.GenericSchema<unknown, Props>;
  build(ctx: BuildContext, props: Props): GeneratedPlan;
};

export type ComponentRegistry = Record<string, Component<never>>;

export type BuildProblem = { key: string; reason: string };

type Step = {
  key: string;
  inputs: string;
  map: MapFile;
  problems: BuildProblem[];
  written: Bounds | null;
};

export type BuildResult = {
  map: MapFile;
  layout: Layout;
  problems: BuildProblem[];
  /** The cells each node wrote, as a box, for nodes that wrote any. */
  written: ReadonlyMap<string, Bounds>;
  /** How many nodes were reused from the previous build rather than built again. */
  reused: number;
  readonly steps: readonly Step[];
  readonly from: { base: MapFile; tilesById: object; components: object };
};

const EMPTY = emptyMap();

function inside(b: Bounds, x: number, y: number): boolean {
  return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
}

function boundsOf(edits: readonly { x: number; y: number }[]): Bounds | null {
  if (edits.length === 0) return null;
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const { x, y } of edits) {
    b.minX = Math.min(b.minX, x);
    b.minY = Math.min(b.minY, y);
    b.maxX = Math.max(b.maxX, x);
    b.maxY = Math.max(b.maxY, y);
  }
  return b;
}

function namedFrames(value: unknown, layout: Layout, into: Record<string, unknown>) {
  if (Array.isArray(value)) for (const item of value) namedFrames(item, layout, into);
  else if (value && typeof value === "object") {
    const named = (value as { in?: unknown }).in;
    if (typeof named === "string") into[named] = layout.placements.get(named)?.bounds ?? null;
    for (const item of Object.values(value)) namedFrames(item, layout, into);
  }
}

/**
 * Everything a node's output depends on besides the map the nodes before it
 * left: its component, props, seed, frame, clip and level, and the frame of
 * every node a point in its props is measured in.
 */
function inputsOf(placement: Placement, layout: Layout): string {
  const named: Record<string, unknown> = {};
  namedFrames(placement.node.props, layout, named);
  const { node, seed, bounds, clip, z } = placement;
  return JSON.stringify([node.type, node.props ?? null, seed, bounds, clip, z, named]);
}

function sameStack(a: readonly PlacedTile[] | undefined, b: readonly PlacedTile[] | undefined) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((p, i) => p === b[i] || JSON.stringify(p) === JSON.stringify(b[i]));
}

function sameChunk(a: ChunkCells, b: ChunkCells): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => sameStack(a[k], b[k]));
}

/**
 * Puts the previous build's chunk object back wherever a rebuilt chunk holds
 * the same cells. The renderer re-meshes a chunk whenever its object changes,
 * so without this a node rebuilt over unchanged ground re-meshes every chunk
 * it covers. Only chunks that are not already the same object are compared.
 */
function keepUnchanged(previous: MapFile, next: MapFile): MapFile {
  let levels: MapFile["levels"] | null = null;
  for (const [zk, level] of Object.entries(next.levels)) {
    const before = previous.levels[zk];
    if (!before || before === level) continue;
    let kept: Record<string, ChunkCells> | null = null;
    for (const [ck, chunk] of Object.entries(level)) {
      const old = before[ck];
      if (!old || old === chunk || !sameChunk(old, chunk)) continue;
      kept ??= { ...level };
      kept[ck] = old;
    }
    if (kept) {
      levels ??= { ...next.levels };
      levels[zk] = kept;
    }
  }
  return levels ? { ...next, levels } : next;
}

function visibleOrder(doc: MapDoc, layout: Layout): Placement[] {
  const out: Placement[] = [];
  const visit = (node: MapNode) => {
    if (node.hidden) return;
    const placement = layout.placements.get(node.key);
    if (placement?.node !== node) return;
    out.push(placement);
    for (const child of node.children ?? []) visit(child);
  };
  visit(doc.root);
  return out;
}

/**
 * Builds the tree depth first: a node is built against the map every node
 * before it left, then its children are. A node that cannot be built writes
 * nothing and its children still run, so one refusal does not blank a town.
 * A hidden node is skipped with everything under it.
 *
 * Given the previous build, it starts again from the first node whose inputs
 * changed: every node before that one would build the same thing on the same
 * map, so its step is reused. Dragging a house re-runs the house and what
 * comes after it, never the island under it.
 */
export function buildMap(
  doc: MapDoc,
  tilesById: Record<string, TileDef>,
  components: ComponentRegistry,
  base: MapFile = EMPTY,
  previous?: BuildResult | null,
): BuildResult {
  const layout = layOut(doc);
  const usable =
    previous?.from.base === base &&
    previous.from.tilesById === tilesById &&
    previous.from.components === components
      ? previous.steps
      : [];
  const steps: Step[] = [];
  let map = base;
  let resuming = true;

  for (const placement of visibleOrder(doc, layout)) {
    const inputs = inputsOf(placement, layout);
    const prior = usable[steps.length];
    if (resuming && prior?.key === placement.node.key && prior.inputs === inputs) {
      steps.push(prior);
      map = prior.map;
      continue;
    }
    resuming = false;
    const problems: BuildProblem[] = [];
    let written: Bounds | null = null;
    const { node } = placement;
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
      } else if (wrongTile(component.schema, parsed.output as Record<string, unknown>, tilesById)) {
        problems.push({
          key: node.key,
          reason: wrongTile(component.schema, parsed.output as Record<string, unknown>, tilesById)!,
        });
      } else {
        const current = map;
        const plan = component.build(
          {
            map: current,
            tilesById,
            bounds: placement.bounds,
            z: placement.z,
            seed: placement.seed,
            stackAt: (x, y, z = placement.z) => getStack(current, x, y, z),
            point: (point) => {
              const frame = pointFrame(layout, placement, point);
              return frame ? pointIn(point, frame) : null;
            },
          },
          parsed.output as never,
        );
        if (!plan.ok) problems.push({ key: node.key, reason: plan.reason });
        else {
          const kept = plan.edits.filter((e) => inside(placement.clip, e.x, e.y));
          map = setStacks(map, kept);
          written = boundsOf(kept);
        }
      }
    }
    steps.push({ key: node.key, inputs, map, problems, written });
  }

  const reused = steps.filter((step, i) => step === usable[i]).length;
  const unchanged = previous && reused === steps.length && steps.length === usable.length;
  return {
    map: unchanged ? previous.map : previous ? keepUnchanged(previous.map, map) : map,
    layout,
    problems: [...layout.problems, ...steps.flatMap((s) => s.problems)],
    written: new Map(steps.flatMap((s) => (s.written ? [[s.key, s.written] as const] : []))),
    reused,
    steps,
    from: { base, tilesById, components },
  };
}
