import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  TRADE_REFUSED,
  waitingOn,
  type Conversation,
  type TalkAction,
  type TranscriptEntry,
} from "../game/dialogRuntime";
import type { Equipment } from "../game/equipment";
import { bindNumberKeys, bindStepKeys, numberKeyLabel } from "../game/heldDirections";
import { carriedCash, carriedCount, largestTradeAmount, planDeal, scaleTerms } from "../game/trade";
import {
  clampAmount,
  resolveDialog,
  type DialogDef,
  type DialogTrade,
  type TradeSide,
} from "../lib/dialog";
import { splitCash } from "../lib/cash";
import { dialogPlainText } from "../lib/dialogText";
import { mintItemId } from "../lib/itemInstance";
import type { MasteryXp } from "../lib/mastery";
import type { StatusDef } from "../lib/status";
import type { TileDef, TilesetDef } from "../lib/types";
import { useReducedMotion } from "../lib/useMediaQuery";
import { tilesByIdFromList } from "../lib/validation";
import { filledCells } from "../render/brickIcon";
import { TAIL_PIXELS, type TailLean } from "../render/speechBubble";
import { placeTalkBubble, type TalkAnchor, type TalkAnchorChannel } from "../render/talkBubble";
import { ANCHOR_CLEARANCE_EMS, BRICKS_PER_EM } from "../render/textLabels";
import { DialogText } from "./DialogText";
import { ItemCatalogueContext, ItemMention, type ItemCatalogue } from "./ItemMention";
import { useKeyboardLikely } from "./useKeyboardLikely";
import { useTap } from "./useTap";

const NO_MASTERY_XP: MasteryXp = {};
const NO_STATUS_DEFS: Record<string, StatusDef> = {};

const LEAVE_LABEL = "Leave";

/** Bricks kept clear between the bubble and the canvas frame; `--talk-margin` in `app.css` is the same. */
const MARGIN_BRICKS = 8;
const TAIL_BRICKS = 4;

type Props = {
  conversation: Conversation;
  tiles: TileDef[];
  tilesets: TilesetDef[];
  equipment: Equipment;
  masteryXp?: MasteryXp;
  statusDefs?: Record<string, StatusDef>;
  onTalk: (action: TalkAction) => void;
  dialog?: DialogDef;
  speaker?: string;
  hotkeys?: boolean;
  ref?: React.Ref<HTMLElement>;
};

/**
 * The conversation's current stage in a speech bubble: what the NPC said
 * since the last press, then whatever the script is waiting on. A script that
 * has run out offers Leave, so there is always a way to close it from inside.
 */
