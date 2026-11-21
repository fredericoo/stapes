import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconBraces,
  IconCopy,
  IconFolder,
  IconHandStop,
  IconPointer,
  IconTrash,
} from "@tabler/icons-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useLoaderData } from "react-router";
import { AdminShell } from "../../components/AppShell";
import { buildMap, type BuildResult } from "../../editor/compose/build";
import { COMPONENTS } from "../../editor/compose/components";
import { DUNGEON_TYPE } from "../../editor/compose/components/dungeon";
import { ROOF_TYPE } from "../../editor/compose/components/house";
import { cutAbove } from "../../editor/compose/cutaway";
import {
  ComposeCanvas,
  type CanvasDrag,
  type CanvasFocus,
  type CanvasTool,
  type ComposeView,
  type PressKeys,
  type Projection,
} from "../../editor/compose/ComposeCanvas";
import demo from "../../editor/compose/demo.json";
import { parseMapDoc, type MapDoc, type Point } from "../../editor/compose/doc";
import {
  allKeys,
  duplicateNode,
  duplicateTo,
  findNode,
  findParent,
  starterNode,
  hitsLayer,
  insertNode,
  moveNode,
  pickLayer,
  removeNode,
  topmost,
  translateNodes,
  updateNode,
  wrapInGroup,
} from "../../editor/compose/edit";
import { fieldsOf } from "../../editor/compose/fields";
import { FrameHandles, InsertHandle, PointHandle } from "../../editor/compose/Handles";
import { Inspector, type PickCell } from "../../editor/compose/Inspector";
import { TileCatalogue } from "../../editor/compose/TilePicker";
import {
  frameFor,
  pointFor,
  pointFrame,
  pointIn,
  type Layout,
  type Placement,
} from "../../editor/compose/layout";
import { JsonDialog } from "../../editor/compose/JsonDialog";
import { LayersPanel, branchKeys } from "../../editor/compose/LayersPanel";
import { useDocHistory } from "../../editor/compose/useDocHistory";
import { findPlayers } from "../../game/player";
import { fetchBootstrap, saveMapText } from "../../lib/api";
import { changedChunks, serializeMap } from "../../lib/mapData";
import { requireAdmin } from "../../lib/auth";
import type { Bounds } from "../../editor/generator";
import { baseCellWorldOrigin } from "../../lib/geometry";
import { tilesByIdFromList } from "../../lib/validation";
import { Button, Dialog, ScrollArea, Select, Tooltip, useToast } from "../../ui";

export async function clientLoader() {
  await requireAdmin();
  return await fetchBootstrap();
}

function demoDoc(): MapDoc {
  const parsed = parseMapDoc(demo);
  if (!parsed.ok) throw new Error(`The demo map tree is not valid: ${parsed.reason}`);
  return parsed.doc;
}

function viewOf(doc: MapDoc): ComposeView {
  const frame = doc.root.frame ?? { x: 0, y: 0, w: 1, h: 1 };
  const centre = baseCellWorldOrigin(frame.x + frame.w / 2, frame.y + frame.h / 2, 0, 0);
  return { cx: centre.x, cy: centre.y, zoom: 1 };
}

function Outline({ bounds, z, projection }: { bounds: Bounds; z: number; projection: Projection }) {
  const a = projection.cellToScreen(bounds.minX, bounds.minY, z);
  const b = projection.cellToScreen(bounds.maxX + 1, bounds.maxY + 1, z);
  return (
    <div
      className="pointer-events-none absolute border-2 border-look shadow-[0_0_0_1px_var(--color-ink)]"
      style={{ left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y }}
    />
  );
}

/** A mask's shape, dashed, so an oval reads as an oval inside its square frame. */
function MaskOutline({ placement, projection }: { placement: Placement; projection: Projection }) {
  const { bounds, z } = placement;
  const a = projection.cellToScreen(bounds.minX, bounds.minY, z);
  const b = projection.cellToScreen(bounds.maxX + 1, bounds.maxY + 1, z);
  if (placement.node.props?.from) return null;
  const shape = (placement.node.props?.shape as string | undefined) ?? "oval";
  const op = (placement.node.props?.op as string | undefined) ?? "subtract";
  return (
    <div
      className={[
        "pointer-events-none absolute border-2 border-dashed",
        op === "subtract" ? "border-danger-on-ink" : "border-mend",
        shape === "oval" ? "mask-oval" : "",
      ].join(" ")}
      style={{ left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y }}
    />
  );
}

