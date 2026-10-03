import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import type { Route } from "./+types/traits";
import { AdminShell } from "../../components/AppShell";
import { traitContext } from "../../components/BrainEditor";
import { describeParam } from "../../components/brainText";
import { NEW_TRAIT, TraitEditorDialog } from "../../components/TraitEditorDialog";
import { fetchStatuses, fetchTiles, fetchTraits, saveTraits } from "../../lib/api";
import { requireAdmin } from "../../lib/auth";
import { statusesById } from "../../lib/status";
import {
  catalogueBreaks,
  checkTrait,
  resolveTrait,
  traitsById,
  usesTrait,
  type TraitIssue,
} from "../../lib/traits";
import { Button, useToast } from "../../ui";

export async function clientLoader() {
  await requireAdmin();
  const [traits, tiles, statuses] = await Promise.all([
    fetchTraits(),
    fetchTiles(),
    fetchStatuses(),
  ]);
  return { traits, tiles, statuses };
}

function idOf(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const id = (entry as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

function firstError(issues: readonly TraitIssue[]): string | null {
  return issues.find((issue) => issue.severity === "error")?.message ?? null;
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const [entries, tiles, statuses] = await Promise.all([
    fetchTraits(),
    fetchTiles(),
    fetchStatuses(),
  ]);
  const before = traitsById(entries);

  if (intent === "save-trait") {
    let raw: unknown;
    try {
      raw = JSON.parse(String(form.get("trait") ?? ""));
    } catch {
      return { ok: false as const, intent, error: "Not saved. The trait is not valid JSON." };
    }
    const trait = resolveTrait(raw);
    if (!trait) {
      return { ok: false as const, intent, error: "Not saved. It is not a trait yet." };
    }
    const previous = String(form.get("previous") ?? "");
    if (trait.id !== previous && Object.hasOwn(before, trait.id)) {
      return {
        ok: false as const,
        intent,
        error: `Not saved. Another trait is already called ${trait.id}.`,
      };
    }
    const at = previous ? entries.findIndex((entry) => idOf(entry) === previous) : -1;
    const next = at >= 0 ? entries.map((entry, i) => (i === at ? raw : entry)) : [...entries, raw];
    const after = traitsById(next);
    const context = traitContext(tiles, statusesById(statuses));
    const problem =
      firstError(checkTrait(trait, after, context)) ??
      firstError(catalogueBreaks(tiles, before, after));
    if (problem) return { ok: false as const, intent, error: `Not saved. ${problem}` };
    await saveTraits(next);
    return { ok: true as const, intent, name: trait.name };
  }

  if (intent === "delete-trait") {
    const id = String(form.get("id") ?? "");
    const next = entries.filter((entry) => idOf(entry) !== id);
    const problem = firstError(catalogueBreaks(tiles, before, traitsById(next)));
    if (problem) return { ok: false as const, intent, error: `Not deleted. ${problem}` };
    await saveTraits(next);
    return { ok: true as const, intent, name: id };
  }

  return { ok: false as const, intent, error: "Unknown intent" };
}

type Editing = { draft: unknown; previous: string | null };

export default function TraitsPage() {
  const { traits, tiles, statuses } = useLoaderData<typeof clientLoader>();
  const fetcher = useFetcher<typeof clientAction>();
  const toast = useToast();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const catalogue = useMemo(() => traitsById(traits), [traits]);
  const context = useMemo(() => traitContext(tiles, statusesById(statuses)), [tiles, statuses]);
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;
  const handled = useRef<typeof result>(undefined);

  useEffect(() => {
    if (busy || !result || handled.current === result) return;
    handled.current = result;
    if (result.ok) {
      setEditing(null);
      toast.show(
        result.intent === "delete-trait" ? `Deleted ${result.name}` : `Saved ${result.name}`,
      );
    } else if (result.intent === "delete-trait") {
      toast.show(result.error);
    } else {
      setRefusal(result.error);
    }
  }, [busy, result, toast]);

  const open = (next: Editing) => {
    setRefusal(null);
    setEditing(next);
  };

  const save = (raw: unknown) => {
    fetcher.submit(
      { intent: "save-trait", trait: JSON.stringify(raw), previous: editing?.previous ?? "" },
      { method: "post" },
    );
  };

  const remove = (id: string) => {
    fetcher.submit({ intent: "delete-trait", id }, { method: "post" });
  };

  const rows = useMemo(
    () =>
      traits.map((entry, index) => {
        const def = resolveTrait(entry);
        const id = idOf(entry) ?? `#${index + 1}`;
        const users = def
          ? tiles.filter((tile) => usesTrait(tile.interactions?.brain, def.id, catalogue))
          : [];
        const callers = def
          ? Object.values(catalogue).filter(
              (other) => other.id !== def.id && usesTrait(other, def.id, catalogue),
            )
          : [];
        const problems = def
          ? checkTrait(def, catalogue, context).filter((one) => one.severity === "error").length
          : 1;
        return { entry, def, id, users, callers, problems };
      }),
    [traits, tiles, catalogue, context],
  );

  return (
    <AdminShell>
      <div className="flex flex-col gap-3 p-3">
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-bold uppercase tracking-wide">Traits</h1>
          <Button className="ml-auto" onClick={() => open({ draft: NEW_TRAIT, previous: null })}>
            New trait
          </Button>
        </div>

        {rows.length === 0 ? (
          <p className="text-xs text-muted">
            No traits yet. A trait is part of a brain that creatures share — sleeping at night,
            fighting back — written once and called with arguments.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {rows.map(({ entry, def, id, users, callers, problems }) => {
              const inUse = users.length > 0 || callers.length > 0;
              return (
                <li key={id} className="flex flex-col gap-1 border-2 border-border bg-panel p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-bold">
                      {def?.name ?? id}
                      <span className="ml-1 font-normal text-muted">{id}</span>
                    </span>
                    {problems > 0 ? (
                      <span className="shrink-0 border-2 border-danger px-1 text-[11px] text-danger">
                        {def
                          ? `${problems} ${problems === 1 ? "problem" : "problems"}`
                          : "malformed"}
                      </span>
                    ) : null}
                    <Button
                      className="ml-auto"
                      onClick={() => open({ draft: entry, previous: idOf(entry) })}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="danger"
                      disabled={inUse || busy}
                      title={inUse ? "Still called. Remove the calls first." : undefined}
                      onClick={() => remove(id)}
                    >
                      Delete
                    </Button>
                  </div>
                  {def ? (
                    <>
                      <code className="text-[11px]">
                        {Object.entries(def.params)
                          .map(([name, param]) => describeParam(name, param))
                          .join(", ") || "no arguments"}
                      </code>
                      {def.hint ? <p className="text-[11px] text-muted">{def.hint}</p> : null}
                      <p className="text-[11px] text-muted">
                        {users.length > 0
                          ? `Called by ${users.map((tile) => tile.name || tile.id).join(", ")}`
                          : "No creature calls it"}
                        {callers.length > 0
                          ? ` · inside ${callers.map((other) => other.name).join(", ")}`
                          : ""}
                      </p>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {editing ? (
        <TraitEditorDialog
          draft={editing.draft}
          previous={editing.previous}
          catalogue={catalogue}
          tiles={tiles}
          context={context}
          error={refusal}
          saving={busy}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      ) : null}
    </AdminShell>
  );
}
