import { SelectedStackList } from "../../components/SelectedStackList";
import { getStack } from "../../lib/mapData";
import { useEditorStore } from "../store";
import { useMapAssets } from "./MapAssetsContext";

export function SelectionPanel() {
  const { tilesets } = useMapAssets();
  const map = useEditorStore((s) => s.map);
  const selected = useEditorStore((s) => s.selected);
  const currentLevel = useEditorStore((s) => s.currentLevel);
  const tilesById = useEditorStore((s) => s.tilesById);

  const stack = selected
    ? getStack(map, selected.x, selected.y, currentLevel)
    : [];

  return (
    <div className="min-h-0 flex-1 overflow-auto p-2">
      {!selected ? (
        <p className="text-xs text-muted">
          Use Select (V) and click a coordinate.
        </p>
      ) : stack.length === 0 ? (
        <p className="text-xs text-muted">
          No tiles at {selected.x},{selected.y}
        </p>
      ) : (
        <SelectedStackList
          stack={stack}
          tilesById={tilesById}
          tilesets={tilesets}
        />
      )}
    </div>
  );
}

/** Tab labels render outside the panel, so the coordinate subscribes here. */
export function SelectionTabLabel() {
  const selected = useEditorStore((s) => s.selected);
  return <>{selected ? `Selected ${selected.x},${selected.y}` : "No selection"}</>;
}
