import { IconArrowLeft } from "@tabler/icons-react";
import { Link, useLoaderData } from "react-router";
import { AdminShell } from "../../components/AppShell";
import { describeBlame } from "../../game/blame";
import { COMMAND_PREFIX, GOTO_COMMAND } from "../../game/commands";
import type { DeathCost } from "../../game/deathCost";
import { fetchPlayer } from "../../lib/api";
import { requireAdmin } from "../../lib/auth";
import { MASTERY_LABELS } from "../../lib/mastery";
import type { DeathRecord } from "../../../server/deaths";
import type { Route } from "./+types/player";

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  await requireAdmin();
  return await fetchPlayer(params.characterId);
}

export default function PlayerPage() {
  const { character, deaths } = useLoaderData<typeof clientLoader>();

  return (
    <AdminShell>
      <div className="flex max-w-3xl flex-col gap-3 p-3">
        <Link
          to="/admin/players"
          className="inline-flex items-center gap-1 self-start text-xs text-muted hover:text-ink"
        >
          <IconArrowLeft size={12} aria-hidden="true" />
          Players
        </Link>
        <h1 className="text-sm font-bold uppercase tracking-wide">{character.name}</h1>
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-bold uppercase text-muted">
            Deaths{deaths.length > 0 ? ` · ${deaths.length}` : ""}
          </h2>
          {deaths.length === 0 ? (
            <p className="text-sm text-muted">{character.name} has not died yet.</p>
          ) : (
            <ol className="flex flex-col border-2 border-border bg-paper shadow-hard">
              {deaths.map((death) => (
                <DeathRow key={death.id} death={death} />
              ))}
            </ol>
          )}
        </section>
      </div>
    </AdminShell>
  );
}

function DeathRow({ death }: { death: DeathRecord }) {
  const at = new Date(death.at);
  return (
    <li className="flex flex-col gap-1 border-b border-border/20 px-3 py-2 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className={`text-sm ${death.cause ? "text-ink" : "text-muted"}`}>
          {death.cause ? describeBlame(death.cause) : "No cause recorded"}
        </span>
        <time dateTime={at.toISOString()} className="text-xs text-muted">
          {at.toLocaleString()}
        </time>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted">
        <span>{costText(death.cost)}</span>
        {death.where ? (
          <code className="select-all text-ink">
            {`${COMMAND_PREFIX}${GOTO_COMMAND} ${death.where.x} ${death.where.y} ${death.where.z}`}
          </code>
        ) : null}
      </div>
    </li>
  );
}

function costText(cost: DeathCost): string {
  const parts = cost.levelsLost.map(
    (level) => `${MASTERY_LABELS[level.mastery]} ${level.from} → ${level.to}`,
  );
  if (cost.packLeft) parts.unshift("Pack left behind");
  return parts.length > 0 ? parts.join(" · ") : "Lost nothing";
}
