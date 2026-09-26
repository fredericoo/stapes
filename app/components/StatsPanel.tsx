import {
  levelForXp,
  MASTERIES,
  type Mastery,
  type MasteryXp,
  masteriesFromXp,
  progressToNextLevel,
  RATING_GLYPH,
  rating,
} from "../lib/mastery";
import type { Attributes } from "../game/attributes";
import type { Vitals } from "../game/GameSession";
import { seconds as inSeconds } from "../lib/duration";
import { bandLabel, HEADINGS, termLabel, type TermKey } from "../lib/terms";
import type { TilesetDef } from "../lib/types";
import { healthBarColor, healthFraction } from "../render/healthBar";
import { secondsLeft } from "../game/statuses";
import { Tooltip } from "../ui";
import type { ActiveStatus } from "../lib/status";
import { compareStatuses, STATUS_ICON_SIZE_PX } from "./StatusStrip";
import { SpritePreview } from "./TilePreview";

export function StatsPanel({
  vitals,
  masteryXp,
  statuses = [],
  tilesets = [],
  scrolls = false,
  className = "",
}: {
  vitals: Vitals;
  masteryXp: MasteryXp;
  statuses?: ActiveStatus[];
  tilesets?: TilesetDef[];
  scrolls?: boolean;
  className?: string;
}) {
  const earned = MASTERIES.map((mastery) => ({
    mastery,
    level: levelForXp(masteryXp[mastery] ?? 0),
    progress: progressToNextLevel(masteryXp[mastery] ?? 0),
  }))
    .filter((row) => row.level > 0)
    .sort((a, b) => b.level - a.level);

  const stars = vitals.rating ?? rating(masteriesFromXp(masteryXp));

  return (
    <section
      className={["flex flex-col gap-1", className].filter(Boolean).join(" ")}
      aria-label="Stats"
    >
      <h2 className="flex items-baseline gap-1 text-[11px] font-bold uppercase tracking-wide text-paper/50">
        {HEADINGS.stats}
        <span className="ml-auto tabular-nums text-paper/70">
          {RATING_GLYPH}
          {stars}
        </span>
      </h2>

      <div
        className={[
          "flex flex-col gap-1",
          scrolls ? "scrolls-in-chrome overflow-y-auto overscroll-contain" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={scrolls ? { maxHeight: STATS_BODY_MAX_HEIGHT } : undefined}
      >
        <Health vitals={vitals} />

        <Effects statuses={statuses} tilesets={tilesets} />

        <h3 className="mt-1 text-[11px] font-bold uppercase tracking-wide text-paper/50">
          {HEADINGS.masteries}
        </h3>
        {earned.length === 0 ? (
          <p className="px-1 py-1 text-xs text-paper/50">Nothing practised yet. Hit something.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {earned.map(({ mastery, level, progress }) => (
              <li key={mastery} className="flex flex-col gap-0.5">
                <span className="flex items-baseline gap-1 text-xs">
                  <span className="capitalize text-paper/80">{mastery}</span>
                  <span className="ml-auto tabular-nums text-paper">{level}</span>
                </span>
                <MasteryProgress mastery={mastery} level={level} progress={progress} />
              </li>
            ))}
          </ul>
        )}

        <Combat attributes={vitals.attributes} />
      </div>
    </section>
  );
}

const STATS_BODY_MAX_HEIGHT = 200;

function Combat({ attributes }: { attributes: Attributes | null }) {
  if (!attributes) return null;

  const { minDamage, maxDamage, swingMs, hitChance, def, flee, reach, walkPace } = attributes;

  return (
    <>
      <h3 className="mt-1 text-[11px] font-bold uppercase tracking-wide text-paper/50">
        {HEADINGS.combat}
      </h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] tabular-nums">
        <Reading term="damage" value={bandLabel(minDamage, maxDamage)} />
        <Reading term="defence" value={`${def}`} />
        <Reading term="swing" value={inSeconds(swingMs)} />
        <Reading term="evasion" value={`${flee}`} />
        <Reading term="hit" value={`${Math.round(hitChance * 100)}%`} />
        <Reading term="move" value={`${walkPace.toFixed(1)}c/s`} />
        <Reading term="range" value={reach} />
      </dl>
    </>
  );
}

function Reading({ term, value }: { term: TermKey; value: string }) {
  return (
    <div className="flex items-baseline gap-1">
      <dt className="truncate text-paper/80">{termLabel(term)}</dt>
      <dd className="ml-auto shrink-0 text-paper">{value}</dd>
    </div>
  );
}

function Effects({ statuses, tilesets }: { statuses: ActiveStatus[]; tilesets: TilesetDef[] }) {
  if (statuses.length === 0) return null;

  const ordered = [...statuses].sort(compareStatuses);

  return (
    <>
      <h3 className="mt-1 text-[11px] font-bold uppercase tracking-wide text-paper/50">
        {HEADINGS.effects}
      </h3>
      <ul className="flex flex-col gap-0.5">
        {ordered.map((status) => (
          <EffectRow key={status.defId} status={status} tilesets={tilesets} />
        ))}
      </ul>
    </>
  );
}

function EffectRow({ status, tilesets }: { status: ActiveStatus; tilesets: TilesetDef[] }) {
  const seconds = secondsLeft(status.remainingMs);

  return (
    <Tooltip content={status.description} side="left">
      <li
        className="flex items-center gap-1.5 text-xs"
        aria-label={`${status.name}. ${status.description}. ${seconds} seconds left`}
      >
        <span
          className="grid shrink-0 place-items-center"
          style={{ width: STATUS_ICON_SIZE_PX, height: STATUS_ICON_SIZE_PX }}
        >
          <SpritePreview sprite={status.icon} tilesets={tilesets} size={STATUS_ICON_SIZE_PX} />
        </span>
        <span className={`truncate ${status.tone === "bad" ? "text-danger" : "text-paper/80"}`}>
          {status.name}
        </span>
        <span aria-hidden="true" className="ml-auto shrink-0 tabular-nums text-paper/70">
          {seconds}s
        </span>
      </li>
    </Tooltip>
  );
}

function Health({ vitals }: { vitals: Vitals }) {
  const { hp, maxHp } = vitals;
  if (hp === null || maxHp === null) {
    return <p className="px-1 text-xs text-paper/50">No hit points to speak of.</p>;
  }

  const fraction = healthFraction(hp, maxHp);

  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-baseline gap-1 text-xs">
        <span className="text-paper/80">{termLabel("health")}</span>
        <span className="ml-auto tabular-nums text-paper">
          {hp}
          <span className="text-paper/40">/{maxHp}</span>
        </span>
      </span>
      <span
        role="img"
        aria-label={`${hp} of ${maxHp} health`}
        className="flex h-1.5 w-full border border-paper/40 bg-ink"
      >
        <span
          style={{
            width: `${fraction * 100}%`,
            backgroundColor: healthBarColor(fraction),
          }}
        />
      </span>
    </div>
  );
}

function MasteryProgress({
  mastery,
  level,
  progress,
}: {
  mastery: Mastery;
  level: number;
  progress: number;
}) {
  return (
    <span
      role="img"
      aria-label={`${mastery} ${level}, ${Math.round(progress * 100)}% towards the next`}
      className="flex h-1 w-full border border-paper/25 bg-ink"
    >
      <span className="bg-paper/60" style={{ width: `${Math.round(progress * 100)}%` }} />
    </span>
  );
}
