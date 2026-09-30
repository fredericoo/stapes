import { IconArrowLeft } from "@tabler/icons-react";
import type { ReactNode } from "react";
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
  const { character, deaths, kills } = useLoaderData<typeof clientLoader>();

  return (
    <AdminShell>
      <div className="flex max-w-3xl flex-col gap-4 p-3">
        <div className="flex flex-col gap-3">
          <Link
            to="/admin/players"
            className="inline-flex items-center gap-1 self-start text-xs text-muted hover:text-ink"
          >
            <IconArrowLeft size={12} aria-hidden="true" />
            Players
          </Link>
          <h1 className="text-sm font-bold uppercase tracking-wide">{character.name}</h1>
        </div>
        <Section title="Deaths" count={deaths.length} empty={`${character.name} has not died yet.`}>
          {deaths.map((death) => (
            <DeathRow key={death.id} death={death} />
          ))}
        </Section>
        <Section title="Kills" count={kills.length} empty={`${character.name} has not killed yet.`}>
          {kills.map((kill) => (
            <KillRow key={kill.id} kill={kill} />
          ))}
        </Section>
      </div>
    </AdminShell>
  );
}

function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-bold uppercase text-muted">
        {title}
        {count > 0 ? ` · ${count}` : ""}
      </h2>
      {count === 0 ? (
        <p className="text-sm text-muted">{empty}</p>
      ) : (
        <ol className="flex flex-col border-2 border-border bg-paper shadow-hard">{children}</ol>
      )}
    </section>
  );
}

function DeathRow({ death }: { death: DeathRecord }) {
  return (
    <Row
      record={death}
      title={
        death.cause ? (
          <Cause death={death} />
        ) : (
          <span className="text-muted">No cause recorded</span>
        )
      }
      detail={death.cost ? costText(death.cost) : null}
    />
  );
}

function Cause({ death }: { death: DeathRecord }) {
  const { cause, killer } = death;
  if (!cause) return null;
  if (!cause.by || !killer?.character) return <>{describeBlame(cause)}</>;
  return (
    <>
      {cause.source} by <CharacterLink id={killer.id}>{cause.by}</CharacterLink>
    </>
  );
}

function KillRow({ kill }: { kill: DeathRecord }) {
  const name = kill.victim.name ?? "Somebody unnamed";
  return (
    <Row
      record={kill}
      title={
        kill.victim.character ? <CharacterLink id={kill.victim.id}>{name}</CharacterLink> : name
      }
      detail={kill.cause ? `With ${kill.cause.source}` : null}
    />
  );
}

function Row({
  record,
  title,
  detail,
}: {
  record: DeathRecord;
  title: ReactNode;
  detail: string | null;
}) {
  const at = new Date(record.at);
  return (
    <li className="flex flex-col gap-1 border-b border-border/20 px-3 py-2 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm text-ink">{title}</span>
        <time dateTime={at.toISOString()} className="text-xs text-muted">
          {at.toLocaleString()}
        </time>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted">
        {detail ? <span>{detail}</span> : null}
        {record.where ? (
          <code className="select-all text-ink">
            {`${COMMAND_PREFIX}${GOTO_COMMAND} ${record.where.x} ${record.where.y} ${record.where.z}`}
          </code>
        ) : null}
      </div>
    </li>
  );
}

function CharacterLink({ id, children }: { id: string; children: ReactNode }) {
  return (
    <Link
      to={`/admin/players/${encodeURIComponent(id)}`}
      className="underline decoration-border/40 underline-offset-2 hover:decoration-ink"
    >
      {children}
    </Link>
  );
}

function costText(cost: DeathCost): string {
  const parts = cost.levelsLost.map(
    (level) => `${MASTERY_LABELS[level.mastery]} ${level.from} → ${level.to}`,
  );
  if (cost.packLeft) parts.unshift("Pack left behind");
  return parts.length > 0 ? parts.join(" · ") : "Lost nothing";
}