const NUDGE: Record<string, readonly [number, number] | undefined> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};
const NUDGE_FAR = 5;
/** Where arrow keys already mean something: typing, and the controls that step through their options with them. */
const NO_NUDGE =
  "input, textarea, select, [contenteditable], [role=dialog], [role=listbox], [role=menu], [role=combobox], [role=radiogroup], [role=slider]";

const TOOLS: ReadonlyArray<{
  tool: CanvasTool;
  label: string;
  hint: string;
  Icon: typeof IconPointer;
}> = [
  { tool: "select", label: "Select", hint: "Select and move layers (V)", Icon: IconPointer },
  { tool: "pan", label: "Pan", hint: "Drag the map (H, or hold Space)", Icon: IconHandStop },
];

type Props = Record<string, unknown>;

type PointHandleSpec = {
  key: string;
  glyph: string;
  title: string;
  point: Point;
  frame: Bounds;
  cell: { x: number; y: number };
  write: (props: Props, point: Point) => Props;
  remove?: (props: Props) => Props;
  /** Where a via point inserted just before this one goes in the via list, for a route's "+" handles. */
  insertAt?: { name: string; index: number };
};

/**
 * Every point a node's props hold, in schema order, so a route's `from`, its
 * `via` points and its `to` come out as the chain the route is drawn through.
 */
function pointsOf(layout: Layout, placement: Placement): PointHandleSpec[] {
  const component = COMPONENTS[placement.node.type];
  if (!component) return [];
  const props = placement.node.props ?? {};
  const entries = fieldsOf(component.schema);
  const routed = entries.some((e) => e.field.kind === "point");
  const via = routed ? entries.find((e) => e.field.kind === "points")?.name : undefined;
  const viaCount = via ? ((props[via] as Point[] | undefined) ?? []).length : 0;
  let pastVia = false;
  return entries.flatMap(({ name, field }): PointHandleSpec[] => {
    if (field.kind === "points") {
      pastVia = true;
      return ((props[name] as Point[] | undefined) ?? []).flatMap((point, i) => {
        const frame = pointFrame(layout, placement, point);
        if (!frame) return [];
        return [
          {
            key: `${name}.${i}`,
            glyph: !routed || name === via ? String(i + 1) : `${name.slice(0, 1)}${i + 1}`,
            title: `${name} ${i + 1} (double-click to remove)`,
            point,
            frame,
            cell: pointIn(point, frame),
            write: (p, next) => ({
              ...p,
              [name]: (p[name] as Point[]).map((q, j) => (j === i ? next : q)),
            }),
            remove: (p) => ({ ...p, [name]: (p[name] as Point[]).filter((_, j) => j !== i) }),
            ...(name === via ? { insertAt: { name, index: i } } : {}),
          },
        ];
      });
    }
    const point = props[name] as Point | undefined;
    if (field.kind !== "point" || !point) return [];
    const frame = pointFrame(layout, placement, point);
    if (!frame) return [];
    return [
      {
        key: name,
        glyph: name.slice(0, 1),
        title: name,
        point,
        frame,
        cell: pointIn(point, frame),
        write: (p, next) => ({ ...p, [name]: next }),
        ...(via && pastVia ? { insertAt: { name: via, index: viaCount } } : {}),
      },
    ];
  });
}

