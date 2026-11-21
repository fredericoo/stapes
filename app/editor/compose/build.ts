import * as v from "valibot";
import { emptyMap, getStack, setStacks, type StackEdit } from "../../lib/mapData";
import type { ChunkCells, MapFile, PlacedTile, TileDef } from "../../lib/types";
import type { Bounds, GeneratedPlan } from "../generator";
import type { Frame, MapDoc, MapNode, Point } from "./doc";
import {
  MASK_TYPE,
  applyMasks,
  footprintOf,
  keeps,
  mask,
  maskShape,
  type Footprint,
  type MaskProps,
  type MaskShape,
} from "./components/mask";
import { isWet } from "./components/line";
import { TILES, wrongTile } from "./field";
import { layOut, pointFrame, pointIn, type Layout, type Placement } from "./layout";

export type BuildContext = {
  readonly map: MapFile;
  readonly tilesById: Record<string, TileDef>;
  readonly bounds: Bounds;
  readonly z: number;
  readonly seed: number;
  stackAt(x: number, y: number, z?: number): PlacedTile[];
  /** How many levels the ground at x,y has been raised by the nodes built so far. */
  raisedAt(x: number, y: number): number;
  /** What a ramp up to the raised ground at x,y is made of, as the hill that raised it declared. */
  rampAt(x: number, y: number): RampStyle | undefined;
  /**
   * How the water at x,y is crossed, as the layer that put it there declared:
   * a bridge's style, `null` for water that is not to be bridged, and
   * `undefined` for water nothing declared, which gets the default bridge.
   */
  bridgeAt(x: number, y: number): BridgeStyle | null | undefined;
  point(point: Point): { x: number; y: number } | null;
  /** Whether the node's masks leave x,y in; true everywhere for a node with none. */
  covered(x: number, y: number): boolean;
  /** The node's visible children of the types its component lists in `parts`, in tree order, props validated. */
  readonly parts: readonly Part[];
};

/** A child its parent builds. `point` resolves one of the child's own points to a cell. */
export type Part = {
  readonly key: string;
  readonly type: string;
  readonly seed: number;
  readonly props: unknown;
  point(point: Point): { x: number; y: number } | null;
};

/** What a node of this type starts as when the editor adds one; the editor gives each child a key. */
export type Starter = {
  frame?: Frame;
  props?: Record<string, unknown>;
  children?: ReadonlyArray<{ type: string; props?: Record<string, unknown> }>;
};

export type Component<Props> = {
  readonly type: string;
  readonly label: string;
  readonly starter: Starter;
  readonly schema: v.GenericSchema<unknown, Props>;
  /**
   * Set by a component that cuts its own shape with `ctx.covered` and then
   * builds on what is left, like an island laying shallows round a hole a
   * mask cut in it. The build then applies only the masks that name tiles;
   * applying the shape masks again would take out what it built in the hole.
   */
  readonly shapesItself?: true;
  /**
   * Set by a component that works in the map's own levels. For every other
   * component the build hides raised ground: `ctx.stackAt` reads each cell
   * that many levels up and its edits are written that many levels up, so a
   * forest or a road laid after a hill lies on the hill without knowing it
   * is there. That only suits a layer whose cells are independent. One that
   * raises ground, or that has to stand on one level throughout like a
   * house, reads `ctx.raisedAt` and places itself.
   */
  readonly ownLevels?: true;
  /**
   * Child types this component builds itself. Such a child writes nothing of
   * its own: the parent reads it from `ctx.parts`, the way a layer reads its
   * masks, because the parts of a house only make sense planned together.
   */
  readonly parts?: readonly string[];
  /** The parent types this component is a part of. Anywhere else it is refused. */
  readonly within?: readonly string[];
  build(ctx: BuildContext, props: Props): ComponentPlan;
};

export type RampStyle = { slope: string; block: string; ground: string };

/** `arc` is how far the middle of the deck is lifted, in height units, stepping up one a cell from each bank. */
export type BridgeStyle = { deck: string; rail: string | null; arc: number };

