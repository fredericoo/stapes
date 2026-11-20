import { useMemo, useState } from "react";
import { useLoaderData } from "react-router";
import { AdminShell } from "../../components/AppShell";
import { buildMap } from "../../editor/compose/build";
import { COMPONENTS } from "../../editor/compose/components";
import { ComposeCanvas, type ComposeView } from "../../editor/compose/ComposeCanvas";
import demo from "../../editor/compose/demo.json";
import { parseMapDoc, type MapDoc } from "../../editor/compose/doc";
import { fetchBootstrap } from "../../lib/api";
import { requireAdmin } from "../../lib/auth";
import { baseCellWorldOrigin } from "../../lib/geometry";
import { tilesByIdFromList } from "../../lib/validation";

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

export default function ComposePage() {
  const { tiles, tilesets } = useLoaderData<typeof clientLoader>();
  const tilesById = useMemo(() => tilesByIdFromList(tiles), [tiles]);
  const [doc] = useState(demoDoc);
  const [view, setView] = useState(() => viewOf(doc));
  const built = useMemo(() => buildMap(doc, tilesById, COMPONENTS), [doc, tilesById]);

  return (
    <AdminShell>
      <div className="h-full min-h-0">
        <ComposeCanvas
          map={built.map}
          tilesById={tilesById}
          tilesets={tilesets}
          view={view}
          onViewChange={setView}
          lighting={false}
        />
      </div>
    </AdminShell>
  );
}