export default function ComposePage() {
  const { tiles, tilesets } = useLoaderData<typeof clientLoader>();
  const tilesById = useMemo(() => tilesByIdFromList(tiles), [tiles]);
  const { doc, commit, preview, settle, undo, redo, canUndo, canRedo } = useDocHistory(demoDoc);
  const [view, setView] = useState(() => viewOf(doc));
  const [jsonOpen, setJsonOpen] = useState(false);
  const [picking, setPicking] = useState<((cell: { x: number; y: number }) => void) | null>(null);
  const pickCell: PickCell = (apply) => setPicking(() => apply);
  const catalogue = useMemo(() => ({ tiles, tilesets }), [tiles, tilesets]);
  const [playOpen, setPlayOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const { show: showToast } = useToast();
  const [picked, setSelection] = useState<string[]>([]);
  const [focus, setFocus] = useState<CanvasFocus | null>(null);
  const [tool, setTool] = useState<CanvasTool>("select");
  const [spaceHeld, setSpaceHeld] = useState(false);
  const activeTool = spaceHeld ? "pan" : tool;
  const [expanded, setExpanded] = useState(() => branchKeys(doc.root));
  const lastBuild = useRef<BuildResult | null>(null);
  const { built, stats } = useMemo(() => {
    const previous = lastBuild.current;
    const started = performance.now();
    const result = buildMap(doc, tilesById, COMPONENTS, undefined, previous);
    const ms = performance.now() - started;
    lastBuild.current = result;
    return {
      built: result,
      stats: {
        ms,
        rebuilt: result.steps.length - result.reused,
        nodes: result.steps.length,
        chunks: previous ? changedChunks(previous.map, result.map).length : null,
      },
    };
  }, [doc, tilesById]);
  const problemKeys = useMemo(() => new Set(built.problems.map((p) => p.key)), [built]);
  const selection = useMemo(
    () => picked.filter((key) => built.layout.placements.has(key)),
    [picked, built],
  );
  const selected = selection.length === 1 ? selection[0]! : null;
  const placement = selected ? built.layout.placements.get(selected) : undefined;
  const selectedNode = selected ? findNode(doc.root, selected) : null;
  const movable = topmost(doc.root, selection).filter((key) => key !== doc.root.key);
  const footprints = useMemo(() => new Map(built.steps.map((s) => [s.key, s.footprint])), [built]);

  const spawns = useMemo(() => findPlayers(built.map).length, [built]);

  const play = async () => {
    setPlaying(true);
    try {
      const removed = await saveMapText(serializeMap(built.map));
      setPlayOpen(false);
      showToast(
        "The world now plays this map",
        removed.length
          ? `${removed.length} tiles did not fit and were left out. Open Play or Game to walk it.`
          : "Open Play or Game to walk it.",
        { untilDismissed: true },
      );
    } catch (err) {
      showToast("The world kept its map", err instanceof Error ? err.message : String(err), {
        untilDismissed: true,
      });
    } finally {
      setPlaying(false);
    }
  };

  const addNode = (type: string) => {
    const component = COMPONENTS[type];
    if (!component) return;
    const parent = selectedNode ?? doc.root;
    const node = starterNode(doc.root, type, component.starter);
    commit((d) => insertNode(d, parent.key, parent.children?.length ?? 0, node));
    setExpanded((keys) => (keys.includes(parent.key) ? keys : [...keys, parent.key]));
    setSelection([node.key]);
  };

  const deleteSelected = () => {
    if (!movable.length) return;
    commit((d) => movable.reduce(removeNode, d));
    setSelection([]);
  };

  const groupSelected = () => {
    if (!movable.length) return;
    const grouped = wrapInGroup(doc, movable);
    commit(grouped.doc);
    setExpanded((keys) => [...keys, grouped.key]);
    setSelection([grouped.key]);
  };

  /** Copies each node beside itself and returns the tree with which copy stands for which original. */
  const copiesOf = (keys: readonly string[]) => {
    let next = doc;
    const moves = keys.map((from) => {
      const copied = duplicateNode(next, from);
      next = copied.doc;
      return { from, to: copied.key };
    });
    return { doc: next, moves };
  };

  const duplicateSelected = () => {
    if (!movable.length) return;
    const copied = copiesOf(movable);
    commit(copied.doc);
    setSelection(copied.moves.map((m) => m.to));
  };

  const raisedAt = (x: number, y: number) => built.elevation.get(`${x},${y}`) ?? 0;
  /** The level a box is drawn on: its node's, plus however far the ground at its middle has been raised. */
  const levelOf = (p: Placement, bounds: Bounds = p.bounds) =>
    p.z +
    raisedAt(
      Math.floor((bounds.minX + bounds.maxX) / 2),
      Math.floor((bounds.minY + bounds.maxY) / 2),
    );

  /**
   * The selected layer when its parent builds it, as a house builds its
   * floors: the parent's placement and how many levels above the parent's
   * ground the part is. A floor, cellar or dungeon level cuts the view down
   * to its level.
   */
  const part = useMemo(() => {
    const parent = selectedNode ? findParent(doc.root, selectedNode.key) : null;
    if (!selectedNode || !parent) return null;
    if (!COMPONENTS[selectedNode.type]?.within?.includes(parent.type)) return null;
    const home = built.layout.placements.get(parent.key);
    const dug = parent.type === DUNGEON_TYPE;
    const level = COMPONENTS[parent.type]?.partLevels?.(parent).get(selectedNode.key);
    if (!home || level === undefined) return null;
    return { home, level, dug, cuts: selectedNode.type !== ROOF_TYPE };
  }, [doc, selectedNode, built]);
  /** A dungeon's levels count from its frame's level, not from the ground under it, which a hill may have raised. */
  const partLevel = part ? (part.dug ? part.home.z : levelOf(part.home)) + part.level : null;
  const shown = useMemo(
    () =>
      part?.cuts && partLevel !== null
        ? cutAbove(built.map, part.home.bounds, partLevel)
        : built.map,
    [built, part, partLevel],
  );
  /** How far above its placement's own level the selected layer is drawn. */
  const lift = part?.level ?? 0;

  /**
   * The box that shows where layers are: a frame where a layer has one, and
   * otherwise the cells it and the layers under it wrote, since a layer
   * without a frame has its parent's.
   */
  const focusOn = (keys: readonly string[]) => {
    const boxes = keys.flatMap((key) => {
      const p = built.layout.placements.get(key);
      if (!p) return [];
      if (p.node.frame) return [{ bounds: p.bounds, z: levelOf(p) }];
      if (COMPONENTS[p.node.type]?.within) return [{ bounds: p.bounds, z: levelOf(p) }];
      return allKeys(p.node).flatMap((k) => {
        const bounds = built.written.get(k);
        return bounds ? [{ bounds, z: levelOf(p, bounds) }] : [];
      });
    });
    if (boxes.length === 0) return;
    setFocus({
      z: boxes[0]!.z,
      bounds: {
        minX: Math.min(...boxes.map((b) => b.bounds.minX)),
        minY: Math.min(...boxes.map((b) => b.bounds.minY)),
        maxX: Math.max(...boxes.map((b) => b.bounds.maxX)),
        maxY: Math.max(...boxes.map((b) => b.bounds.maxY)),
      },
    });
  };

  const hits = (key: string, cell: { x: number; y: number }) => {
    const p = built.layout.placements.get(key);
    return p ? hitsLayer(p, footprints.get(key) ?? null, cell) : false;
  };

  const pickOnMap = (cell: { x: number; y: number }, keys: PressKeys) => {
    if (picking) {
      picking(cell);
      setPicking(null);
      return;
    }
    const key = pickLayer(doc.root, built, cell, selection);
    if (!keys.shift) setSelection(key ? [key] : []);
    else if (key) {
      setSelection(
        selection.includes(key) ? selection.filter((k) => k !== key) : [...selection, key],
      );
    }
  };

  /**
   * A drag that starts on a selected layer moves the selection, whatever is
   * drawn over it there; one that starts anywhere else selects the layer under
   * the pointer and moves that. The root is never moved this way: every drag
   * starts inside it, so it would take every drag. With Alt the originals
   * stay and their copies are what moves.
   */
  const dragOnMap = (cell: { x: number; y: number }, keys: PressKeys): CanvasDrag | null => {
    if (picking) return null;
    let moving = movable;
    if (!moving.some((key) => hits(key, cell))) {
      const under = pickLayer(doc.root, built, cell, selection);
      if (!under || under === doc.root.key) return null;
      moving = keys.shift ? topmost(doc.root, [...movable, under]) : [under];
    }
    const { layout } = built;
    let moves = moving.map((key) => ({ from: key, to: key }));
    if (keys.alt) {
      const copied = copiesOf(moving);
      moves = copied.moves;
      preview(() => copied.doc);
    }
    setSelection(moves.map((m) => m.to));
    return {
      move: (dx, dy) => preview((d) => translateNodes(d, layout, moves, dx, dy)),
      end: settle,
    };
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && picking) {
        setPicking(null);
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable], [role=dialog]")) return;
      if (e.key === "Escape") {
        setSelection([]);
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        setSpaceHeld(true);
        return;
      }
      if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "v" || e.key === "h")) {
        setTool(e.key === "v" ? "select" : "pan");
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        deleteSelected();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g") {
        e.preventDefault();
        groupSelected();
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    /** Releasing Space on a focused button would press it, so the release is swallowed while Space pans. */
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !spaceHeld) return;
      e.preventDefault();
      setSpaceHeld(false);
    };
    const onBlur = () => setSpaceHeld(false);
    /**
     * Arrows nudge the selection, a cell a press or `NUDGE_FAR` with Shift.
     * It listens in the capture phase and stops the event, because the layers
     * tree moves its highlight on the same keys and would do both; with
     * nothing selected the arrows are the tree's again.
     */
    const onArrow = (e: KeyboardEvent) => {
      const step = NUDGE[e.key];
      if (!step || !movable.length || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest(NO_NUDGE)) return;
      e.preventDefault();
      e.stopPropagation();
      const by = e.shiftKey ? NUDGE_FAR : 1;
      const { layout } = built;
      const moves = movable.map((key) => ({ from: key, to: key }));
      commit((d) => translateNodes(d, layout, moves, step[0] * by, step[1] * by));
    };
    window.addEventListener("keydown", onArrow, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onArrow, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  });

  return (
    <TileCatalogue.Provider value={catalogue}>
      <AdminShell
        trailing={
          <div className="flex items-center gap-1">
            <Tooltip content="Undo (⌘Z)">
              <Button
                size="icon"
                variant="ghost-inverse"
                aria-label="Undo"
                disabled={!canUndo}
                onClick={undo}
              >
                <IconArrowBackUp size={18} aria-hidden="true" />
              </Button>
            </Tooltip>
            <Tooltip content="Redo (⌘⇧Z)">
              <Button
                size="icon"
                variant="ghost-inverse"
                aria-label="Redo"
                disabled={!canRedo}
                onClick={redo}
              >
                <IconArrowForwardUp size={18} aria-hidden="true" />
              </Button>
            </Tooltip>
            <Tooltip content="The tree as JSON, to copy out or paste in">
              <Button
                size="icon"
                variant="ghost-inverse"
                aria-label="Edit as JSON"
                onClick={() => setJsonOpen(true)}
              >
                <IconBraces size={18} aria-hidden="true" />
              </Button>
            </Tooltip>
            <Button size="sm" variant="ghost-inverse" onClick={() => commit(demoDoc())}>
              Start from the demo
            </Button>
            <Button size="sm" variant="primary" onClick={() => setPlayOpen(true)}>
              Play this map
            </Button>
          </div>
        }
      >
        <div className="grid h-full min-h-0 grid-cols-[16rem_1fr_25rem]">
          <aside className="flex min-h-0 flex-col border-r-2 border-border bg-paper">
            <div className="flex items-center gap-1 border-b-2 border-border px-3 py-1.5">
              <h2 className="mr-auto text-xs font-bold uppercase tracking-wide">Layers</h2>
              <Tooltip content="Put the selected layers in a group (⌘G)">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Group layers"
                  disabled={!movable.length}
                  onClick={groupSelected}
                >
                  <IconFolder size={16} aria-hidden="true" />
                </Button>
              </Tooltip>
              <Tooltip content="Duplicate the selected layers">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Duplicate layers"
                  disabled={!movable.length}
                  onClick={duplicateSelected}
                >
                  <IconCopy size={16} aria-hidden="true" />
                </Button>
              </Tooltip>
              <Tooltip content="Delete the selected layers (Delete)">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Delete layers"
                  disabled={!movable.length}
                  onClick={deleteSelected}
                >
                  <IconTrash size={16} aria-hidden="true" />
                </Button>
              </Tooltip>
            </div>
            <div className="border-b-2 border-border px-3 py-2">
              <Select
                ariaLabel="Add a layer"
                className="w-full"
                placeholder={`Add inside ${selectedNode?.key ?? doc.root.key}…`}
                value={null}
                onValueChange={(type) => type && addNode(type)}
                options={Object.values(COMPONENTS)
                  .filter((c) => !c.within || c.within.includes((selectedNode ?? doc.root).type))
                  .map((c) => ({ value: c.type, label: c.label }))}
              />
            </div>
            <ScrollArea className="min-h-0 flex-1 p-2">
              <LayersPanel
                root={doc.root}
                components={COMPONENTS}
                selection={selection}
                onSelect={(keys) => {
                  setSelection(keys);
                  focusOn(keys);
                }}
                expanded={expanded}
                onExpandedChange={setExpanded}
                problems={problemKeys}
                onMove={(key, parent, index, copy) => {
                  if (!copy) {
                    commit((d) => moveNode(d, key, parent, index));
                    return;
                  }
                  const copied = duplicateTo(doc, key, parent, index);
                  commit(copied.doc);
                  setSelection([copied.key]);
                }}
                onHidden={(key, hidden) =>
                  commit((d) => updateNode(d, key, (n) => ({ ...n, hidden })))
                }
              />
            </ScrollArea>
          </aside>
          <div className="min-h-0">
            <ComposeCanvas
              map={shown}
              tilesById={tilesById}
              tilesets={tilesets}
              view={view}
              onViewChange={setView}
              lighting={false}
              tool={picking ? "select" : activeTool}
              focus={focus}
              raisedAt={raisedAt}
              pressLevel={picking ? partLevel : null}
              onPick={pickOnMap}
              onDrag={dragOnMap}
              overlay={(projection) => (
                <>
                  <div
                    role="toolbar"
                    aria-label="Tools"
                    className="absolute top-2 left-2 flex border-2 border-ink bg-paper shadow-hard"
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    {TOOLS.map(({ tool: t, label, hint, Icon }) => (
                      <Tooltip key={t} content={hint}>
                        <button
                          type="button"
                          aria-label={label}
                          aria-pressed={activeTool === t}
                          className={[
                            "p-1.5",
                            activeTool === t ? "bg-ink text-paper" : "hover:bg-panel",
                          ].join(" ")}
                          onClick={() => setTool(t)}
                        >
                          <Icon size={16} aria-hidden="true" />
                        </button>
                      </Tooltip>
                    ))}
                  </div>
                  {selection.length > 1
                    ? selection.map((key) => {
                        const p = built.layout.placements.get(key)!;
                        const bounds = p.node.frame ? p.bounds : built.written.get(key);
                        return bounds ? (
                          <Outline
                            key={key}
                            bounds={bounds}
                            z={levelOf(p, bounds)}
                            projection={projection}
                          />
                        ) : null;
                      })
                    : null}
                  <p className="pointer-events-none absolute bottom-2 left-2 bg-ink/80 px-2 py-1 text-xs tabular-nums text-paper">
                    Built in {stats.ms.toFixed(1)} ms · {stats.rebuilt} of {stats.nodes} layers
                    {stats.chunks === null
                      ? ""
                      : ` · ${stats.chunks} ${stats.chunks === 1 ? "chunk" : "chunks"} changed`}
                  </p>
                  {picking ? (
                    <p className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 border-2 border-ink bg-interact px-2 py-1 text-sm text-ink">
                      Click the map to place it · Esc to cancel
                    </p>
                  ) : null}
                  {placement && selectedNode ? (
                    <>
                      {[selectedNode, ...(selectedNode.children ?? [])]
                        .filter((n) => n.type === "mask" && !n.hidden)
                        .map((n) => {
                          const p = built.layout.placements.get(n.key);
                          return p ? (
                            <MaskOutline
                              key={`mask-${n.key}`}
                              placement={p}
                              projection={projection}
                            />
                          ) : null;
                        })}
                      {selectedNode.frame && activeTool === "select" ? (
                        <FrameHandles
                          bounds={placement.bounds}
                          z={levelOf(placement) + lift}
                          projection={projection}
                          onBounds={(bounds) =>
                            preview((d) =>
                              updateNode(d, placement.node.key, (n) => ({
                                ...n,
                                frame: frameFor(n.frame!, bounds, placement.parent),
                              })),
                            )
                          }
                          onEnd={settle}
                        />
                      ) : (
                        <Outline
                          bounds={placement.bounds}
                          z={levelOf(placement) + lift}
                          projection={projection}
                        />
                      )}
                      {(activeTool === "select" ? pointsOf(built.layout, placement) : []).map(
                        (spec, i, all) => {
                          const before = all[i - 1];
                          const insertAt = spec.insertAt;
                          return (
                            <Fragment key={spec.key}>
                              {before && insertAt ? (
                                <InsertHandle
                                  cell={{
                                    x: Math.round((before.cell.x + spec.cell.x) / 2),
                                    y: Math.round((before.cell.y + spec.cell.y) / 2),
                                  }}
                                  z={placement.z + raisedAt(spec.cell.x, spec.cell.y) + lift}
                                  projection={projection}
                                  onInsert={(cell) =>
                                    commit((d) =>
                                      updateNode(d, placement.node.key, (n) => {
                                        const list = [
                                          ...((n.props?.[insertAt.name] as Point[] | undefined) ??
                                            []),
                                        ];
                                        list.splice(
                                          insertAt.index,
                                          0,
                                          pointFor({ x: 0, y: 0 }, cell, placement.bounds),
                                        );
                                        return {
                                          ...n,
                                          props: { ...n.props, [insertAt.name]: list },
                                        };
                                      }),
                                    )
                                  }
                                />
                              ) : null}
                              <PointHandle
                                label={spec.glyph}
                                title={spec.title}
                                cell={spec.cell}
                                z={placement.z + raisedAt(spec.cell.x, spec.cell.y) + lift}
                                projection={projection}
                                onCell={(next) =>
                                  preview((d) =>
                                    updateNode(d, placement.node.key, (n) => ({
                                      ...n,
                                      props: spec.write(
                                        n.props ?? {},
                                        pointFor(spec.point, next, spec.frame),
                                      ),
                                    })),
                                  )
                                }
                                onEnd={settle}
                                onRemove={
                                  spec.remove
                                    ? () =>
                                        commit((d) =>
                                          updateNode(d, placement.node.key, (n) => ({
                                            ...n,
                                            props: spec.remove!(n.props ?? {}),
                                          })),
                                        )
                                    : undefined
                                }
                              />
                            </Fragment>
                          );
                        },
                      )}
                    </>
                  ) : null}
                </>
              )}
            />
          </div>
          <aside className="flex min-h-0 flex-col border-l-2 border-border bg-paper">
            <ScrollArea className="min-h-0 flex-1">
              {selectedNode ? (
                <Inspector
                  doc={doc}
                  node={selectedNode}
                  placement={placement}
                  built={built}
                  isRoot={selectedNode === doc.root}
                  components={COMPONENTS}
                  problems={built.problems.filter((p) => p.key === selected).map((p) => p.reason)}
                  onChange={commit}
                  onRenamed={(key) => setSelection([key])}
                  pickCell={pickCell}
                />
              ) : (
                <p className="p-3 text-sm text-muted">
                  {selection.length > 1
                    ? `${selection.length} layers selected. Drag one on the map to move them all, or select a single layer to edit it.`
                    : "Select a layer to edit it."}
                </p>
              )}
            </ScrollArea>
          </aside>
        </div>
        <Dialog
          open={playOpen}
          onOpenChange={setPlayOpen}
          title="Play this map"
          footer={
            <div className="flex w-full justify-end gap-2">
              <Button onClick={() => setPlayOpen(false)}>Keep the world's map</Button>
              <Button
                variant="danger"
                disabled={spawns !== 1 || playing}
                onClick={() => void play()}
              >
                Replace the world's map
              </Button>
            </div>
          }
        >
          <div className="flex flex-col gap-2 p-4 text-sm">
            <p>
              This replaces the map of the world this server runs with the one built here, for
              everybody on it. Players keep their positions, so anybody standing where the new map
              has sea is in the sea. The tree itself is not saved on the server.
            </p>
            {spawns !== 1 ? (
              <p className="text-danger">
                {spawns === 0
                  ? "The map has no spawn. Add a Tile layer holding the Player tile so new players have somewhere to start."
                  : `The map has ${spawns} Player tiles and a world takes exactly one.`}
              </p>
            ) : null}
            {built.problems.length ? (
              <p className="text-muted">
                {built.problems.length === 1
                  ? "1 layer could not be built and is left out."
                  : `${built.problems.length} layers could not be built and are left out.`}
              </p>
            ) : null}
          </div>
        </Dialog>
        <JsonDialog open={jsonOpen} onOpenChange={setJsonOpen} doc={doc} onApply={commit} />
      </AdminShell>
    </TileCatalogue.Provider>
  );
}