/**
 * A plan, with what the component declares about the cells it built for the
 * components after it: ground it raised, by how many levels in all and with
 * which ramps, and water it laid and how that is to be crossed.
 */
export type ComponentPlan =
  | GeneratedPlan
  | {
      ok: true;
      edits: StackEdit[];
      raised?: {
        cells: ReadonlyArray<{ x: number; y: number; levels: number }>;
        ramp: RampStyle;
      };
      crossing?: { cells: ReadonlyArray<{ x: number; y: number }>; bridge: BridgeStyle | null };
      bare?: ReadonlyArray<{ x: number; y: number }>;
    };

export type Elevation = ReadonlyMap<string, number>;

/** What earlier nodes declared about cells, keyed `x,y`. Each map is replaced, never changed, so a step can keep the one it ended with. */
type Terrain = {
  elevation: Elevation;
  ramps: ReadonlyMap<string, RampStyle>;
  crossings: ReadonlyMap<string, BridgeStyle | null>;
};

const FLAT: Terrain = { elevation: new Map(), ramps: new Map(), crossings: new Map() };

export type ComponentRegistry = Record<string, Component<never>>;

export type BuildProblem = { key: string; reason: string };

type Step = {
  key: string;
  inputs: string;
  map: MapFile;
  problems: BuildProblem[];
  written: Bounds | null;
  footprint: Footprint | null;
  terrain: Terrain;
  /** Cells, keyed `x,y`, the node keeps its descendants' ground off. */
  bare: ReadonlySet<string> | null;
};

