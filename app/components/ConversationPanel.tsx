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
import { clampAmount, resolveDialog, type DialogDef, type DialogTrade, type TradeSide } from "../lib/dialog";
import { mintItemId } from "../lib/itemInstance";
import type { TileDef, TilesetDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { TITLE_SPRITE_SIZE_PX } from "./ContainerPanel";
import { TilePreview } from "./TilePreview";
import { itemCard } from "../game/itemCard";
import type { MasteryXp } from "../lib/mastery";
import type { StatusDef } from "../lib/status";
import { useCoarsePointer } from "../lib/useMediaQuery";
import { useDwell } from "../lib/useDwell";
import { Tooltip } from "../ui";
import { ItemCard } from "./ItemCard";
import { useTap } from "./useTap";

/**
 * A conversation with a body, as a panel: everything said so far, and the
 * controls the script is waiting on.
 *
 * Drawn from the tile catalogue and the conversation's counter — the server
 * sends the transcript and where the script stands, never the script itself,
 * because both ends hold the same one and a copy on the wire would be a
 * second source of it. The transcript is the live region: it is the one thing
 * that changes without the player having touched anything.
 *
 * A trade is previewed against the viewer's own kit with the same module the
 * server will run — `carriedCount`, `planTrade` — so the warnings are the
 * refusals the server would give, a round trip early, and the Trade button is
 * greyed rather than pressed and refused.
 *
 * Takes the interaction list's place rather than a place of its own, on
 * desktop and on a phone alike: a conversation is what is in reach, said
 * longer. Same walls, same button rows, same close button as a container
 * panel, so nothing about it has to be learnt.
 */

const CLOSE_ICON_SIZE_PX = 12;
const STEP_ICON_SIZE_PX = 12;
const ITEM_SPRITE_SIZE_PX = 18;

/**
 * What a caller that has wired neither gets.
 *
 * Shared frozen objects rather than `{}` defaults written at the parameter,
 * which build a fresh one on every render and would rebuild every card below
 * with them.
 */
const NO_MASTERY_XP: MasteryXp = {};
const NO_STATUS_DEFS: Record<string, StatusDef> = {};

const ROW_CLASS =
  "flex min-h-6 w-full items-center gap-1 border px-1 py-0.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent pointer-coarse:min-h-9";
const OPTION_CLASS = `${ROW_CLASS} border-paper/30 text-paper hover:border-paper hover:bg-paper/10 aria-disabled:border-dashed aria-disabled:border-paper/25 aria-disabled:text-paper/40 aria-disabled:hover:bg-transparent`;
const LABEL_CLASS = "truncate text-[11px] leading-snug font-medium tracking-tight";

type Props = {
  conversation: Conversation;
  tiles: TileDef[];
  tilesets: TilesetDef[];
  /** The viewer's kit, for previewing a trade before it is asked for. */
  equipment: Equipment;
  /**
   * What the viewer has learnt, so a trade can be read in their own hands.
   *
   * The reason a card here is worth having: "is this sword better than mine" is
   * exactly the question a trade poses, and the figures that answer it depend on
   * who is being offered the sword. Defaulted to nothing, which is what the
   * editor's preview passes — see `./DialogTryOut`.
   */
  masteryXp?: MasteryXp;
  /** Every status the world has, by id, so a card can name what a blade leaves. */
  statusDefs?: Record<string, StatusDef>;
  onTalk: (action: TalkAction) => void;
  className?: string;
  /**
   * The dialog to run, instead of the one on the conversation's tile.
   *
   * For the editor, which is drawing a draft the catalogue does not hold yet.
   * The game never passes this: what a body says is what its tile says.
   */
  dialog?: DialogDef;
  /** The heading, instead of the tile's name — for the same caller. */
  title?: string;
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
}: Props) {
  const tilesById = useMemo(() => tilesByIdFromList(tiles), [tiles]);
  const def = tilesById[conversation.tileId];
  const dialog = draft ?? (def ? resolveDialog(def) : null);
  const title = heading ?? def?.name ?? conversation.tileId;
  const waiting = dialog ? waitingOn(dialog, conversation) : null;

  // Scrolled only on the player's own press, and to *that* line — the choice
  // or the trade — at the top, so the reply reads down from it. Anything the
  // NPC adds on its own, and anything that arrives while the player is
  // reading back, leaves the scroll where the thumb put it.
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
          className="ml-auto grid h-5 w-5 shrink-0 place-items-center border-2 border-paper/40 text-paper/70 hover:border-paper hover:text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <IconX size={CLOSE_ICON_SIZE_PX} stroke={3} aria-hidden="true" />
        </button>
      </div>

      {/* One scrolling body for the words and the controls, so a long line is
          read to its end before the choice under it, and the choice is never
          off the bottom of a box that stopped scrolling at the words.

          `relative` is load-bearing: the transcript's screen-reader prefixes
          are `sr-only`, which positions them absolutely, and an absolutely
          positioned box belongs to the nearest positioned ancestor. Without
          one here they anchored to the page, and every line scrolled out of
          this box stayed as an invisible pixel below the viewport — a
          conversation long enough grew the whole page into black. */}
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
          />
        ) : null}
      </div>
    </section>
  );
}

