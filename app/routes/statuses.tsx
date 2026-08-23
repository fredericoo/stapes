import { useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import type { Route } from "./+types/statuses";
import { AppShell } from "../components/AppShell";
import { StatusEditorDialog } from "../components/StatusEditorDialog";
import { SpritePreview } from "../components/TilePreview";
import { fetchStatuses, fetchTilesets, saveStatuses } from "../lib/api";
import { TITLE_SPRITE_SIZE_PX } from "../components/ContainerPanel";
import {
  completeSprite,
  DEFAULT_STATUS_SOURCE,
  resolveStatus,
  type StatusSource,
} from "../lib/status";
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

export async function clientLoader() {
  const [statuses, tilesets] = await Promise.all([
    fetchStatuses(),
    fetchTilesets(),
  ]);
  return { statuses: statuses as StatusSource[], tilesets };
}

export async function clientAction({ request }: Route.ClientActionArgs) {
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
    const statuses = (await fetchStatuses()) as StatusSource[];
    const idx = statuses.findIndex((s) => s.id === status.id);
    if (idx >= 0) statuses[idx] = status;
    else statuses.push(status);
    await saveStatuses(statuses);
    return { ok: true, intent };
  }

  if (intent === "delete-status") {
    const id = String(form.get("id") ?? "");
    const statuses = (await fetchStatuses()) as StatusSource[];
    await saveStatuses(statuses.filter((s) => s.id !== id));
    return { ok: true, intent };
  }

  return { ok: false, error: "Unknown intent" };
}

export default function StatusesPage() {
  const { statuses, tilesets } = useLoaderData<typeof clientLoader>();
  const fetcher = useFetcher<typeof clientAction>();
  const toast = useToast();
  const [editing, setEditing] = useState<StatusSource | null>(null);

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
                  <SpritePreview
                    sprite={completeSprite(status.icon)}
                    tilesets={tilesets}
                    size={TITLE_SPRITE_SIZE_PX}
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
          tilesets={tilesets}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      ) : null}
    </AppShell>
  );
}
