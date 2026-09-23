import { IconRobot, IconTool } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import type { Route } from "./+types/actions";
import { AdminShell } from "../../components/AppShell";
import { fetchMaintenance, fetchStress, saveMaintenance, saveStressCount } from "../../lib/api";
import { requireAdmin } from "../../lib/auth";
import { MAINTENANCE_MESSAGE_MAX_LENGTH } from "../../../server/maintenance";
import type { StressStatus } from "../../../server/stressBots";
import { Button, Dialog, NumberInput, Textarea } from "../../ui";

/**
 * Things an administrator does to the running world, as opposed to authoring it.
 *
 * Every other page under `/admin` edits content. This one acts on the shared
 * world that players are in right now, so it gets its own page rather than a
 * corner of an editor: one card per action, each saying what it does to
 * whoever is playing.
 *
 * The server is the control, as everywhere under `/admin`: each action is an
 * endpoint that answers an administrator's session and nobody else's. See
 * `server/api.ts`.
 */
export async function clientLoader() {
  await requireAdmin();
  const [maintenance, stress] = await Promise.all([fetchMaintenance(), fetchStress()]);
  return { maintenance, stress };
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "close-world") {
    const message = String(form.get("message") ?? "");
    return { ok: true as const, maintenance: await saveMaintenance(true, message) };
  }
  if (intent === "open-world") {
    return { ok: true as const, maintenance: await saveMaintenance(false, null) };
  }
  if (intent === "stress") {
    return { ok: true as const, stress: await saveStressCount(Number(form.get("count") ?? 0)) };
  }
  return { ok: false as const, error: "Unknown intent" };
}

export default function ActionsPage() {
  return (
    <AdminShell>
      <div className="flex max-w-2xl flex-col gap-3 p-3">
        <h1 className="text-sm font-bold uppercase tracking-wide">Actions</h1>
        <MaintenanceCard />
        <StressCard />
      </div>
    </AdminShell>
  );
}

/** One action: what it is, what it does to players, and its controls. */
function ActionCard({
  title,
  status,
  children,
}: {
  title: string;
  status: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 border-2 border-border bg-panel p-3 shadow-hard">
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-bold uppercase tracking-wide">{title}</h2>
        <div className="ml-auto">{status}</div>
      </div>
      {children}
    </section>
  );
}

/**
 * Close the world to players, or open it again. @see `server/maintenance.ts`
 *
 * Closing asks first, because it puts every player in the world out at once.
 * Opening does not: it is the undo, and the closed pages find out by
 * themselves. The message can be changed while the world is closed, and the
 * closed pages pick it up the next time they ask.
 */
function MaintenanceCard() {
  const { maintenance } = useLoaderData<typeof clientLoader>();
  const fetcher = useFetcher<typeof clientAction>();
  const [message, setMessage] = useState(maintenance?.message ?? "");
  const [asking, setAsking] = useState(false);
  const pending = fetcher.state !== "idle";
  const closed = maintenance !== null;

  // What the server stored, after a save: it trims the message, and a blank
  // one comes back as none.
  useEffect(() => {
    setMessage(maintenance?.message ?? "");
  }, [maintenance]);

  const submit = (intent: "close-world" | "open-world") => {
    fetcher.submit({ intent, message }, { method: "post" });
    setAsking(false);
  };

  return (
    <ActionCard
      title="Maintenance"
      status={
        <span
          className={`border-2 px-1.5 py-0.5 text-xs uppercase ${
            closed ? "border-danger text-danger" : "border-border text-muted"
          }`}
        >
          {closed ? "Closed" : "Open"}
        </span>
      }
    >
      <p className="text-sm leading-relaxed">
        {closed
          ? `Closed since ${new Date(maintenance.sinceMs).toLocaleString()}. Only administrators can enter.`
          : "Closing the world disconnects every player and lets only administrators enter until you open it again."}
      </p>
      <label className="flex flex-col gap-1 text-sm">
        Message for players (optional)
        <Textarea
          rows={3}
          // 16px so Safari on iOS does not zoom the page in when it is
          // focused. @see docs/notes.md, "A field the phone focuses has to be
          // 16px"
          className="text-base"
          maxLength={MAINTENANCE_MESSAGE_MAX_LENGTH}
          value={message}
          placeholder="Back by 18:00 UTC."
          onChange={(event) => setMessage(event.target.value)}
        />
      </label>
      {fetcher.data && !fetcher.data.ok ? (
        <p className="text-sm text-danger">{fetcher.data.error}</p>
      ) : null}
      <div className="flex gap-2">
        {closed ? (
          <>
            <Button variant="primary" disabled={pending} onClick={() => submit("open-world")}>
              Open world
            </Button>
            <Button
              disabled={pending || message === (maintenance.message ?? "")}
              onClick={() => submit("close-world")}
            >
              Update message
            </Button>
          </>
        ) : (
          <Button variant="danger" disabled={pending} onClick={() => setAsking(true)}>
            <IconTool size={16} stroke={2} aria-hidden="true" />
            Close world
          </Button>
        )}
      </div>
      <Dialog
        open={asking}
        onOpenChange={setAsking}
        title="Close for maintenance"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={pending} onClick={() => submit("close-world")}>
              Close world
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed">
          Every player will be disconnected now. A character in a fight stays in the world for up to
          a minute, the same as when a player closes the tab.
        </p>
      </Dialog>
    </ActionCard>
  );
}

