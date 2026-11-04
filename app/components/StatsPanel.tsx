import {
  levelForXp,
  MAGIC_MASTERIES,
  type Mastery,
  MASTERY_LABELS,
  type MasteryXp,
  masteriesFromXp,
  PHYSICAL_MASTERIES,
  progressToNextLevel,
  rating,
  WEAPON_MASTERIES,
} from "../lib/mastery";
import type { Attributes } from "../game/attributes";
import type { Vitals } from "../game/GameSession";
import { formatCountdown, formatDuration } from "../lib/duration";
import { bandLabel, HEADINGS, termLabel, type TermKey } from "../lib/terms";
import type { TilesetDef } from "../lib/types";
import { secondsLeft } from "../game/statuses";
import { Tooltip } from "../ui";
import type { ActiveStatus } from "../lib/status";
import { compareStatuses, STATUS_ICON_SIZE_PX } from "./StatusStrip";
import { SpritePreview } from "./TilePreview";
import { Rating } from "./Rating";
import { HudWindow } from "./HudWindow";

export function StatsPanel({
  vitals,
  masteryXp,
  statuses = [],
  tilesets = [],
  scrolls = false,
  onClose,
  className = "",
}: {
  vitals: Vitals;
  masteryXp: MasteryXp;
  statuses?: ActiveStatus[];
  tilesets?: TilesetDef[];
  scrolls?: boolean;
  onClose?: () => void;
  className?: string;
}) {
  const stars = vitals.rating ?? rating(masteriesFromXp(masteryXp));

  return (
    <HudWindow
      label="Stats"
      title={HEADINGS.stats}
      meta={<Rating value={stars} className="text-paper/80" />}
      onClose={onClose}
      flush
      className={className}
    >
      <div
        className={[
          "flex flex-col gap-1 p-1",
          scrolls ? "scrolls-in-chrome overflow-y-auto overscroll-contain" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={scrolls ? { maxHeight: STATS_BODY_MAX_HEIGHT } : undefined}
      >
        <Effects statuses={statuses} tilesets={tilesets} />

        <h3 className={SECTION_HEADING_CLASS}>{HEADINGS.masteries}</h3>
        {MASTERY_GROUPS.map((group) => (
          <MasteryGroup key={group.label} group={group} masteryXp={masteryXp} />
        ))}

        <Combat attributes={vitals.attributes} />
      </div>
    </HudWindow>
  );
}

const WEAPON_GROUP: Mastery[] = WEAPON_MASTERIES.filter(
  (mastery) => !MAGIC_MASTERIES.includes(mastery),
);

/**
 * Built from the lists in `lib/mastery` so that every mastery lands in exactly
 * one group: what is neither a weapon nor magic is physical.
 */
const MASTERY_GROUPS: { label: string; masteries: Mastery[] }[] = [
  { label: "Weapons", masteries: WEAPON_GROUP },
  {
    label: "Physical",
    masteries: PHYSICAL_MASTERIES.filter((mastery) => !WEAPON_GROUP.includes(mastery)),
  },
  { label: "Arcane", masteries: MAGIC_MASTERIES },
];

function MasteryGroup({
  group,
  masteryXp,
}: {
  group: { label: string; masteries: Mastery[] };
  masteryXp: MasteryXp;
}) {
  return (
    <div className="flex flex-col gap-0.5" role="group" aria-label={`${group.label} masteries`}>
      <h4 className="text-2xs uppercase tracking-wide text-paper/50">{group.label}</h4>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1">
        {group.masteries.map((mastery) => {
          const xp = masteryXp[mastery] ?? 0;
          const level = levelForXp(xp);
          return (
            <li key={mastery} className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-baseline gap-1 text-xs">
                <span className="truncate text-paper/80">{MASTERY_LABELS[mastery]}</span>
                <span className="ml-auto tabular-nums text-paper">{level}</span>
              </span>
              <MasteryProgress mastery={mastery} level={level} progress={progressToNextLevel(xp)} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const SECTION_HEADING_CLASS =
  "mt-1 border-b border-paper/10 pb-0.5 text-detail uppercase tracking-wide text-label/70 first:mt-0";

const STATS_BODY_MAX_HEIGHT = 240;
const MS_PER_SECOND = 1000;

function Combat({ attributes }: { attributes: Attributes | null }) {
  if (!attributes) return null;

  const { minDamage, maxDamage, swingMs, hitChance, def, flee, reach, walkPace } = attributes;

  return (
    <>
      <h3 className={SECTION_HEADING_CLASS}>{HEADINGS.combat}</h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-detail tabular-nums">
        <Reading term="damage" value={bandLabel(minDamage, maxDamage)} />
        <Reading term="defence" value={`${def}`} />
        <Reading term="swing" value={formatDuration(swingMs)} />
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
      <h3 className={SECTION_HEADING_CLASS}>{HEADINGS.effects}</h3>
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
          {formatCountdown(seconds * MS_PER_SECOND)}
        </span>
      </li>
    </Tooltip>
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
      className="flex h-1.5 w-full border border-paper/35 bg-black"
    >
      <span className="bg-label" style={{ width: `${Math.round(progress * 100)}%` }} />
    </span>
  );
}