export function ConversationBubble({
  conversation,
  tiles,
  tilesets,
  equipment,
  masteryXp = NO_MASTERY_XP,
  statusDefs = NO_STATUS_DEFS,
  onTalk,
  dialog: draft,
  speaker,
  hotkeys = false,
  ref,
}: Props) {
  const tilesById = useMemo(() => tilesByIdFromList(tiles), [tiles]);
  const catalogue = useMemo<ItemCatalogue>(
    () => ({ tilesById, tilesets, masteryXp, statusDefs }),
    [tilesById, tilesets, masteryXp, statusDefs],
  );
  const def = tilesById[conversation.tileId];
  const dialog = draft ?? (def ? resolveDialog(def) : null);
  const title = speaker ?? def?.name ?? conversation.tileId;
  const waiting = dialog ? waitingOn(dialog, conversation) : null;

  const instant = useReducedMotion();
  const { typingIndex, typing, onTyped, skip } = useTypingCursor(conversation, instant);
  const skipRef = useRef(skip);
  skipRef.current = skip;
  useEffect(() => {
    if (!hotkeys || !typing) return;
    return bindNumberKeys(() => skipRef.current());
  }, [hotkeys, typing]);

  const bodyRef = useRef<HTMLDivElement>(null);
  const refused = conversation.transcript.at(-1)?.text === TRADE_REFUSED;
  useLayoutEffect(() => {
    if (bodyRef.current && !refused) bodyRef.current.scrollTop = 0;
  }, [conversation, refused]);

  /**
   * The whole stage is laid out from the start, and the body is cut off just
   * under the line being typed, so the bubble grows a line at a time. The
   * full height stays measurable under the cut, as `data-settled-height`,
   * which is what the bubble's side of the NPC is chosen by. A new stage and
   * the choices opening move the cut in a few quick steps from where it was;
   * a line starting to type moves it at once.
   */
  const shown = useRef<{ conversation: Conversation; typing: boolean; height: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const bubble = body?.parentElement;
    if (!body || !bubble) return;
    const before = shown.current;
    body.style.transition = "none";
    body.style.maxHeight = "";
    bubble.dataset.settledHeight = String(bubble.offsetHeight);
    let height = body.offsetHeight;
    const line = typing ? body.querySelector<HTMLElement>("[data-typing]") : null;
    if (line) {
      const top = body.getBoundingClientRect().top - body.scrollTop;
      const padding = Number.parseFloat(getComputedStyle(body).paddingBottom) || 0;
      height = Math.ceil(line.getBoundingClientRect().bottom - top) + padding;
    }
    shown.current = { conversation, typing, height };

    const glides =
      !instant &&
      before !== null &&
      before.height !== height &&
      (before.conversation !== conversation || before.typing !== typing);
    if (glides) {
      body.style.maxHeight = `${before.height}px`;
      body.getBoundingClientRect();
      body.style.transition = "";
      body.dataset.gliding = "";
    } else {
      delete body.dataset.gliding;
    }
    if (line || glides) body.style.maxHeight = `${height}px`;
    if (line) body.scrollTop = Math.max(0, height - body.clientHeight);
    if (!glides || line) return;

    const settle = () => {
      delete body.dataset.gliding;
      body.style.maxHeight = "";
    };
    body.addEventListener("transitionend", settle, { once: true });
    return () => body.removeEventListener("transitionend", settle);
  }, [conversation, typing, typingIndex, instant]);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const mark = () => {
      const above = body.scrollTop > 1;
      const below = body.scrollTop + body.clientHeight < body.scrollHeight - 1;
      body.dataset.more = [above ? "above" : "", below ? "below" : ""].join(" ").trim();
    };
    mark();
    body.addEventListener("scroll", mark, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(mark);
    observer?.observe(body);
    for (const child of body.children) observer?.observe(child);
    return () => {
      body.removeEventListener("scroll", mark);
      observer?.disconnect();
    };
  }, [conversation]);

  const choices = waiting?.kind === "choices" ? waiting.options.length : waiting ? 0 : 1;
  const onTalkRef = useRef(onTalk);
  onTalkRef.current = onTalk;
  const leaves = waiting === null;
  useEffect(() => {
    if (!hotkeys || typing || choices === 0) return;
    return bindNumberKeys((index) => {
      if (index >= choices) return;
      onTalkRef.current(leaves ? { kind: "close" } : { kind: "choose", index });
    });
  }, [hotkeys, typing, choices, leaves]);

  const stage = conversation.pc.join(".");
  return (
    <ItemCatalogueContext value={catalogue}>
      <section ref={ref} aria-label={`Talking to ${title}`} className="speech-bubble talk-bubble">
        <div
          ref={bodyRef}
          onClick={typing ? skip : undefined}
          data-growing={typing || undefined}
          className="talk-bubble__body"
        >
          <p className="talk-bubble__speaker">{title}</p>
          <ol role="log" aria-live="polite" className="talk-bubble__lines">
            {conversation.transcript.map((entry, index) => (
              <StageLine
                key={index}
                entry={entry}
                speaker={title}
                tilesById={tilesById}
                state={index < typingIndex ? "typed" : index === typingIndex ? "typing" : "pending"}
                onTyped={onTyped}
              />
            ))}
          </ol>
          <div className="talk-bubble__actions" inert={typing} data-pending={typing || undefined}>
            {waiting?.kind === "choices" ? (
              <div className="talk-options" key={stage}>
                {waiting.options.map((option, index) => (
                  <TalkOption
                    key={index}
                    hint={hotkeys ? numberKeyLabel(index) : null}
                    label={dialogPlainText(option.label, tilesById)}
                    onPress={() => onTalk({ kind: "choose", index })}
                  >
                    <DialogText text={option.label} focusable={false} />
                  </TalkOption>
                ))}
              </div>
            ) : null}
            {waiting?.kind === "request_trade" ? (
              <TradeOffer
                key={stage}
                trade={waiting}
                tilesById={tilesById}
                equipment={equipment}
                onTalk={onTalk}
                hotkeys={hotkeys && !typing}
              />
            ) : null}
            {leaves ? (
              <div className="talk-options">
                <TalkOption
                  hint={hotkeys ? numberKeyLabel(0) : null}
                  onPress={() => onTalk({ kind: "close" })}
                >
                  {LEAVE_LABEL}
                </TalkOption>
              </div>
            ) : null}
          </div>
        </div>
        <BubbleTail />
      </section>
    </ItemCatalogueContext>
  );
}