/** How often the card asks for the bots' figures while it is open. */
const STRESS_POLL_MS = 2_000;

/**
 * Put bots in another world and watch how it holds up. @see `server/stressBots.ts`
 *
 * The bots run in the server that serves this page and play the target named
 * on the card, which is production unless the server was told otherwise. The
 * count is the whole control: bots `1..count` play, so raising it adds bots
 * and lowering it takes the highest-numbered ones out.
 */
function StressCard() {
  const loaded = useLoaderData<typeof clientLoader>().stress;
  const fetcher = useFetcher<typeof clientAction>();
  const [status, setStatus] = useState<StressStatus>(loaded);
  const [count, setCount] = useState(loaded.desired);
  const pending = fetcher.state !== "idle";

  useEffect(() => {
    const next = fetcher.data?.ok ? fetcher.data.stress : undefined;
    if (next) setStatus(next);
  }, [fetcher.data]);

  useEffect(() => {
    let live = true;
    const timer = setInterval(() => {
      fetchStress()
        .then((next) => live && setStatus(next))
        .catch(() => {
          // A missed poll is shown by the figures not moving; the next one
          // tries again.
        });
    }, STRESS_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  const apply = (next: number) => {
    setCount(next);
    fetcher.submit({ intent: "stress", count: String(next) }, { method: "post" });
  };

  const { byState, health } = status;
  const inWorld = byState.walking + byState.dead;
  const running = status.desired > 0;

  return (
    <ActionCard
      title="Stress test"
      status={
        <span
          className={`border-2 px-1.5 py-0.5 text-xs uppercase ${
            running ? "border-danger text-danger" : "border-border text-muted"
          }`}
        >
          {running ? `${inWorld} of ${status.desired} in world` : "Off"}
        </span>
      }
    >
      <p className="text-sm leading-relaxed">
        Bots sign in to <strong>{status.target}</strong> and walk around at random, over the same
        socket and protocol (v{status.protocolVersion}) a browser uses. Other players see them. Each
        bot keeps its account and character, so raising the count only adds new bots.
      </p>
      {status.halted ? <p className="text-sm text-danger">{status.halted}</p> : null}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          Bots
          <NumberInput
            // 16px so Safari on iOS does not zoom the page in when it is
            // focused. @see docs/notes.md, "A field the phone focuses has to be
            // 16px"
            className="w-24 text-base"
            min={0}
            max={status.max}
            step={1}
            value={count}
            onChange={setCount}
          />
        </label>
        <Button
          variant="primary"
          disabled={pending || count === status.desired}
          onClick={() => apply(count)}
        >
          <IconRobot size={16} stroke={2} aria-hidden="true" />
          Apply
        </Button>
        {running ? (
          <Button variant="danger" disabled={pending} onClick={() => apply(0)}>
            Stop all
          </Button>
        ) : null}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        <Figure label="Walking" value={byState.walking} />
        <Figure label="Joining" value={byState.joining} />
        <Figure label="Signing in" value={byState.account} />
        <Figure label="Waiting" value={byState.waiting} />
        <Figure label="Dead" value={byState.dead} />
        <Figure label="Failed" value={byState.failed} />
        <Figure label="Step latency p50 / p95" value={timing(status.stepLatencyMs)} />
        <Figure label="Join time p50 / p95" value={timing(status.joinMs)} />
        <Figure label="Steps per second" value={status.stepsPerSecond} />
        <Figure
          label="Received per second, uncompressed"
          value={`${(status.bytesInPerSecond / 1024).toFixed(1)} KB · ${status.messagesInPerSecond} msgs`}
        />
        <Figure
          label="Steps refused / unanswered"
          value={`${status.stepsRejected} / ${status.stepsTimedOut}`}
        />
        <Figure label="Reconnects" value={status.reconnects} />
        <Figure
          label="Target health"
          value={
            health
              ? health.ok
                ? `${health.players ?? "?"} players · ${health.responseMs} ms`
                : (health.error ?? "Not answering")
              : "Not asked yet"
          }
        />
      </dl>
      {status.errors.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-xs text-muted">
          {status.errors.map((error) => (
            <li key={error.reason}>
              {error.bots} × {error.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </ActionCard>
  );
}

function Figure({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

function timing(samples: StressStatus["stepLatencyMs"]): string {
  return samples ? `${samples.p50} / ${samples.p95} ms` : "—";
}