export type BuildResult = {
  map: MapFile;
  layout: Layout;
  problems: BuildProblem[];
  /** The cells each node wrote, as a box, for nodes that wrote any. */
  written: ReadonlyMap<string, Bounds>;
  /** How many nodes were reused from the previous build rather than built again. */
  reused: number;
  /** How many levels each raised cell stands above its node's own, keyed `x,y`. */
  elevation: Elevation;
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
 * left: its component, props, seed, frame, clip and level, the frame of every
 * node a point in its props is measured in, and its masks. A mask `from` a
 * layer needs nothing more, because that layer comes earlier, and any change
 * to it already stops the build reusing what follows.
 */
function inputsOf(placement: Placement, layout: Layout, parts: readonly MapNode[]): string {
  const named: Record<string, unknown> = {};
  namedFrames(placement.node.props, layout, named);
  const built = parts.map((part) => {
    namedFrames(part.props, layout, named);
    return [part.type, part.props ?? null, layout.placements.get(part.key)?.seed];
  });
  const { node, seed, bounds, clip, z } = placement;
  const masks = masksOf(node).map((m) => {
    const p = layout.placements.get(m.key);
    return [m.props ?? null, p?.seed, p?.bounds];
  });
  return JSON.stringify([
    node.type,
    node.props ?? null,
    seed,
    bounds,
    clip,
    z,
    named,
    masks,
    built,
  ]);
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

function masksOf(node: MapNode): MapNode[] {
  return (node.children ?? []).filter((c) => c.type === MASK_TYPE && !c.hidden);
}

/**
 * A mask `from` a layer reads what that layer wrote in this build, so the
 * layer has to come earlier in the tree; one that comes later is refused
 * rather than read as empty, which would quietly mask nothing.
 */
function shapesFor(
  node: MapNode,
  layout: Layout,
  built: ReadonlyMap<string, Step>,
  problems: BuildProblem[],
): MaskShape[] {
  return masksOf(node).flatMap((m) => {
    const placement = layout.placements.get(m.key);
    const parsed = v.safeParse(mask.schema, m.props ?? {});
    if (!placement || !parsed.success) return [];
    const props = parsed.output as MaskProps;
    if (props.from && !built.has(props.from)) {
      problems.push({
        key: m.key,
        reason: `${props.from} is not built before ${node.key}, so there is nothing of it to mask with`,
      });
      return [];
    }
    const footprint = props.from ? (built.get(props.from)?.footprint ?? null) : null;
    return [maskShape(props, placement.bounds, placement.seed, footprint)];
  });
}

type Visit = { placement: Placement; parent: MapNode | null; ancestors: readonly string[] };

function visibleOrder(doc: MapDoc, layout: Layout): Visit[] {
  const out: Visit[] = [];
  const visit = (node: MapNode, parent: MapNode | null, ancestors: readonly string[]) => {
    if (node.hidden) return;
    const placement = layout.placements.get(node.key);
    if (placement?.node !== node) return;
    out.push({ placement, parent, ancestors });
    const below = [...ancestors, node.key];
    for (const child of node.children ?? []) visit(child, node, below);
  };
  visit(doc.root, null, []);
  return out;
}

/**
 * Takes the flat ground a layer adds out of every edit on a cell an ancestor
 * keeps bare, the way `applyMasks` reads what a layer added. An edit that
 * leaves the cell wet is passed whole, so a river still reaches the sea
 * across a beach with its bed under it.
 */
function offBare(
  edits: readonly StackEdit[],
  bare: readonly ReadonlySet<string>[],
  stackAt: (x: number, y: number, z: number) => readonly PlacedTile[],
  tilesById: Record<string, TileDef>,
): StackEdit[] {
  if (bare.length === 0) return [...edits];
  const out: StackEdit[] = [];
  for (const edit of edits) {
    if (isWet(edit.stack) || !bare.some((cells) => cells.has(`${edit.x},${edit.y}`))) {
      out.push(edit);
      continue;
    }
    const before = stackAt(edit.x, edit.y, edit.z);
    let kept = 0;
    while (
      kept < edit.stack.length &&
      kept < before.length &&
      sameStack([edit.stack[kept]!], [before[kept]!])
    ) {
      kept++;
    }
    const stack = edit.stack.filter((p, i) => {
      const def = tilesById[p.tileId];
      return i < kept || !def || !TILES.ground.test(def);
    });
    if (stack.length === edit.stack.length) out.push(edit);
    else if (!sameStack(stack, before)) out.push({ ...edit, stack });
  }
  return out;
}

function partNodes(node: MapNode, component: Component<never> | undefined): MapNode[] {
  const types = component?.parts;
  if (!types) return [];
  return (node.children ?? []).filter((c) => types.includes(c.type) && !c.hidden);
}

function validProps(
  component: Component<never>,
  node: MapNode,
  tilesById: Record<string, TileDef>,
): { ok: true; props: unknown } | { ok: false; reason: string } {
  const parsed = v.safeParse(component.schema, node.props ?? {});
  if (!parsed.success) {
    const issue = parsed.issues[0];
    const path = issue.path?.map((item) => String(item.key)).join(".");
    return { ok: false, reason: path ? `${path}: ${issue.message}` : issue.message };
  }
  const wrong = wrongTile(component.schema, parsed.output as Record<string, unknown>, tilesById);
  return wrong ? { ok: false, reason: wrong } : { ok: true, props: parsed.output };
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
  const built = new Map<string, Step>();
  let map = base;
  let terrain = FLAT;
  let resuming = true;

  for (const { placement, parent, ancestors } of visibleOrder(doc, layout)) {
    const partsOfNode = partNodes(placement.node, components[placement.node.type]);
    const inputs = inputsOf(placement, layout, partsOfNode);
    const prior = usable[steps.length];
    if (resuming && prior?.key === placement.node.key && prior.inputs === inputs) {
      steps.push(prior);
      built.set(prior.key, prior);
      map = prior.map;
      terrain = prior.terrain;
      continue;
    }
    resuming = false;
    const problems: BuildProblem[] = [];
    let written: Bounds | null = null;
    let footprint: Footprint | null = null;
    let bare: ReadonlySet<string> | null = null;
    const { node } = placement;
    const shapes = shapesFor(node, layout, built, problems);
    const component = components[node.type];
    if (!component) {
      problems.push({ key: node.key, reason: `There is no component called ${node.type}` });
    } else if (component.within && !component.within.includes(parent?.type ?? "")) {
      const homes = component.within.map((type) => components[type]?.label ?? type).join(" or ");
      problems.push({
        key: node.key,
        reason: `A ${component.label.toLowerCase()} is part of a ${homes.toLowerCase()} and builds nothing anywhere else. Drag it into one.`,
      });
    } else {
      const valid = validProps(component, node, tilesById);
      if (!valid.ok) problems.push({ key: node.key, reason: valid.reason });
      else {
        const current = map;
        const known = terrain;
        const raisedAt = (x: number, y: number) => known.elevation.get(`${x},${y}`) ?? 0;
        const lift = component.ownLevels ? () => 0 : raisedAt;
        const stackAt = (x: number, y: number, z: number) =>
          getStack(current, x, y, z + lift(x, y));
        const plan = component.build(
          {
            map: current,
            tilesById,
            bounds: placement.bounds,
            z: placement.z,
            seed: placement.seed,
            stackAt: (x, y, z = placement.z) => stackAt(x, y, z),
            raisedAt,
            rampAt: (x, y) => known.ramps.get(`${x},${y}`),
            bridgeAt: (x, y) => known.crossings.get(`${x},${y}`),
            point: (point) => {
              const frame = pointFrame(layout, placement, point);
              return frame ? pointIn(point, frame) : null;
            },
            covered: (x, y) => keeps(shapes, x, y, ""),
            parts: partsOfNode.flatMap((part): Part[] => {
              const made = components[part.type];
              const at = layout.placements.get(part.key);
              const checked = made && at ? validProps(made, part, tilesById) : null;
              if (!checked?.ok || !at) return [];
              return [
                {
                  key: part.key,
                  type: part.type,
                  seed: at.seed,
                  props: checked.props,
                  point: (point) => {
                    const frame = pointFrame(layout, at, point);
                    return frame ? pointIn(point, frame) : null;
                  },
                },
              ];
            }),
          },
          valid.props as never,
        );
        if (!plan.ok) problems.push({ key: node.key, reason: plan.reason });
        else {
          const applied = component.shapesItself ? shapes.filter((s) => s.only) : shapes;
          const masked = applyMasks(plan.edits, applied, stackAt);
          const reserved =
            component.ownLevels || component.shapesItself
              ? []
              : ancestors.flatMap((key) => built.get(key)?.bare ?? []);
          const kept = offBare(masked, reserved, stackAt, tilesById)
            .filter((e) => inside(placement.clip, e.x, e.y))
            .map((e) => (lift(e.x, e.y) ? { ...e, z: e.z + lift(e.x, e.y) } : e));
          map = setStacks(map, kept);
          const within = <T extends { x: number; y: number }>(cells: readonly T[]) =>
            cells.filter((c) => inside(placement.clip, c.x, c.y));
          if ("raised" in plan && plan.raised) {
            const elevation = new Map(terrain.elevation);
            const ramps = new Map(terrain.ramps);
            for (const c of within(plan.raised.cells)) {
              elevation.set(`${c.x},${c.y}`, c.levels);
              ramps.set(`${c.x},${c.y}`, plan.raised.ramp);
            }
            terrain = { ...terrain, elevation, ramps };
          }
          if ("crossing" in plan && plan.crossing) {
            const crossings = new Map(terrain.crossings);
            for (const c of within(plan.crossing.cells)) {
              crossings.set(`${c.x},${c.y}`, plan.crossing.bridge);
            }
            terrain = { ...terrain, crossings };
          }
          if ("bare" in plan && plan.bare) {
            bare = new Set(within(plan.bare).map((c) => `${c.x},${c.y}`));
          }
          written = boundsOf(kept);
          footprint = footprintOf(kept);
        }
      }
    }
    const step = { key: node.key, inputs, map, problems, written, footprint, terrain, bare };
    steps.push(step);
    built.set(step.key, step);
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
    elevation: terrain.elevation,
    from: { base, tilesById, components },
  };
}
