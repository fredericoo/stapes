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
import { parseMapDoc, type MapDoc } from "../../editor/compose/doc";
import type { Placement } from "../../editor/compose/layout";
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

export default function ComposePage() {
  const { tiles, tilesets } = useLoaderData<typeof clientLoader>();
  const tilesById = useMemo(() => tilesByIdFromList(tiles), [tiles]);
  const [doc] = useState(demoDoc);
  const [view, setView] = useState(() => viewOf(doc));
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(() => branchKeys(doc.root));
  const built = useMemo(() => buildMap(doc, tilesById, COMPONENTS), [doc, tilesById]);
  const problemKeys = useMemo(() => new Set(built.problems.map((p) => p.key)), [built]);
  const placement = selected ? built.layout.placements.get(selected) : undefined;

  return (
    <AdminShell>
      <div className="grid h-full min-h-0 grid-cols-[16rem_1fr]">
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
            overlay={(projection) =>
              placement ? <Outline placement={placement} projection={projection} /> : null
            }
          />
        </div>
      </div>
    </AdminShell>
  );
}
