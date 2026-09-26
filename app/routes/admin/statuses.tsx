import { useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import type { Route } from "./+types/statuses";
import { AdminShell } from "../../components/AppShell";
import { StatusEditorDialog } from "../../components/StatusEditorDialog";
import { SpritePreview } from "../../components/TilePreview";
import { fetchStatuses, fetchTiles, fetchTilesets, saveStatuses } from "../../lib/api";
import { requireAdmin } from "../../lib/auth";
import { TITLE_SPRITE_SIZE_PX } from "../../components/ContainerPanel";
import {
  completeSprite,
  DEFAULT_STATUS_SOURCE,
  resolveStatus,
  type StatusSource,
} from "../../lib/status";
import { Button, useToast } from "../../ui";

export async function clientLoader() {
  await requireAdmin();
  const [statuses, tilesets, tiles] = await Promise.all([
    fetchStatuses(),
    fetchTilesets(),
    fetchTiles(),
  ]);
  return { statuses: statuses as StatusSource[], tilesets, tiles };
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "save-status") {
    const raw = String(form.get("status") ?? "");
    const status = JSON.parse(raw) as StatusSource;
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
  const { statuses, tilesets, tiles } = useLoaderData<typeof clientLoader>();
  const fetcher = useFetcher<typeof clientAction>();
  const toast = useToast();
  const [editing, setEditing] = useState<StatusSource | null>(null);

  const save = (status: StatusSource) => {
    fetcher.submit({ intent: "save-status", status: JSON.stringify(status) }, { method: "post" });
    setEditing(null);
    toast.show(`Saved ${status.name || status.id}`);
  };

  const remove = (id: string) => {
    fetcher.submit({ intent: "delete-status", id }, { method: "post" });
    toast.show(`Deleted ${id}`);
  };

  return (
    <AdminShell>
      <div className="flex flex-col gap-3 p-3">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-bold uppercase tracking-wide">Statuses</h1>
          <Button className="ml-auto" onClick={() => setEditing({ ...DEFAULT_STATUS_SOURCE })}>
            New status
          </Button>
        </div>

        {statuses.length === 0 ? (
          <p className="text-xs text-muted">
            Nothing authored yet. A status is what a consumable hands over — start with the thing
            you want a berry to do.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {statuses.map((status) => {
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
                      <span className="ml-1 font-normal text-muted">{status.id}</span>
                    </span>
                    <span className="truncate text-[11px] text-muted">{status.description}</span>
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
    </AdminShell>
  );
}
