import { useMemo, useState } from "react";
import { useLoaderData } from "react-router";
import { AdminShell } from "../../components/AppShell";
import { buildMap } from "../../editor/compose/build";
import { COMPONENTS } from "../../editor/compose/components";
import {
  ComposeCanvas,
  type ComposeView,
  type Projection,
} from "../../editor/compose/ComposeCanvas";
import demo from "../../editor/compose/demo.json";
import { parseMapDoc, type MapDoc, type Point } from "../../editor/compose/doc";
import { findNode, updateNode } from "../../editor/compose/edit";
import { fieldsOf } from "../../editor/compose/fields";
import { FrameHandles, PointHandle } from "../../editor/compose/Handles";
import { Inspector, TILE_LIST_ID } from "../../editor/compose/Inspector";
import {
  frameFor,
  pointFor,
  pointFrame,
  pointIn,
  type Layout,
  type Placement,
} from "../../editor/compose/layout";
import { LayersPanel, branchKeys } from "../../editor/compose/LayersPanel";
import { fetchBootstrap } from "../../lib/api";
import { requireAdmin } from "../../lib/auth";
import { baseCellWorldOrigin } from "../../lib/geometry";
import { tilesByIdFromList } from "../../lib/validation";
import { ScrollArea } from "../../ui";

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
  const [doc, setDoc] = useState(demoDoc);
  const [view, setView] = useState(() => viewOf(doc));
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(() => branchKeys(doc.root));
  const built = useMemo(() => buildMap(doc, tilesById, COMPONENTS), [doc, tilesById]);
  const problemKeys = useMemo(() => new Set(built.problems.map((p) => p.key)), [built]);
  const placement = selected ? built.layout.placements.get(selected) : undefined;
  const selectedNode = selected ? findNode(doc.root, selected) : null;

  return (
    <AdminShell>
      <div className="grid h-full min-h-0 grid-cols-[16rem_1fr_25rem]">
        <aside className="flex min-h-0 flex-col border-r-2 border-border bg-paper">
          <h2 className="border-b-2 border-border px-3 py-2 text-xs font-bold uppercase tracking-wide">
            Layers
          </h2>
          <ScrollArea className="min-h-0 flex-1 p-2">
            <LayersPanel
              root={doc.root}
              components={COMPONENTS}
              selected={selected}
              onSelect={setSelected}
              expanded={expanded}
              onExpandedChange={setExpanded}
              problems={problemKeys}
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
            onPick={(cell) => setSelected(pick(built.layout, cell))}
            overlay={(projection) =>
              placement && selectedNode ? (
                <>
                  {selectedNode.frame ? (
                    <FrameHandles
                      bounds={placement.bounds}
                      z={placement.z}
                      projection={projection}
                      onBounds={(bounds) =>
                        setDoc((d) =>
                          updateNode(d, placement.node.key, (n) => ({
                            ...n,
                            frame: frameFor(n.frame!, bounds, placement.parent),
                          })),
                        )
                      }
                      onEnd={() => {}}
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
                        setDoc((d) =>
                          updateNode(d, placement.node.key, (n) => ({
                            ...n,
                            props: { ...n.props, [name]: pointFor(point, next, frame) },
                          })),
                        )
                      }
                      onEnd={() => {}}
                    />
                  ))}
                </>
              ) : null
            }
          />
        </div>
        <aside className="flex min-h-0 flex-col border-l-2 border-border bg-paper">
          <ScrollArea className="min-h-0 flex-1">
            {selectedNode ? (
              <Inspector
                doc={doc}
                node={selectedNode}
                placement={placement}
                isRoot={selectedNode === doc.root}
                components={COMPONENTS}
                problems={built.problems.filter((p) => p.key === selected).map((p) => p.reason)}
                onChange={setDoc}
                onRenamed={setSelected}
              />
            ) : (
              <p className="p-3 text-sm text-muted">Select a layer to edit it.</p>
            )}
          </ScrollArea>
        </aside>
      </div>
      <datalist id={TILE_LIST_ID}>
        {tiles.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </datalist>
    </AdminShell>
  );
}
