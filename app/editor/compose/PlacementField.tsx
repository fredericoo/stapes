import { useContext, useId, useMemo, useState } from "react";
import { PlacementSettingsDialog } from "../../components/PlacementSettingsDialog";
import {
  holdsCount,
  isDepot,
  isGiveable,
  isGiver,
  isStowable,
  isWired,
  needsDestination,
} from "../../components/placementCapabilities";
import type { PlacedTile } from "../../lib/types";
import { tilesByIdFromList } from "../../lib/validation";
import { Button } from "../../ui";
import { placementWriter } from "./placementWriter";
import { TileCatalogue } from "./TilePicker";

/** Lists which settings a placement holds, so the form says what the dialog would show. */
function summary(settings: Record<string, unknown>): string {
  const set = Object.keys(settings).filter((k) => settings[k] !== undefined);
  return set.length ? set.join(", ") : "none";
}

export function PlacementField({
  tileId,
  value,
  onChange,
}: {
  tileId: string;
  value: Record<string, unknown>;
  onChange: (settings: Record<string, unknown>) => void;
}) {
  const { tiles, tilesets } = useContext(TileCatalogue);
  const tilesById = useMemo(() => tilesByIdFromList(tiles), [tiles]);
  const giveable = useMemo(() => tiles.filter(isGiveable), [tiles]);
  const stowable = useMemo(() => tiles.filter(isStowable), [tiles]);
  const channelListId = useId();
  const [editing, setEditing] = useState<ReturnType<typeof placementWriter> | null>(null);
  const def = tilesById[tileId];
  if (!def) return <span className="text-xs text-muted">Pick a tile first</span>;
  const placed = { ...value, tileId } as PlacedTile;
  return (
    <span className="flex min-w-0 flex-col items-start gap-1">
      <span className="text-xs text-muted">{summary(value)}</span>
      <Button size="sm" onClick={() => setEditing(placementWriter(placed))}>
        Placement settings…
      </Button>
      <datalist id={channelListId} />
      {editing ? (
        <PlacementSettingsDialog
          placed={placed}
          def={def}
          stackIndex={0}
          wired={isWired(def)}
          gives={isGiver(def)}
          stashes={isDepot(def)}
          teleports={needsDestination(def)}
          holds={holdsCount(def)}
          giveable={giveable}
          stowable={stowable}
          tilesById={tilesById}
          tilesets={tilesets}
          channelListId={channelListId}
          writer={editing.writer}
          onClose={() => {
            const { tileId: _tileId, direction: _direction, ...settings } = editing.read();
            setEditing(null);
            onChange(settings);
          }}
        />
      ) : null}
    </span>
  );
}