function StageLine({
  entry,
  speaker,
  tilesById,
  state,
  onTyped,
}: {
  entry: TranscriptEntry;
  speaker: string;
  tilesById: Record<string, TileDef>;
  state: "typed" | "typing" | "pending";
  onTyped: () => void;
}) {
  if (entry.who === "note") {
    return (
      <li className="talk-bubble__note" data-pending={state === "pending" || undefined}>
        {entry.text}
      </li>
    );
  }
  return (
    <li data-typing={state === "typing" || undefined}>
      <span className="sr-only">
        {speaker}: {dialogPlainText(entry.text, tilesById)}
      </span>
      <span aria-hidden="true" className={state === "pending" ? "invisible" : undefined}>
        <DialogText text={entry.text} typing={state === "typing"} onTyped={onTyped} />
      </span>
    </li>
  );
}

/**
 * A refused trade adds its note to the stage already on screen; every other
 * change is a new stage. Told apart so a refusal does not type the offer out
 * again.
 */
function continuesStage(previous: Conversation, next: Conversation): boolean {
  return (
    previous.npcId === next.npcId &&
    previous.pc.join(".") === next.pc.join(".") &&
    next.transcript.at(-1)?.text === TRADE_REFUSED
  );
}

function useTypingCursor(conversation: Conversation, instant: boolean) {
  const { transcript } = conversation;
  const [typed, setTyped] = useState({ conversation, count: 0 });
  let count = typed.count;
  if (typed.conversation !== conversation) {
    count = continuesStage(typed.conversation, conversation) ? transcript.length : 0;
    setTyped({ conversation, count });
  }
  const typingIndex = instant ? transcript.length : nextNpcLine(transcript, count);
  return {
    typingIndex,
    typing: typingIndex < transcript.length,
    onTyped: () => setTyped({ conversation, count: typingIndex + 1 }),
    skip: () => setTyped({ conversation, count: transcript.length }),
  };
}

function nextNpcLine(transcript: readonly TranscriptEntry[], from: number): number {
  let i = from;
  while (i < transcript.length && transcript[i]!.who !== "npc") i++;
  return i;
}

function TalkOption({
  hint,
  label,
  disabled = false,
  onPress,
  children,
}: {
  hint: string | null;
  label?: string;
  disabled?: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  const press = useTap(() => {
    if (!disabled) onPress();
  });
  const keyboard = useKeyboardLikely();
  return (
    <button
      type="button"
      {...press}
      aria-label={label}
      aria-disabled={disabled}
      className="talk-option"
    >
      <span aria-hidden="true" className="talk-option__key">
        {hint && keyboard ? hint : ">"}
      </span>
      <span className="talk-option__label">{children}</span>
    </button>
  );
}

function TradeOffer({
  trade,
  tilesById,
  equipment,
  onTalk,
  hotkeys,
}: {
  trade: DialogTrade;
  tilesById: Record<string, TileDef>;
  equipment: Equipment;
  onTalk: (action: TalkAction) => void;
  hotkeys: boolean;
}) {
  const [amount, setAmount] = useState(clampAmount(trade, undefined));
  const scaled = scaleTerms(trade, amount);
  const { take, give, takeCash = 0, giveCash = 0 } = scaled;
  const cash = carriedCash(tilesById, equipment);
  const short = take.filter((side) => carriedCount(tilesById, equipment, side.tileId) < side.count);
  const shortOfCash = cash < takeCash;
  const possible =
    short.length === 0 &&
    !shortOfCash &&
    planDeal(tilesById, equipment, scaled, mintItemId) !== null;
  const step = (delta: 1 | -1) =>
    setAmount((c) => Math.min(trade.max, Math.max(trade.min, c + delta)));
  const less = useTap(() => step(-1));
  const more = useTap(() => step(1));
  const largest = useMemo(
    () => largestTradeAmount(tilesById, equipment, trade, mintItemId),
    [tilesById, equipment, trade],
  );
  const most = useTap(() => {
    if (largest !== null) setAmount(largest);
  });

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
    <>
      <div className="talk-trade">
        <TradeSideRow label="You give" sides={take} cash={takeCash} tilesById={tilesById} />
        <TradeSideRow label="You get" sides={give} cash={giveCash} tilesById={tilesById} />
        {trade.max > trade.min ? (
          <div className="talk-trade__amount">
            <button
              type="button"
              {...less}
              aria-label="Fewer"
              aria-disabled={amount <= trade.min}
              className="talk-step talk-step--square"
            >
              -
            </button>
            <output aria-live="polite" className="talk-trade__count">
              x{amount}
            </output>
            <button
              type="button"
              {...more}
              aria-label="More"
              aria-disabled={amount >= trade.max}
              className="talk-step talk-step--square"
            >
              +
            </button>
            <button
              type="button"
              {...most}
              aria-disabled={largest === null || amount === largest}
              className="talk-step"
            >
              Max
            </button>
          </div>
        ) : null}
        {short.map((side) => (
          <p key={side.tileId} className="talk-bubble__note">
            You need {side.count} {nameOf(side.tileId)}, and have{" "}
            {carriedCount(tilesById, equipment, side.tileId)}.
          </p>
        ))}
        {shortOfCash ? (
          <p className="talk-bubble__note">
            You need {takeCash} in cash, and have {cash}.
          </p>
        ) : null}
        {short.length === 0 && !shortOfCash && !possible ? (
          <p className="talk-bubble__note">There is nowhere on you to put what you would get.</p>
        ) : null}
      </div>
      <div className="talk-options">
        <TalkOption
          hint={hotkeys ? numberKeyLabel(0) : null}
          disabled={!possible}
          onPress={() => onTalk({ kind: "trade", amount })}
        >
          {take.length === 0 && takeCash === 0 ? "Accept" : "Trade"}
        </TalkOption>
        <TalkOption
          hint={hotkeys ? numberKeyLabel(1) : null}
          onPress={() => onTalk({ kind: "cancel" })}
        >
          Cancel
        </TalkOption>
      </div>
    </>
  );
}

