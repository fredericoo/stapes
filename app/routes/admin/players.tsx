import {
  type SortingState,
  columnFilteringFeature,
  createColumnHelper,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_text,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { IconArrowDown, IconArrowUp, IconArrowsSort } from "@tabler/icons-react";
import { type ReactNode, useMemo, useState } from "react";
import { Link, useLoaderData } from "react-router";
import { AdminShell } from "../../components/AppShell";
import { fetchPlayers } from "../../lib/api";
import { requireAdmin } from "../../lib/auth";
import { RATING_GLYPH } from "../../lib/mastery";
import { Input } from "../../ui/Input";
import type { PlayerEntry } from "../../../server/world";

export async function clientLoader() {
  await requireAdmin();
  return { players: await fetchPlayers(), loadedAt: Date.now() };
}

const features = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  filterFns: { includesString: filterFn_includesString },
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic, text: sortFn_text },
});

const column = createColumnHelper<typeof features, PlayerEntry>();

const NUMERIC_COLUMNS = new Set(["rating", "deaths"]);

/** An online character sorts as seen at `now`, so "Online now" leads a newest-first sort. */
function columns(now: number) {
  return column.columns([
    column.accessor((entry) => entry.character?.name, {
      id: "character",
      header: "Character",
      sortUndefined: "last",
      cell: ({ row }) =>
        row.original.character ? (
          <Link
            to={`/admin/players/${encodeURIComponent(row.original.character.id)}`}
            className="font-medium underline decoration-border/40 underline-offset-2 hover:decoration-ink"
          >
            {row.original.character.name}
          </Link>
        ) : (
          <span className="text-muted">No character</span>
        ),
    }),
    column.accessor((entry) => entry.username ?? undefined, {
      id: "account",
      header: "Account",
      sortUndefined: "last",
      cell: ({ row }) => <AccountCell entry={row.original} />,
    }),
    column.accessor((entry) => entry.rating ?? undefined, {
      id: "rating",
      header: "Rating",
      sortUndefined: "last",
      sortDescFirst: true,
      enableGlobalFilter: false,
      cell: ({ row }) =>
        row.original.rating === null ? (
          <span className="text-muted">—</span>
        ) : (
          `${row.original.rating}${RATING_GLYPH}`
        ),
    }),
    column.accessor((entry) => (entry.character ? entry.deaths : undefined), {
      id: "deaths",
      header: "Deaths",
      sortUndefined: "last",
      sortDescFirst: true,
      enableGlobalFilter: false,
      cell: ({ row }) =>
        row.original.character ? row.original.deaths : <span className="text-muted">—</span>,
    }),
    column.accessor((entry) => (entry.online ? now : (entry.character?.lastSeenAt ?? undefined)), {
      id: "lastOnline",
      header: "Last online",
      sortUndefined: "last",
      sortDescFirst: true,
      enableGlobalFilter: false,
      cell: ({ row }) => <LastOnlineCell entry={row.original} now={now} />,
    }),
    column.accessor((entry) => entry.character?.createdAt ?? entry.accountCreatedAt, {
      id: "created",
      header: "Created",
      sortDescFirst: true,
      enableGlobalFilter: false,
      cell: ({ getValue }) => <Moment at={getValue()} now={now} />,
    }),
  ]);
}

export default function PlayersPage() {
  const { players, loadedAt } = useLoaderData<typeof clientLoader>();
  const [sorting, setSorting] = useState<SortingState>([{ id: "rating", desc: true }]);
  const [search, setSearch] = useState("");
  const columnDefs = useMemo(() => columns(loadedAt), [loadedAt]);

  const table = useTable({
    features,
    data: players,
    columns: columnDefs,
    state: { sorting, globalFilter: search },
    onSortingChange: setSorting,
    onGlobalFilterChange: setSearch,
  });

  const rows = table.getRowModel().rows;
  const accounts = new Set(players.map((entry) => entry.userId)).size;
  const online = players.filter((entry) => entry.online).length;

  return (
    <AdminShell>
      <div className="flex max-w-5xl flex-col gap-3 p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-sm font-bold uppercase tracking-wide">Players</h1>
          <p className="text-xs text-muted">
            {accounts} {accounts === 1 ? "account" : "accounts"} · {online} online now
          </p>
        </div>
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search characters and usernames"
          aria-label="Search characters and usernames"
          className="w-full max-w-sm"
        />
        <div className="overflow-x-auto border-2 border-border bg-paper shadow-hard">
          <table className="w-full border-collapse text-sm">
            <thead>
              {table.getHeaderGroups().map((group) => (
                <tr key={group.id} className="border-b-2 border-border bg-panel">
                  {group.headers.map((header) => {
                    const sorted = header.column.getIsSorted();
                    const numeric = NUMERIC_COLUMNS.has(header.column.id);
                    return (
                      <th
                        key={header.id}
                        scope="col"
                        aria-sort={
                          sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"
                        }
                        className={`p-0 text-xs font-bold uppercase text-muted ${numeric ? "text-right" : "text-left"}`}
                      >
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={`flex w-full items-center gap-1 px-3 py-2 hover:text-ink ${numeric ? "justify-end" : ""}`}
                        >
                          <table.FlexRender header={header} />
                          <SortIcon sorted={sorted} />
                        </button>
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={table.getAllLeafColumns().length} className="px-3 py-6 text-muted">
                    {search ? `No players match “${search}”.` : "No accounts yet."}
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} className="border-b border-border/20 last:border-b-0">
                    {row.getAllCells().map((cell) => (
                      <td
                        key={cell.id}
                        className={`whitespace-nowrap px-3 py-2 ${NUMERIC_COLUMNS.has(cell.column.id) ? "text-right tabular-nums" : ""}`}
                      >
                        <table.FlexRender cell={cell} />
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AdminShell>
  );
}

function SortIcon({ sorted }: { sorted: false | "asc" | "desc" }) {
  if (sorted === "asc") return <IconArrowUp size={12} aria-hidden="true" />;
  if (sorted === "desc") return <IconArrowDown size={12} aria-hidden="true" />;
  return <IconArrowsSort size={12} aria-hidden="true" className="opacity-40" />;
}

function AccountCell({ entry }: { entry: PlayerEntry }) {
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

function LastOnlineCell({ entry, now }: { entry: PlayerEntry; now: number }) {
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

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="border border-border px-1 text-[10px] font-bold uppercase">{children}</span>
  );
}

function Moment({ at, now }: { at: number; now: number }) {
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
