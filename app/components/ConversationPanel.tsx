import { IconMinus, IconPlus, IconX } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  scaledTrade,
  waitingOn,
  type Conversation,
  type TalkAction,
  type TranscriptEntry,
} from "../game/dialogRuntime";
import type { Equipment } from "../game/equipment";
import { carriedCount, planTrade } from "../game/trade";
import {
  clampAmount,
  resolveDialog,
  type DialogDef,
  type DialogTrade,
  type TradeSide,
} from "../lib/dialog";
import { mintItemId } from "../lib/itemInstance";
import type { TileDef, TilesetDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { TITLE_SPRITE_SIZE_PX } from "./ContainerPanel";
import { TilePreview } from "./TilePreview";
import { itemCard } from "../game/itemCard";
import type { MasteryXp } from "../lib/mastery";
import type { StatusDef } from "../lib/status";
import { bindNumberKeys, bindStepKeys, numberKeyLabel } from "../game/heldDirections";
import { useCoarsePointer } from "../lib/useMediaQuery";
import { useDwell } from "../lib/useDwell";
import { Tooltip } from "../ui";
import { ItemCard } from "./ItemCard";
import { KeyHint } from "./KeyHint";
import { useTap } from "./useTap";

export const CLOSE_ICON_SIZE_PX = 12;
const STEP_ICON_SIZE_PX = 12;
const ITEM_SPRITE_SIZE_PX = 18;

const NO_MASTERY_XP: MasteryXp = {};
const NO_STATUS_DEFS: Record<string, StatusDef> = {};

const ROW_CLASS =
  "flex min-h-6 w-full items-center gap-1 border px-1 py-0.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent pointer-coarse:min-h-9";
export const OPTION_CLASS = `${ROW_CLASS} border-paper/30 text-paper hover:border-paper hover:bg-paper/10 aria-disabled:border-dashed aria-disabled:border-paper/25 aria-disabled:text-paper/40 aria-disabled:hover:bg-transparent`;
export const CLOSE_BUTTON_CLASS =
  "ml-auto grid h-5 w-5 shrink-0 place-items-center border-2 border-paper/40 text-paper/70 hover:border-paper hover:text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
export const LABEL_CLASS = "truncate text-[11px] leading-snug font-medium tracking-tight";

type Props = {
  conversation: Conversation;
  tiles: TileDef[];
  tilesets: TilesetDef[];
  equipment: Equipment;
  masteryXp?: MasteryXp;
  statusDefs?: Record<string, StatusDef>;
  onTalk: (action: TalkAction) => void;
  className?: string;
  dialog?: DialogDef;
  title?: string;
  hotkeys?: boolean;
};

export function ConversationPanel({
  conversation,
  tiles,
  tilesets,
  equipment,
  masteryXp = NO_MASTERY_XP,
  statusDefs = NO_STATUS_DEFS,
  onTalk,
  className = "",
  dialog: draft,
  title: heading,
  hotkeys = false,
}: Props) {
  const tilesById = useMemo(() => tilesByIdFromList(tiles), [tiles]);
  const def = tilesById[conversation.tileId];
  const dialog = draft ?? (def ? resolveDialog(def) : null);
  const title = heading ?? def?.name ?? conversation.tileId;
  const waiting = dialog ? waitingOn(dialog, conversation) : null;

  const bodyRef = useRef<HTMLDivElement>(null);
  const lastPressRef = useRef(-1);
  const lastPress = lastPlayerEntry(conversation.transcript);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || lastPress <= lastPressRef.current) return;
    lastPressRef.current = lastPress;
    const line = body.querySelector<HTMLElement>(`[data-line="${lastPress}"]`);
    if (line) body.scrollTop = line.offsetTop;
  }, [conversation, lastPress]);

  const choices = waiting?.kind === "choices" ? waiting.options.length : 0;
  const onTalkRef = useRef(onTalk);
  onTalkRef.current = onTalk;
  useEffect(() => {
    if (!hotkeys || choices === 0) return;
    return bindNumberKeys((index) => {
      if (index < choices) onTalkRef.current({ kind: "choose", index });
    });
  }, [hotkeys, choices]);

  return (
    <section
      aria-label={`Talking to ${title}`}
      className={`flex flex-col gap-1 border-2 border-paper/25 bg-paper/5 p-1.5 ${className}`}
    >
      <div className="flex shrink-0 items-center gap-1.5">
        {def ? (
          <TilePreview
            tile={def}
            tilesets={tilesets}
            size={TITLE_SPRITE_SIZE_PX}
            direction="s"
            still
            chrome={false}
            background={null}
          />
        ) : null}
        <h2 className="text-[11px] font-bold uppercase tracking-wide text-paper/50">{title}</h2>
        <button
          type="button"
          onClick={() => onTalk({ kind: "close" })}
          aria-label={`Close ${title}`}
          className={CLOSE_BUTTON_CLASS}
        >
          <IconX size={CLOSE_ICON_SIZE_PX} stroke={3} aria-hidden="true" />
        </button>
      </div>

      {/**
       * `relative` keeps the transcript's absolutely positioned screen-reader
       * prefixes inside it instead of growing the page.
       */}
      <div
        ref={bodyRef}
        className="relative flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain"
      >
        <ol role="log" aria-live="polite" className="flex flex-col gap-1">
          {conversation.transcript.map((entry, i) => (
            <TranscriptLine key={i} index={i} entry={entry} speaker={title} />
          ))}
        </ol>
        {waiting?.kind === "choices" ? (
          <div className="flex flex-col gap-1" key={conversation.pc.join(".")}>
            {waiting.options.map((option, index) => (
              <PanelButton key={index} onPress={() => onTalk({ kind: "choose", index })}>
                {hotkeys ? <KeyHint label={numberKeyLabel(index)} /> : null}
                <span className={LABEL_CLASS}>{option.label}</span>
              </PanelButton>
            ))}
          </div>
        ) : null}
        {waiting?.kind === "request_trade" ? (
          <TradeOffer
            key={conversation.pc.join(".")}
            trade={waiting}
            tilesById={tilesById}
            tilesets={tilesets}
            equipment={equipment}
            masteryXp={masteryXp}
            statusDefs={statusDefs}
            onTalk={onTalk}
            hotkeys={hotkeys}
          />
        ) : null}
      </div>
    </section>
  );
}