function TradeSideRow({
  label,
  sides,
  cash,
  tilesById,
}: {
  label: string;
  sides: readonly TradeSide[];
  cash: number;
  tilesById: Record<string, TileDef>;
}) {
  const shown = [...splitCash(tilesById, cash), ...sides];
  return (
    <div className="talk-trade__side">
      <span className="talk-trade__label">{label}</span>
      <span className="talk-trade__items">
        {shown.length === 0 ? <span className="talk-bubble__note">nothing</span> : null}
        {shown.map((side, i) => (
          <ItemMention key={`${i}:${side.tileId}`} tileId={side.tileId} count={side.count} />
        ))}
      </span>
    </div>
  );
}

const TAIL_LEANS: TailLean[] = ["left", "none", "right"];

function BubbleTail() {
  return (
    <div className="speech-bubble__tail" data-lean="none" aria-hidden="true">
      {TAIL_LEANS.map((lean) => {
        const { rows } = TAIL_PIXELS[lean];
        return (
          <svg
            key={lean}
            className={`speech-bubble__tail-${lean}`}
            viewBox={`0 0 ${rows[0]!.length} ${rows.length}`}
            shapeRendering="crispEdges"
            fill="currentColor"
          >
            {filledCells(rows, (pixel) => pixel === "f").map((cell) => (
              <rect key={`${cell.x},${cell.y}`} x={cell.x} y={cell.y} width={1} height={1} />
            ))}
          </svg>
        );
      })}
    </div>
  );
}

/**
 * Holds the bubble over the body it belongs to. The renderer publishes where
 * that body is every frame, and the bubble is moved by writing its transform,
 * not by rendering.
 */
export function AnchoredConversation({
  channel,
  ...bubble
}: Omit<Props, "ref"> & { channel: TalkAnchorChannel }) {
  const layerRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const element = bubbleRef.current;
    if (!layer || !element) return;
    const tail = element.querySelector<HTMLElement>(".speech-bubble__tail");
    let anchor: TalkAnchor | null = null;
    let fontPx = 0;
    let size = { width: 0, height: 0 };
    let settledHeight = 0;
    let view = { width: 0, height: 0 };

    const place = () => {
      const brickPx = fontPx / BRICKS_PER_EM;
      const at = placeTalkBubble({
        anchor,
        view,
        size,
        settledHeight,
        brickPx,
        marginPx: MARGIN_BRICKS * brickPx,
        liftPx: Math.round(fontPx * ANCHOR_CLEARANCE_EMS),
        tailPx: TAIL_BRICKS * brickPx,
      });
      element.style.transform = `translate(${at.left}px, ${at.top}px)`;
      element.dataset.side = at.side;
      if (tail && at.tail) {
        tail.dataset.lean = at.tail.lean;
        tail.style.setProperty("--tail-x", `${at.tail.leftBrick * brickPx}px`);
      }
    };
    const measure = () => {
      fontPx = Number.parseFloat(getComputedStyle(layer).fontSize) || 0;
      size = { width: element.offsetWidth, height: element.offsetHeight };
      settledHeight = Number(element.dataset.settledHeight) || 0;
      view = { width: layer.clientWidth, height: layer.clientHeight };
      place();
    };

    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    observer?.observe(layer);
    const stop = channel.listen((next) => {
      anchor = next;
      place();
    });
    return () => {
      observer?.disconnect();
      stop();
    };
  }, [channel]);

  return (
    <div ref={layerRef} className="talk-layer">
      <ConversationBubble {...bubble} ref={bubbleRef} />
    </div>
  );
}
