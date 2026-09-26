import type { CharmItem } from "../lib/item";
import { MAX_CHARM_HP, MAX_CHARM_INTERVAL_MS, MIN_CHARM_INTERVAL_MS } from "../lib/item";
import type { StatusDef } from "../lib/status";
import { StatField } from "./StatField";
import { StatusGrants } from "./StatusGrants";

const MS_PER_SECOND = 1000;

const SECONDS_PER_MINUTE = 60;

export function CharmFields({
  charm,
  onChange,
  statusDefs = {},
}: {
  charm: CharmItem;
  onChange: (fields: Partial<CharmItem>) => void;
  statusDefs?: Record<string, StatusDef>;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-4">
        <StatField
          label="Every (s)"
          info="How often it acts, for as long as it is worn. The clock is on the wearer and belongs to that particular charm, so swapping charms starts a new one — and it does not survive the world being unloaded."
          value={Math.round(charm.everyMs / MS_PER_SECOND)}
          min={MIN_CHARM_INTERVAL_MS / MS_PER_SECOND}
          max={MAX_CHARM_INTERVAL_MS / MS_PER_SECOND}
          onChange={(seconds) => onChange({ everyMs: seconds * MS_PER_SECOND })}
          readout={describeInterval(charm.everyMs)}
        />
        <StatField
          label="Mends"
          info="Health each tick puts back. Positive only — a charm acts on its wearer without being asked, so it may not harm one. Clamped at full health, and a tick that restored nothing shows no number."
          value={charm.hp ?? 0}
          min={0}
          max={MAX_CHARM_HP}
          onChange={(hp) => onChange({ hp: hp > 0 ? hp : undefined })}
          readout={describeMend(charm.hp, charm.everyMs)}
        />
      </div>

      <div className="flex flex-col gap-2 border-t-2 border-border pt-3">
        <StatusGrants
          statuses={charm.statuses ?? []}
          statusDefs={statusDefs}
          info="Rolled every tick, for as long as the charm is worn. Granted afresh each time rather than held while worn, so one that lands on somebody already under it simply restarts the clock — which is what makes a charm of light a lantern."
          onChange={(statuses) => onChange({ statuses: statuses.length ? statuses : undefined })}
          blank={(id) => ({ id })}
        />
      </div>
    </div>
  );
}

function describeInterval(everyMs: number): string {
  const seconds = Math.round(everyMs / MS_PER_SECOND);
  if (seconds < SECONDS_PER_MINUTE) return `Acts every ${seconds}s.`;
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const rest = seconds % SECONDS_PER_MINUTE;
  return rest === 0 ? `Acts every ${minutes}m.` : `Acts every ${minutes}m ${rest}s.`;
}

function describeMend(hp: number | undefined, everyMs: number): string {
  if (!hp) return "Mends nothing; a charm of statuses alone.";
  const perMinute = Math.round((hp * SECONDS_PER_MINUTE * MS_PER_SECOND) / everyMs);
  return `${hp} a tick — about ${perMinute} a minute at full stretch.`;
}
