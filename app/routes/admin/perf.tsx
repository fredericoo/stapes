import { Link, useLoaderData } from "react-router";
import { AdminShell } from "../../components/AppShell";
import { fetchFrameReports, fetchTickSamples } from "../../lib/api";
import { requireAdmin } from "../../lib/auth";
import { FRAME_GROUPINGS, groupFrameReports, type FrameGrouping } from "../../lib/frameSummary";
import { FRAME_BUCKET_EDGES_MS } from "../../net/frameReport";
import { TICK_PHASES } from "../../../server/tickMeter";
import type { TickSample } from "../../../server/tickLog";
import type { Route } from "./+types/perf";

const SPANS = [
  { id: "1h", label: "Last hour", ms: 60 * 60_000 },
  { id: "6h", label: "6 hours", ms: 6 * 60 * 60_000 },
  { id: "24h", label: "24 hours", ms: 24 * 60 * 60_000 },
] as const;

const GROUPING_LABELS: Record<FrameGrouping, string> = {
  build: "Build",
  gpu: "Graphics card",
  canvas: "Canvas size",
  device: "Device and screen",
  area: "Map area",
};

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  await requireAdmin();
  const params = new URL(request.url).searchParams;
  const span = SPANS.find((one) => one.id === params.get("span")) ?? SPANS[0];
  const by = FRAME_GROUPINGS.find((one) => one === params.get("by")) ?? "gpu";
  const since = Date.now() - span.ms;
  const [ticks, reports] = await Promise.all([fetchTickSamples(since), fetchFrameReports(since)]);
  return { span: span.id, by, ticks, reports };
}

export default function PerfPage() {
  const { span, by, ticks, reports } = useLoaderData<typeof clientLoader>();
  const groups = groupFrameReports(reports, by);

  return (
    <AdminShell>
      <div className="flex flex-col gap-6 p-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-sm font-bold uppercase tracking-wide">Performance</h1>
          <Choices
            choices={SPANS.map((one) => ({ id: one.id, label: one.label }))}
            chosen={span}
            to={(id) => `?span=${id}&by=${by}`}
          />
        </div>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-bold uppercase tracking-wide">Server ticks</h2>
          {ticks.samples.length === 0 ? (
            <p className="text-sm text-muted">
              No ticks in this period. The world sleeps while nobody is in it.
            </p>
          ) : (
            <TickTable samples={ticks.samples} budgetMs={ticks.tickMs} />
          )}
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 className="text-xs font-bold uppercase tracking-wide">Player frames</h2>
            <Choices
              choices={FRAME_GROUPINGS.map((id) => ({ id, label: GROUPING_LABELS[id] }))}
              chosen={by}
              to={(id) => `?span=${span}&by=${id}`}
            />
          </div>
          {groups.length === 0 ? (
            <p className="text-sm text-muted">
              No reports in this period. A tab sends one every five minutes while it plays.
            </p>
          ) : (
            <table className="w-full max-w-4xl text-left text-sm tabular-nums">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="py-1 pr-3 font-normal">{GROUPING_LABELS[by]}</th>
                  <Numeric head>Tabs</Numeric>
                  <Numeric head>Frames</Numeric>
                  <Numeric head>p50</Numeric>
                  <Numeric head>p95</Numeric>
                  <Numeric head>p99</Numeric>
                  <Numeric head>Under 30fps</Numeric>
                  <Numeric head>Worst</Numeric>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={group.key} className="border-t border-border">
                    <td className="break-all py-1 pr-3">{group.key}</td>
                    <Numeric>{group.tabs}</Numeric>
                    <Numeric>{group.frames.toLocaleString()}</Numeric>
                    <Numeric>{under(group.p50Ms)}</Numeric>
                    <Numeric>{under(group.p95Ms)}</Numeric>
                    <Numeric>{under(group.p99Ms)}</Numeric>
                    <Numeric warn={group.slowShare > 0.05}>
                      {`${(group.slowShare * 100).toFixed(1)}%`}
                    </Numeric>
                    <Numeric>{`${group.worstMs}ms`}</Numeric>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </AdminShell>
  );
}

function under(edgeMs: number): string {
  return Number.isFinite(edgeMs) ? `<${edgeMs}ms` : `${FRAME_BUCKET_EDGES_MS.at(-1)}ms+`;
}

function TickTable({ samples, budgetMs }: { samples: TickSample[]; budgetMs: number }) {
  return (
    <div className="max-h-[28rem] overflow-auto">
      <table className="w-full max-w-5xl text-left text-sm tabular-nums">
        <thead className="sticky top-0 bg-paper text-xs text-muted">
          <tr>
            <th className="py-1 pr-3 font-normal">Minute</th>
            <Numeric head>Players</Numeric>
            <Numeric head>Ticks</Numeric>
            <Numeric head>Skipped</Numeric>
            <Numeric head>Failed</Numeric>
            <Numeric head>p50</Numeric>
            <Numeric head>p95</Numeric>
            <Numeric head>Max</Numeric>
            <Numeric head>Late p95</Numeric>
            {TICK_PHASES.map((phase) => (
              <Numeric head key={phase}>{`${phase} p95`}</Numeric>
            ))}
            <Numeric head>Memory</Numeric>
          </tr>
        </thead>
        <tbody>
          {[...samples].reverse().map((sample) => (
            <tr key={sample.at} className="border-t border-border">
              <td className="py-1 pr-3">
                <time dateTime={new Date(sample.at).toISOString()}>
                  {new Date(sample.at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </td>
              <Numeric>{sample.players}</Numeric>
              <Numeric>{sample.ticks}</Numeric>
              <Numeric warn={sample.skipped > 0}>{sample.skipped}</Numeric>
              <Numeric warn={sample.failures > 0}>{sample.failures}</Numeric>
              <Numeric>{sample.tick.p50.toFixed(1)}</Numeric>
              <Numeric warn={sample.tick.p95 > budgetMs}>{sample.tick.p95.toFixed(1)}</Numeric>
              <Numeric warn={sample.tick.max > budgetMs}>{sample.tick.max.toFixed(1)}</Numeric>
              <Numeric>{sample.late.p95.toFixed(1)}</Numeric>
              {TICK_PHASES.map((phase) => (
                <Numeric key={phase}>{sample.phases[phase].p95.toFixed(1)}</Numeric>
              ))}
              <Numeric>{`${sample.rssMb}MB`}</Numeric>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Numeric({
  children,
  warn = false,
  head = false,
}: {
  children: React.ReactNode;
  warn?: boolean;
  head?: boolean;
}) {
  const Cell = head ? "th" : "td";
  return (
    <Cell
      className={`py-1 pl-3 text-right ${head ? "font-normal" : ""} ${warn ? "font-bold text-danger" : ""}`}
    >
      {children}
    </Cell>
  );
}

function Choices({
  choices,
  chosen,
  to,
}: {
  choices: { id: string; label: string }[];
  chosen: string;
  to: (id: string) => string;
}) {
  return (
    <nav className="flex flex-wrap gap-2 text-xs">
      {choices.map((choice) => (
        <Link
          key={choice.id}
          to={to(choice.id)}
          aria-current={choice.id === chosen ? "true" : undefined}
          className={
            choice.id === chosen
              ? "font-bold text-ink underline underline-offset-2"
              : "text-muted underline decoration-ink/30 underline-offset-2 hover:text-ink"
          }
        >
          {choice.label}
        </Link>
      ))}
    </nav>
  );
}
