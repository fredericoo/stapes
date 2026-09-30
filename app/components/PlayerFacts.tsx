import type { ReactNode } from "react";
import type { PlayerEntry } from "../../server/world";

export function AccountName({ entry }: { entry: PlayerEntry }) {
  return (
    <span className="inline-flex items-center gap-2">
      {entry.guest ? (
        <span className="text-muted">Guest</span>
      ) : (
        <span>{entry.username ?? "—"}</span>
      )}
      {entry.admin ? <Badge>Admin</Badge> : null}
    </span>
  );
}

export function LastOnline({ entry, now }: { entry: PlayerEntry; now: number }) {
  if (entry.online) {
    return (
      <span className="inline-flex items-center gap-1.5 font-medium text-accent">
        <span className="size-2 rounded-full bg-accent" aria-hidden="true" />
        Online now
      </span>
    );
  }
  const seen = entry.character?.lastSeenAt;
  if (seen == null) return <span className="text-muted">Never</span>;
  return <Moment at={seen} now={now} />;
}

export function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="border border-border px-1 text-[10px] font-bold uppercase">{children}</span>
  );
}

export function Moment({ at, now }: { at: number; now: number }) {
  if (!Number.isFinite(at)) return <span className="text-muted">—</span>;
  const date = new Date(at);
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {timeAgo(at, now)}
    </time>
  );
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 60 * 60_000],
  ["month", 30 * 24 * 60 * 60_000],
  ["week", 7 * 24 * 60 * 60_000],
  ["day", 24 * 60 * 60_000],
  ["hour", 60 * 60_000],
  ["minute", 60_000],
];

function timeAgo(at: number, now: number): string {
  const elapsed = now - at;
  for (const [unit, ms] of UNITS) {
    if (elapsed >= ms) return RELATIVE.format(-Math.floor(elapsed / ms), unit);
  }
  return "just now";
}
