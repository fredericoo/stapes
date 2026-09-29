import { IconTool } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import type { Route } from "./+types/actions";
import { AdminShell } from "../../components/AppShell";
import { fetchMaintenance, saveMaintenance } from "../../lib/api";
import { requireAdmin } from "../../lib/auth";
import { MAINTENANCE_MESSAGE_MAX_LENGTH } from "../../../server/maintenance";
import { Button, Dialog, Textarea } from "../../ui";

export async function clientLoader() {
  await requireAdmin();
  return { maintenance: await fetchMaintenance() };
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
  return { ok: false as const, error: "Unknown intent" };
}

export default function ActionsPage() {
  return (
    <AdminShell>
      <div className="flex max-w-2xl flex-col gap-3 p-3">
        <h1 className="text-sm font-bold uppercase tracking-wide">Actions</h1>
        <MaintenanceCard />
      </div>
    </AdminShell>
  );
}

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

function MaintenanceCard() {
  const { maintenance } = useLoaderData<typeof clientLoader>();
  const fetcher = useFetcher<typeof clientAction>();
  const [message, setMessage] = useState(maintenance?.message ?? "");
  const [asking, setAsking] = useState(false);
  const pending = fetcher.state !== "idle";
  const closed = maintenance !== null;

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
        {/** 16px so Safari on iOS does not zoom the page in when it is focused. */}
        <Textarea
          rows={3}
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