/**
 * One line of the transcript, set by who said it.
 *
 * The NPC's lines are the panel's text; the player's are set off to the
 * right and dimmed, the way a chat draws your own side; a note is neither,
 * so it is italic and quieter still.
 */
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

/**
 * Where the player last did something in the transcript, or -1.
 *
 * A choice is a `you` line; a trade going through is a `note`. Either is the
 * line the reply follows, and the one worth bringing to the top.
 */
function lastPlayerEntry(transcript: readonly TranscriptEntry[]): number {
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i]!.who !== "npc") return i;
  }
  return -1;
}

/**
 * The trade on offer: what goes each way per unit, how many, and whether it
 * would go through.
 *
 * The count is the offer's own state until the press that carries it, and
 * the preview re-plans on every change against the real kit — `planTrade`
 * is the same call the server makes, so a greyed button here is a refusal
 * there. The two warnings name the two ways a plan fails: short on a side,
 * or nowhere for what comes back.
 */
function TradeOffer({
  trade,
  tilesById,
  tilesets,
  equipment,
  masteryXp,
  statusDefs,
  onTalk,
}: {
  trade: DialogTrade;
  tilesById: Record<string, TileDef>;
  tilesets: TilesetDef[];
  equipment: Equipment;
  masteryXp: MasteryXp;
  statusDefs: Record<string, StatusDef>;
  onTalk: (action: TalkAction) => void;
}) {
  const [amount, setAmount] = useState(clampAmount(trade, undefined));
  const scaled = scaledTrade(trade, amount);
  const short = scaled.effect === "trade"
    ? scaled.take.filter((side) => carriedCount(tilesById, equipment, side.tileId) < side.count)
    : [];
  const plan =
    scaled.effect === "trade" && short.length === 0
      ? planTrade(tilesById, equipment, scaled.take, scaled.give, mintItemId)
      : null;
  const possible = plan !== null;
  const stepClass =
    "grid w-8 shrink-0 place-items-center border border-paper/30 text-paper hover:border-paper hover:bg-paper/10 aria-disabled:text-paper/30 aria-disabled:hover:border-paper/30 aria-disabled:hover:bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent pointer-coarse:w-9";
  const less = useTap(() => setAmount((c) => Math.max(trade.min, c - 1)));
  const more = useTap(() => setAmount((c) => Math.min(trade.max, c + 1)));
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
          <button type="button" {...less} aria-label="Fewer" aria-disabled={amount <= trade.min} className={stepClass}>
            <IconMinus size={STEP_ICON_SIZE_PX} stroke={3} aria-hidden="true" />
          </button>
          <output
            aria-live="polite"
            className="grid min-w-8 flex-1 place-items-center border border-paper/30 px-1 tabular-nums text-[12px] text-paper"
          >
            ×{amount}
          </output>
          <button type="button" {...more} aria-label="More" aria-disabled={amount >= trade.max} className={stepClass}>
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
        <p className="text-[11px] leading-snug text-paper/60">There is nowhere on you to put what you would get.</p>
      ) : null}
      <div className="flex gap-1">
        <PanelButton
          className={`${OPTION_CLASS} flex-1`}
          disabled={!possible}
          onPress={() => possible && onTalk({ kind: "trade", amount })}
        >
          <span className={LABEL_CLASS}>Trade</span>
        </PanelButton>
        <PanelButton className={`${OPTION_CLASS} flex-1`} onPress={() => onTalk({ kind: "cancel" })}>
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

/**
 * One thing changing hands, and what it is.
 *
 * The card is the same one an item slot shows — see `./ItemCard` — and it is
 * read in the viewer's own hands, which is the point of having it here: a trade
 * asks whether the sword on offer beats the one you are carrying, and that
 * depends on who is carrying it.
 *
 * No count on the card. The row beside it already says how many, and the card's
 * own count is a fact about a stack somebody owns rather than about an offer.
 *
 * Hover shows it on a mouse; a held finger shows it on a touchscreen, since
 * there is no hover to have. The same gesture and the same delay an item slot
 * uses — see `../lib/useDwell` — so a player who learnt it in their bag already
 * knows it here.
 */
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
    // No instance: nobody owns this yet, and passing the offer as one would put
    // the trade's count on a card that means "how many are in this square".
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
      // Focusable so a keyboard can reach the description, and labelled with the
      // spoken card for the same reason a slot is: the drawing is `aria-hidden`.
      tabIndex={card ? 0 : undefined}
      onFocus={() => setPointedAt(true)}
      onBlur={() => setPointedAt(false)}
      // The count in front of the spoken card, which already opens with the
      // name — the same order the visible row reads in.
      aria-label={card ? `${side.count} ${card.speech}` : undefined}
      className="flex items-center gap-1 border border-paper/20 px-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      style={{
        // Without this a finger held on the row scrolls the transcript instead,
        // and the pointer events stop arriving before the dwell is up.
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

function PanelButton({
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
