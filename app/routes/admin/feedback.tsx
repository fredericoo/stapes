import { useLoaderData } from "react-router";
import { AdminShell } from "../../components/AppShell";
import { fetchFeedback } from "../../lib/api";
import { requireAdmin } from "../../lib/auth";
import { COMMAND_PREFIX, GOTO_COMMAND } from "../../game/commands";
import type { FeedbackEntry } from "../../../server/feedback";

export async function clientLoader() {
  await requireAdmin();
  return { entries: await fetchFeedback() };
}

export default function FeedbackPage() {
  const { entries } = useLoaderData<typeof clientLoader>();

  return (
    <AdminShell>
      <div className="flex max-w-3xl flex-col gap-3 p-3">
        <h1 className="text-sm font-bold uppercase tracking-wide">Feedback</h1>
        {entries.length === 0 ? (
          <p className="text-sm text-muted">
            No feedback yet. Players send it from “Send feedback” in the game menu.
          </p>
        ) : (
          <ol className="flex flex-col gap-3">
            {entries.map((entry) => (
              <FeedbackCard key={entry.id} entry={entry} />
            ))}
          </ol>
        )}
      </div>
    </AdminShell>
  );
}

function FeedbackCard({ entry }: { entry: FeedbackEntry }) {
  const position = positionOf(entry.context);
  const author = entry.guest ? "Guest" : (entry.username ?? "Unknown account");

  return (
    <li className="flex flex-col gap-2 border-2 border-border bg-paper p-3 shadow-hard">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted">
        <time dateTime={new Date(entry.at).toISOString()}>
          {new Date(entry.at).toLocaleString()}
        </time>
        <span>
          {author}
          {entry.characterName ? ` as ${entry.characterName}` : ""}
        </span>
        {position ? (
          <code className="select-all text-ink">
            {`${COMMAND_PREFIX}${GOTO_COMMAND} ${position.x} ${position.y} ${position.z}`}
          </code>
        ) : null}
      </div>
      <p className="whitespace-pre-wrap text-sm text-ink">{entry.message}</p>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted">Browser and game details</summary>
        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
          {flatten(entry.context).map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-muted">{key}</dt>
              <dd className="break-all text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      </details>
    </li>
  );
}

function positionOf(context: Record<string, unknown>): { x: number; y: number; z: number } | null {
  const game = context.game as
    | { position?: { x: number; y: number; z: number } | null }
    | undefined;
  return game?.position ?? null;
}

function flatten(value: Record<string, unknown>, prefix = ""): [string, string][] {
  return Object.entries(value).flatMap(([key, inner]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
      return flatten(inner as Record<string, unknown>, path);
    }
    return [[path, Array.isArray(inner) ? inner.join(", ") : String(inner)]];
  });
}
