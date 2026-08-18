import { useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import type { Route } from "./+types/statuses";
import { AppShell } from "../components/AppShell";
import { StatusEditorDialog } from "../components/StatusEditorDialog";
import { TilePreview } from "../components/TilePreview";
import { dataStore } from "../context";
import { TITLE_SPRITE_SIZE_PX } from "../components/ContainerPanel";
import {
  DEFAULT_STATUS_SOURCE,
  resolveStatus,
  type StatusSource,
} from "../lib/status";
import { tilesByIdFromList } from "../lib/validation";
import { Button, useToast } from "../ui";

/**
 * Authoring the status catalogue.
 *
 * A mirror of `/tiles` down to the shape of its action, because it is the same
 * job on a different blob: read the file, edit one entry, write the file back.
 *
 * The one thing it does that the tile editor does not is **show what a formula
 * is worth**. Nothing else in `data/` is a language, and a field where a typo
 * reads as "no effect" rather than as an error is one an author needs told
 * about — see `StatusEditorDialog`.
 */

export async function loader({ context }: Route.LoaderArgs) {
  const store = dataStore(context);
  const [statuses, tiles, tilesets] = await Promise.all([
    store.readStatuses(),
    store.readTiles(),
    store.readTilesets(),
  ]);
  return { statuses: statuses as StatusSource[], tiles, tilesets };
}

export async function action({ context, request }: Route.ActionArgs) {
  const store = dataStore(context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "save-status") {
    const raw = String(form.get("status") ?? "");
    const status = JSON.parse(raw) as StatusSource;
    // Refused here as well as in the dialog, because the dialog is not the only
    // way in: this is a form post, and a status that does not resolve would be
    // written to a file every world reads and then silently dropped from every
    // catalogue built from it.
    if (!resolveStatus(status)) {
      return { ok: false, error: "That is not a valid status" };
    }
    const statuses = (await store.readStatuses()) as StatusSource[];
    const idx = statuses.findIndex((s) => s.id === status.id);
    if (idx >= 0) statuses[idx] = status;
    else statuses.push(status);
    await store.writeStatuses(statuses);
    return { ok: true, intent };
  }

  if (intent === "delete-status") {
    const id = String(form.get("id") ?? "");
    const statuses = (await store.readStatuses()) as StatusSource[];
    await store.writeStatuses(statuses.filter((s) => s.id !== id));
    return { ok: true, intent };
  }

  return { ok: false, error: "Unknown intent" };
}

export default function StatusesPage() {
  const { statuses, tiles, tilesets } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const toast = useToast();
  const [editing, setEditing] = useState<StatusSource | null>(null);
  const tilesById = tilesByIdFromList(tiles);

  const save = (status: StatusSource) => {
    fetcher.submit(
      { intent: "save-status", status: JSON.stringify(status) },
      { method: "post" },
    );
    setEditing(null);
    toast.show(`Saved ${status.name || status.id}`);
  };

  const remove = (id: string) => {
    fetcher.submit({ intent: "delete-status", id }, { method: "post" });
    toast.show(`Deleted ${id}`);
  };

  return (
    <AppShell>
      <div className="flex flex-col gap-3 p-3">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-bold uppercase tracking-wide">Statuses</h1>
          <Button
            className="ml-auto"
            onClick={() => setEditing({ ...DEFAULT_STATUS_SOURCE })}
          >
            New status
          </Button>
        </div>

        {statuses.length === 0 ? (
          <p className="text-xs text-muted">
            Nothing authored yet. A status is what a consumable hands over —
            start with the thing you want a berry to do.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {statuses.map((status) => {
              // Resolved for the list rather than trusted, so an entry that has
              // stopped being a status says so where somebody can fix it — a
              // catalogue silently one shorter is the failure this avoids.
              const valid = resolveStatus(status) !== null;
              return (
                <li
                  key={status.id}
                  className="flex items-center gap-2 border-2 border-border bg-panel p-2"
                >
                  <TilePreview
                    tile={tilesById[status.iconTileId ?? ""] ?? null}
                    tilesets={tilesets}
                    size={TITLE_SPRITE_SIZE_PX}
                    direction="s"
                    still
                    chrome={false}
                    background={null}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="text-xs font-bold">
                      {status.name}
                      <span className="ml-1 font-normal text-muted">
                        {status.id}
                      </span>
                    </span>
                    <span className="truncate text-[11px] text-muted">
                      {status.description}
                    </span>
                  </span>
                  {valid ? null : (
                    <span className="shrink-0 border-2 border-danger px-1 text-[11px] text-danger">
                      malformed
                    </span>
                  )}
                  <Button className="ml-auto" onClick={() => setEditing(status)}>
                    Edit
                  </Button>
                  <Button onClick={() => remove(status.id)}>Delete</Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {editing ? (
        <StatusEditorDialog
          draft={editing}
          tiles={tiles}
          tilesets={tilesets}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      ) : null}
    </AppShell>
  );
}
