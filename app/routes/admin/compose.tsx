import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconBraces,
  IconCopy,
  IconFolder,
  IconTrash,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLoaderData } from "react-router";
import { AdminShell } from "../../components/AppShell";
import { buildMap, type BuildResult } from "../../editor/compose/build";
import { COMPONENTS } from "../../editor/compose/components";
import {
  ComposeCanvas,
  type ComposeView,
  type Projection,
} from "../../editor/compose/ComposeCanvas";
import demo from "../../editor/compose/demo.json";
import { parseMapDoc, type MapDoc, type Point } from "../../editor/compose/doc";
import {
  duplicateNode,
  findNode,
  findParent,
  freeKey,
  insertNode,
  moveNode,
  removeNode,
  updateNode,
  wrapInGroup,
} from "../../editor/compose/edit";
import { fieldsOf } from "../../editor/compose/fields";
import { FrameHandles, PointHandle } from "../../editor/compose/Handles";
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

function Outline({ placement, projection }: { placement: Placement; projection: Projection }) {
  const { bounds, z } = placement;
  const a = projection.cellToScreen(bounds.minX, bounds.minY, z);
  const b = projection.cellToScreen(bounds.maxX + 1, bounds.maxY + 1, z);
  return (
    <div
      className="pointer-events-none absolute border-2 border-look shadow-[0_0_0_1px_var(--color-ink)]"
      style={{ left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y }}
    />
  );
}

/** The node drawn on top at a cell: the last in build order whose own frame holds it. */
function pick(layout: Layout, cell: { x: number; y: number }): string | null {
  for (let i = layout.order.length - 1; i >= 0; i--) {
    const placement = layout.placements.get(layout.order[i]!)!;
    const { bounds } = placement;
    if (!placement.node.frame || placement.node.hidden) continue;
    if (cell.x < bounds.minX || cell.x > bounds.maxX) continue;
    if (cell.y < bounds.minY || cell.y > bounds.maxY) continue;
    return placement.node.key;
  }
  return null;
}

function pointsOf(layout: Layout, placement: Placement) {
  const component = COMPONENTS[placement.node.type];
  if (!component) return [];
  return fieldsOf(component.schema).flatMap(({ name, field }) => {
    const point = placement.node.props?.[name] as Point | undefined;
    if (field.kind !== "point" || !point) return [];
    const frame = pointFrame(layout, placement, point);
    return frame ? [{ name, point, frame, cell: pointIn(point, frame) }] : [];
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
  const [selected, setSelected] = useState<string | null>(null);
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
  const placement = selected ? built.layout.placements.get(selected) : undefined;
  const selectedNode = selected ? findNode(doc.root, selected) : null;

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
    const key = freeKey(doc.root, type);
    commit((d) =>
      insertNode(d, parent.key, parent.children?.length ?? 0, { type, key, ...component.starter }),
    );
    setExpanded((keys) => (keys.includes(parent.key) ? keys : [...keys, parent.key]));
    setSelected(key);
  };

  const deleteSelected = () => {
    if (!selected || selected === doc.root.key) return;
    const parent = findParent(doc.root, selected);
    commit((d) => removeNode(d, selected));
    setSelected(parent?.key ?? null);
  };

  const groupSelected = () => {
    if (!selected || selected === doc.root.key) return;
    const parent = findParent(doc.root, selected);
    const grouped = wrapInGroup(doc, selected);
    commit(grouped.doc);
    setExpanded((keys) => [...keys, grouped.key, ...(parent ? [parent.key] : [])]);
    setSelected(grouped.key);
  };

  const duplicateSelected = () => {
    if (!selected || selected === doc.root.key) return;
    const copied = duplicateNode(doc, selected);
    commit(copied.doc);
    setSelected(copied.key);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && picking) {
        setPicking(null);
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable], [role=dialog]")) return;
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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
              <Tooltip content="Put the selected layer in a group (⌘G)">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Group layer"
                  disabled={!selected || selected === doc.root.key}
                  onClick={groupSelected}
                >
                  <IconFolder size={16} aria-hidden="true" />
                </Button>
              </Tooltip>
              <Tooltip content="Duplicate the selected layer">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Duplicate layer"
                  disabled={!selected || selected === doc.root.key}
                  onClick={duplicateSelected}
                >
                  <IconCopy size={16} aria-hidden="true" />
                </Button>
              </Tooltip>
              <Tooltip content="Delete the selected layer (Delete)">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Delete layer"
                  disabled={!selected || selected === doc.root.key}
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
                options={Object.values(COMPONENTS).map((c) => ({ value: c.type, label: c.label }))}
              />
            </div>
            <ScrollArea className="min-h-0 flex-1 p-2">
              <LayersPanel
                root={doc.root}
                components={COMPONENTS}
                selected={selected}
                onSelect={setSelected}
                expanded={expanded}
                onExpandedChange={setExpanded}
                problems={problemKeys}
                onMove={(key, parent, index) => commit((d) => moveNode(d, key, parent, index))}
              />
            </ScrollArea>
          </aside>
          <div className="min-h-0">
            <ComposeCanvas
              map={built.map}
              tilesById={tilesById}
              tilesets={tilesets}
              view={view}
              onViewChange={setView}
              lighting={false}
              onPick={(cell) => {
                if (picking) {
                  picking(cell);
                  setPicking(null);
                } else setSelected(pick(built.layout, cell));
              }}
              overlay={(projection) => (
                <>
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
                      {selectedNode.frame ? (
                        <FrameHandles
                          bounds={placement.bounds}
                          z={placement.z}
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
                        <Outline placement={placement} projection={projection} />
                      )}
                      {pointsOf(built.layout, placement).map(({ name, point, cell, frame }) => (
                        <PointHandle
                          key={name}
                          label={name}
                          cell={cell}
                          z={placement.z}
                          projection={projection}
                          onCell={(next) =>
                            preview((d) =>
                              updateNode(d, placement.node.key, (n) => ({
                                ...n,
                                props: { ...n.props, [name]: pointFor(point, next, frame) },
                              })),
                            )
                          }
                          onEnd={settle}
                        />
                      ))}
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
                  onRenamed={setSelected}
                  pickCell={pickCell}
                />
              ) : (
                <p className="p-3 text-sm text-muted">Select a layer to edit it.</p>
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