function TranscriptLine({
  index,
  entry,
  speaker,
}: {
  index: number;
  entry: TranscriptEntry;
  speaker: string;
}) {
  if (entry.who === "npc") {
    return (
      <li data-line={index} className="text-[12px] leading-snug text-paper">
        <span className="sr-only">{speaker}: </span>
        {entry.text}
      </li>
    );
  }
  if (entry.who === "you") {
    return (
      <li data-line={index} className="self-end text-right text-[11px] leading-snug text-paper/60">
        <span className="sr-only">You: </span>› {entry.text}
      </li>
    );
  }
  return (
    <li data-line={index} className="text-[11px] italic leading-snug text-paper/50">
      {entry.text}
    </li>
  );
}

function lastPlayerEntry(transcript: readonly TranscriptEntry[]): number {
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i]!.who !== "npc") return i;
  }
  return -1;
}

function TradeOffer({
  trade,
  tilesById,
  tilesets,
  equipment,
  masteryXp,
  statusDefs,
  onTalk,
  hotkeys,
}: {
  trade: DialogTrade;
  tilesById: Record<string, TileDef>;
  tilesets: TilesetDef[];
  equipment: Equipment;
  masteryXp: MasteryXp;
  statusDefs: Record<string, StatusDef>;
  onTalk: (action: TalkAction) => void;
  hotkeys: boolean;
}) {
  const [amount, setAmount] = useState(clampAmount(trade, undefined));
  const scaled = scaledTrade(trade, amount);
  const short =
    scaled.effect === "trade"
      ? scaled.take.filter((side) => carriedCount(tilesById, equipment, side.tileId) < side.count)
      : [];
  const plan =
    scaled.effect === "trade" && short.length === 0
      ? planTrade(tilesById, equipment, scaled.take, scaled.give, mintItemId)
      : null;
  const possible = plan !== null;
  const stepClass =
    "grid w-8 shrink-0 place-items-center border border-paper/30 text-paper hover:border-paper hover:bg-paper/10 aria-disabled:text-paper/30 aria-disabled:hover:border-paper/30 aria-disabled:hover:bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent pointer-coarse:w-9";
  const step = (delta: 1 | -1) =>
    setAmount((c) => Math.min(trade.max, Math.max(trade.min, c + delta)));
  const less = useTap(() => step(-1));
  const more = useTap(() => step(1));

  const pressRef = useRef({ possible, amount, onTalk, step });
  pressRef.current = { possible, amount, onTalk, step };
  useEffect(() => {
    if (!hotkeys) return;
    const unbindNumbers = bindNumberKeys((index) => {
      const now = pressRef.current;
      if (index === 0 && now.possible) now.onTalk({ kind: "trade", amount: now.amount });
      if (index === 1) now.onTalk({ kind: "cancel" });
    });
    const unbindSteps =
      trade.max > trade.min ? bindStepKeys((delta) => pressRef.current.step(delta)) : null;
    return () => {
      unbindNumbers();
      unbindSteps?.();
    };
  }, [hotkeys, trade.min, trade.max]);
  const nameOf = (tileId: string) => tilesById[tileId]?.name ?? tileId;

  return (
    <div className="flex flex-col gap-1 border border-paper/25 p-1">
      {scaled.effect === "trade" ? (
        <>
          <TradeSideRow
            label="You give"
            sides={scaled.take}
            tilesById={tilesById}
            tilesets={tilesets}
            masteryXp={masteryXp}
            statusDefs={statusDefs}
          />
          <TradeSideRow
            label="You get"
            sides={scaled.give}
            tilesById={tilesById}
            tilesets={tilesets}
            masteryXp={masteryXp}
            statusDefs={statusDefs}
          />
        </>
      ) : null}
      {trade.max > trade.min ? (
        <div className="flex items-stretch gap-1">
          <button
            type="button"
            {...less}
            aria-label="Fewer"
            aria-disabled={amount <= trade.min}
            className={stepClass}
          >
            <IconMinus size={STEP_ICON_SIZE_PX} stroke={3} aria-hidden="true" />
          </button>
          <output
            aria-live="polite"
            className="grid min-w-8 flex-1 place-items-center border border-paper/30 px-1 tabular-nums text-[12px] text-paper"
          >
            ×{amount}
          </output>
          <button
            type="button"
            {...more}
            aria-label="More"
            aria-disabled={amount >= trade.max}
            className={stepClass}
          >
            <IconPlus size={STEP_ICON_SIZE_PX} stroke={3} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {short.map((side) => (
        <p key={side.tileId} className="text-[11px] leading-snug text-paper/60">
          You need {side.count} {nameOf(side.tileId)}, and have{" "}
          {carriedCount(tilesById, equipment, side.tileId)}.
        </p>
      ))}
      {short.length === 0 && !possible ? (
        <p className="text-[11px] leading-snug text-paper/60">
          There is nowhere on you to put what you would get.
        </p>
      ) : null}
      <div className="flex gap-1">
        <PanelButton
          className={`${OPTION_CLASS} flex-1`}
          disabled={!possible}
          onPress={() => possible && onTalk({ kind: "trade", amount })}
        >
          {hotkeys ? <KeyHint label={numberKeyLabel(0)} /> : null}
          <span className={LABEL_CLASS}>Trade</span>
        </PanelButton>
        <PanelButton
          className={`${OPTION_CLASS} flex-1`}
          onPress={() => onTalk({ kind: "cancel" })}
        >
          {hotkeys ? <KeyHint label={numberKeyLabel(1)} /> : null}
          <span className={LABEL_CLASS}>Cancel</span>
        </PanelButton>
      </div>
    </div>
  );
}

function TradeSideRow({
  label,
  sides,
  tilesById,
  tilesets,
  masteryXp,
  statusDefs,
}: {
  label: string;
  sides: readonly TradeSide[];
  tilesById: Record<string, TileDef>;
  tilesets: TilesetDef[];
  masteryXp: MasteryXp;
  statusDefs: Record<string, StatusDef>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-[11px] text-paper">
      <span className="w-14 shrink-0 text-[10px] uppercase text-paper/50">{label}</span>
      {sides.length === 0 ? <span className="text-paper/50">nothing</span> : null}
      {sides.map((side) => (
        <TradeSideItem
          key={side.tileId}
          side={side}
          tilesById={tilesById}
          tilesets={tilesets}
          masteryXp={masteryXp}
          statusDefs={statusDefs}
        />
      ))}
    </div>
  );
}

function TradeSideItem({
  side,
  tilesById,
  tilesets,
  masteryXp,
  statusDefs,
}: {
  side: TradeSide;
  tilesById: Record<string, TileDef>;
  tilesets: TilesetDef[];
  masteryXp: MasteryXp;
  statusDefs: Record<string, StatusDef>;
}) {
  const def = tilesById[side.tileId];
  const coarse = useCoarsePointer();
  const { dwelling, handlers } = useDwell(coarse);
  const [pointedAt, setPointedAt] = useState(false);

  const card = useMemo(
    () => (def ? itemCard(def, null, masteryXp, statusDefs) : null),
    [def, masteryXp, statusDefs],
  );

  const row = (
    <span
      {...handlers}
      onPointerEnter={() => setPointedAt(true)}
      onPointerLeave={() => {
        setPointedAt(false);
        handlers.onPointerLeave();
      }}
      tabIndex={card ? 0 : undefined}
      onFocus={() => setPointedAt(true)}
      onBlur={() => setPointedAt(false)}
      aria-label={card ? `${side.count} ${card.speech}` : undefined}
      className="flex items-center gap-1 border border-paper/20 px-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      style={{
        touchAction: coarse ? "none" : undefined,
      }}
    >
      {def ? (
        <TilePreview
          tile={def}
          tilesets={tilesets}
          size={ITEM_SPRITE_SIZE_PX}
          still
          chrome={false}
          background={null}
        />
      ) : null}
      <span className="tabular-nums">×{side.count}</span>
      <span className="truncate">{def?.name ?? side.tileId}</span>
    </span>
  );

  if (!card || !def) return row;

  return (
    <Tooltip
      content={<ItemCard card={card} tile={def} tilesets={tilesets} />}
      side="top"
      open={dwelling || pointedAt}
      className="pointer-events-none"
    >
      {row}
    </Tooltip>
  );
}

export function PanelButton({
  onPress,
  className = OPTION_CLASS,
  disabled = false,
  children,
}: {
  onPress: () => void;
  className?: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const press = useTap(onPress);
  return (
    <button type="button" {...press} aria-disabled={disabled} className={className}>
      {children}
    </button>
  );
}
