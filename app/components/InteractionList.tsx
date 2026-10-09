import {
  IconApple,
  IconBox,
  IconDoor,
  IconDroplet,
  IconFire,
  IconGift,
  IconHand,
  IconHuman,
  IconMove,
  IconPickaxe,
  IconShirt,
  IconSwitch,
  IconSword,
  IconTalk,
  IconTarget,
  IconTools,
} from "./pixelIcons";
import { useEffect, useMemo, useRef } from "react";
import type { Progress } from "../game/progress";
import type {
  InteractionAction,
  InteractionGroup,
  InteractionOption,
  OptionBlock,
} from "../game/interactionOptions";
import { bindNumberKeys, numberKeyLabel } from "../game/heldDirections";
import {
  actionRows,
  groupInteractionOptions,
  groupSubject,
  interactionText,
  listedActionRows,
  rowPress,
} from "../game/interactionOptions";
import type { TileDef, TilesetDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import {
  HEALTH_BAR_FILL_STEPS,
  healthBarColor,
  healthBarFillBricks,
  healthFraction,
} from "../render/healthBar";
import { KeyHint } from "./KeyHint";
import { TilePreview } from "./TilePreview";
import { useTap } from "./useTap";

const FRONT = "s" as const;

const ICONS: Record<InteractionAction, typeof IconTarget> = {
  target: IconTarget,
  attack: IconSword,
  follow: IconHuman,
  talk: IconTalk,
  open: IconBox,
  pickUp: IconHand,
  equip: IconShirt,
  push: IconMove,
  switch: IconSwitch,
  teleport: IconDoor,
  addStatus: IconFire,
  removeStatus: IconDroplet,
  consume: IconApple,
  reward: IconGift,
  craft: IconTools,
  extract: IconPickaxe,
};

const SPRITE_SIZE_PX = 32;

export function InteractionList({
  options,
  tiles,
  tilesets,
  onAct,
  onHover,
  hotkeys = false,
  className = "",
}: {
  options: InteractionOption[];
  tiles: TileDef[];
  tilesets: TilesetDef[];
  onAct: (option: InteractionOption) => void;
  onHover?: (optionId: string | null) => void;
  hotkeys?: boolean;
  className?: string;
}) {
  const tilesById = useMemo(() => tilesByIdFromList(tiles), [tiles]);
  const groups = useMemo(() => groupInteractionOptions(options), [options]);
  const firstRows = useMemo(() => {
    let next = 0;
    return groups.map((group) => {
      const first = next;
      next += actionRows(group.options).length;
      return first;
    });
  }, [groups]);

  const optionsRef = useRef(options);
  optionsRef.current = options;
  const onActRef = useRef(onAct);
  onActRef.current = onAct;
  useEffect(() => {
    if (!hotkeys) return;
    return bindNumberKeys((index) => {
      const row = listedActionRows(optionsRef.current)[index];
      const option = row ? rowPress(row) : null;
      if (option) onActRef.current(option);
    });
  }, [hotkeys]);

  return (
    <div
      className={["flex flex-col gap-1 overflow-y-auto overscroll-contain", className]
        .filter(Boolean)
        .join(" ")}
      role="log"
      aria-live="polite"
      aria-label="Within reach"
    >
      {options.length === 0 ? (
        <p className="px-1 py-2 text-xs text-paper/50">Nothing in reach.</p>
      ) : (
        groups.map((group, at) => (
          <InteractionBox
            key={group.key}
            group={group}
            firstRow={hotkeys ? firstRows[at]! : null}
            tile={tilesById[groupSubject(group).tileId] ?? null}
            tilesets={tilesets}
            onAct={onAct}
            onHover={onHover}
          />
        ))
      )}
    </div>
  );
}

function litClass(option: InteractionOption): string {
  if (option.action === "open") {
    return "border-interact bg-interact/20 text-paper";
  }
  if (option.action === "attack") return "border-danger bg-danger/20 text-paper";
  return "border-paper bg-paper/15 text-paper";
}

function boxClass(group: InteractionGroup, active: InteractionOption | null): string {
  if (active) return litClass(active);
  if (group.options.some((option) => option.action === "reward")) {
    return "border-reward/60 bg-reward/10 text-paper hover:border-reward";
  }
  return "border-paper/40 bg-ink text-paper hover:border-paper";
}

function actionClass(option: InteractionOption): string {
  if (option.blocked) {
    return "border-dashed border-paper/25 text-paper/40";
  }
  if (option.active) return litClass(option);
  if (option.far) {
    return "border-paper/15 text-paper/60 hover:border-paper hover:bg-paper/10 hover:text-paper";
  }
  if (option.action === "reward") {
    return "border-reward/60 text-reward hover:border-reward hover:bg-reward/10";
  }
  return "border-paper/30 text-paper hover:border-paper hover:bg-paper/10";
}

export function fillElapsedMs(progress: Progress): number {
  const elapsed = progress.durationMs - progress.remainingMs;
  return Math.max(0, Math.min(progress.durationMs, elapsed));
}

function InteractionBox({
  group,
  firstRow,
  tile,
  tilesets,
  onAct,
  onHover,
}: {
  group: InteractionGroup;
  firstRow: number | null;
  tile: TileDef | null;
  tilesets: TilesetDef[];
  onAct: (option: InteractionOption) => void;
  onHover?: (optionId: string | null) => void;
}) {
  const subject = groupSubject(group);
  const active = group.options.find((option) => option.active) ?? null;
  const rows = useMemo(() => actionRows(group.options), [group.options]);

  return (
    <div
      onMouseEnter={() => onHover?.(subject.id)}
      onMouseLeave={() => onHover?.(null)}
      className={[
        "flex w-full shrink-0 items-start gap-2 border-2 p-1",
        boxClass(group, active),
      ].join(" ")}
    >
      <TilePreview
        tile={tile}
        tilesets={tilesets}
        size={SPRITE_SIZE_PX}
        direction={FRONT}
        still
        chrome={false}
        background={null}
        className="shrink-0"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs text-paper/70">{subject.name}</span>
        {subject.health ? <RowHealth health={subject.health} /> : null}
        <div className="mt-1 flex flex-col gap-px">
          {rows.map((row, at) => (
            <div key={row[0]!.id} className="flex items-center gap-px">
              {firstRow === null ? null : <KeyHint label={numberKeyLabel(firstRow + at)} />}
              {row.map((option) => (
                <ActionButton
                  key={option.id}
                  option={option}
                  subjectId={subject.id}
                  onAct={onAct}
                  onHover={onHover}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function blockReason(blocked: OptionBlock): string | null {
  if (blocked.kind === "working") return "working";
  if (blocked.kind === "taken") return "in use";
  return "no room";
}

const FAR_HINT = "walks there first";

function actionLabel(option: InteractionOption): string {
  const reason = option.blocked ? blockReason(option.blocked) : null;
  if (reason) return `${interactionText(option)}, ${reason}`;
  if (option.far) return `${interactionText(option)}, ${FAR_HINT}`;
  return interactionText(option);
}

export function drawnBlockReason(blocked: OptionBlock): string | null {
  if (blocked.kind === "working") return null;
  return blockReason(blocked);
}

function ProgressFill({ progress, tone }: { progress: Progress; tone: "pull" | "fight" }) {
  const seen = useRef<Progress | null>(null);
  const run = useRef({ id: 0, delayMs: 0 });
  if (seen.current !== progress) {
    seen.current = progress;
    run.current = { id: run.current.id + 1, delayMs: fillElapsedMs(progress) };
  }

  return (
    <span
      key={run.current.id}
      aria-hidden="true"
      className={[
        "fill-progress pointer-events-none absolute inset-0",
        tone === "fight" ? "bg-danger/45" : "bg-paper/20",
      ].join(" ")}
      style={{
        animationDuration: `${progress.durationMs}ms`,
        animationDelay: `-${run.current.delayMs}ms`,
      }}
    />
  );
}

function ActionButton({
  option,
  subjectId,
  onAct,
  onHover,
}: {
  option: InteractionOption;
  subjectId: string;
  onAct: (option: InteractionOption) => void;
  onHover?: (optionId: string | null) => void;
}) {
  const Icon = ICONS[option.action];
  const blocked = option.blocked;
  const working = blocked?.kind === "working" ? blocked.extraction : null;
  const tap = useTap(() => {
    if (!blocked) onAct(option);
  });

  return (
    <button
      type="button"
      {...tap}
      onMouseEnter={() => onHover?.(option.id)}
      onMouseLeave={() => onHover?.(subjectId)}
      onFocus={() => onHover?.(option.id)}
      onBlur={() => onHover?.(null)}
      aria-label={actionLabel(option)}
      aria-disabled={blocked ? true : undefined}
      aria-pressed={
        option.action === "attack" ||
        option.action === "target" ||
        option.action === "follow" ||
        option.action === "open"
          ? option.active
          : undefined
      }
      className={[
        "relative overflow-hidden flex min-w-0 flex-1 min-h-6 items-center gap-1 border px-1 py-0.5 text-left pointer-coarse:min-h-9",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        actionClass(option),
      ].join(" ")}
    >
      {working ? (
        <ProgressFill progress={working} tone="pull" />
      ) : option.wait ? (
        <ProgressFill progress={option.wait} tone="fight" />
      ) : null}
      <Icon size={14} aria-hidden="true" className="relative shrink-0" />
      <span className="relative min-w-0 truncate text-detail leading-snug font-medium tracking-tight">
        {option.label}
      </span>
      {blocked && drawnBlockReason(blocked) ? (
        <span
          aria-hidden="true"
          className="relative ml-auto shrink-0 text-2xs leading-snug tracking-tight"
        >
          {drawnBlockReason(blocked)}
        </span>
      ) : null}
    </button>
  );
}

function RowHealth({ health }: { health: { hp: number; maxHp: number } }) {
  const fraction = healthFraction(health.hp, health.maxHp);

  return (
    <span
      role="img"
      aria-label={`${health.hp} of ${health.maxHp} health`}
      className="mt-1 flex h-1 w-full border border-paper/40 bg-ink"
    >
      <span
        style={{
          width: `${(healthBarFillBricks(fraction) / HEALTH_BAR_FILL_STEPS) * 100}%`,
          backgroundColor: healthBarColor(fraction),
        }}
      />
    </span>
  );
}
