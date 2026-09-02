import { IconArrowBackUp, IconMinus, IconPlus, IconX } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import type { Conversation, TalkAction } from "../game/dialogRuntime";
import {
  DEFAULT_CONFIRM_LABEL,
  optionAt,
  optionsAt,
  resolveDialog,
  type DialogAmount,
  type DialogDef,
} from "../lib/dialog";
import type { TileDef, TilesetDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { TITLE_SPRITE_SIZE_PX } from "./ContainerPanel";
import { TilePreview } from "./TilePreview";
import { useTap } from "./useTap";

/**
 * A conversation with a body, as a panel: what they just said, and a button
 * for everything you can say back.
 *
 * Drawn from the tile catalogue and the conversation's path — the server
 * sends where you are, the last line and the stage, never the buttons,
 * because both ends hold the same dialog and a list on the wire would be a
 * second copy of one. The line is the only thing here that changes without
 * the player having touched anything, so it is the live region.
 *
 * A tree, read as one: under a reply are its own follow-ups and nothing
 * else, under a leaf or a refusal only *Back*, and an option that wants an
 * amount asks for it before it does anything. The whole body scrolls, line
 * and buttons together, so a long piece of lore with a choice at the end is
 * read the way it was written.
 *
 * Takes the interaction list's place rather than a place of its own, on
 * desktop and on a phone alike: a conversation is what is in reach, said
 * longer. Same walls, same button rows, same close button as a container
 * panel, so nothing about it has to be learnt.
 */

const CLOSE_ICON_SIZE_PX = 12;
const STEP_ICON_SIZE_PX = 12;

const ROW_CLASS =
  "flex min-h-6 w-full items-center gap-1 border px-1 py-0.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent pointer-coarse:min-h-9";
const OPTION_CLASS = `${ROW_CLASS} border-paper/30 text-paper hover:border-paper hover:bg-paper/10`;
const BACK_CLASS = `${ROW_CLASS} border-dashed border-paper/30 text-paper/80 hover:border-paper hover:bg-paper/10`;
const LABEL_CLASS = "truncate text-[11px] leading-snug font-medium tracking-tight";

type Props = {
  conversation: Conversation;
  tiles: TileDef[];
  tilesets: TilesetDef[];
  onTalk: (action: TalkAction) => void;
  className?: string;
};

export function ConversationPanel({
  conversation,
  tiles,
  tilesets,
  onTalk,
  className = "",
}: Props) {
  const tilesById = useMemo(() => tilesByIdFromList(tiles), [tiles]);
  const def = tilesById[conversation.tileId];
  const dialog = def ? resolveDialog(def) : null;
  const title = def?.name ?? conversation.tileId;

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
        <h2 className="text-[11px] font-bold uppercase tracking-wide text-paper/50">
          {title}
        </h2>
        <button
          type="button"
          onClick={() => onTalk({ kind: "close" })}
          aria-label={`Close ${title}`}
          className="ml-auto grid h-5 w-5 shrink-0 place-items-center border-2 border-paper/40 text-paper/70 hover:border-paper hover:text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <IconX size={CLOSE_ICON_SIZE_PX} stroke={3} aria-hidden="true" />
        </button>
      </div>

      {/* One scrolling body for the words and the buttons, so a long line is
          read to its end before the choice under it, and the choice is never
          off the bottom of a box that stopped scrolling at the words. */}
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain">
        <p role="log" aria-live="polite" className="text-[12px] leading-snug text-paper">
          {conversation.line}
        </p>
        {/* A def the catalogue no longer holds, or one whose dialog stopped
            parsing under an open panel: the line still reads, and Close is
            the only button. */}
        {dialog ? <Choices dialog={dialog} conversation={conversation} onTalk={onTalk} /> : null}
      </div>
    </section>
  );
}

/** What is under the line, by stage. @see ConversationStage */
function Choices({
  dialog,
  conversation,
  onTalk,
}: {
  dialog: DialogDef;
  conversation: Conversation;
  onTalk: (action: TalkAction) => void;
}) {
  const atRoot = conversation.path.length === 0;
  const back = atRoot ? null : (
    <PanelButton className={BACK_CLASS} onPress={() => onTalk({ kind: "back" })}>
      <IconArrowBackUp size={STEP_ICON_SIZE_PX} stroke={2.5} aria-hidden="true" />
      <span className={LABEL_CLASS}>Back</span>
    </PanelButton>
  );

  if (conversation.stage === "answered") return back;

  if (conversation.stage === "counting") {
    const amount = optionAt(dialog, conversation.path)?.amount;
    return (
      <>
        {amount ? (
          <AmountEntry
            // Keyed on the path so a count never survives into another question.
            key={conversation.path.join(".")}
            amount={amount}
            onConfirm={(count) => onTalk({ kind: "confirm", amount: count })}
          />
        ) : null}
        {back}
      </>
    );
  }

  return (
    <>
      {optionsAt(dialog, conversation.path).map((option, index) => (
        <PanelButton
          key={`${conversation.path.join(".")}:${index}`}
          className={OPTION_CLASS}
          onPress={() => onTalk({ kind: "choose", index })}
        >
          <span className={LABEL_CLASS}>{option.label}</span>
        </PanelButton>
      ))}
      {back}
    </>
  );
}

/**
 * How many, and a button to say so.
 *
 * The count is the entry's own state: it means nothing until the confirm
 * that carries it, and the server clamps it to the author's range again on
 * the way in.
 */
function AmountEntry({
  amount,
  onConfirm,
}: {
  amount: DialogAmount;
  onConfirm: (count: number) => void;
}) {
  const [count, setCount] = useState(amount.min);
  const less = useTap(() => setCount((c) => Math.max(amount.min, c - 1)));
  const more = useTap(() => setCount((c) => Math.min(amount.max, c + 1)));
  const stepClass =
    "grid w-8 shrink-0 place-items-center border border-paper/30 text-paper hover:border-paper hover:bg-paper/10 aria-disabled:text-paper/30 aria-disabled:hover:border-paper/30 aria-disabled:hover:bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent pointer-coarse:w-9";

  return (
    <div className="flex items-stretch gap-1">
      <button type="button" {...less} aria-label="Fewer" aria-disabled={count <= amount.min} className={stepClass}>
        <IconMinus size={STEP_ICON_SIZE_PX} stroke={3} aria-hidden="true" />
      </button>
      <output
        aria-live="polite"
        className="grid min-w-8 flex-none place-items-center border border-paper/30 px-1 tabular-nums text-[12px] text-paper"
      >
        {count}
      </output>
      <button type="button" {...more} aria-label="More" aria-disabled={count >= amount.max} className={stepClass}>
        <IconPlus size={STEP_ICON_SIZE_PX} stroke={3} aria-hidden="true" />
      </button>
      <PanelButton className={`${OPTION_CLASS} flex-1`} onPress={() => onConfirm(count)}>
        <span className={LABEL_CLASS}>{amount.confirm ?? DEFAULT_CONFIRM_LABEL}</span>
      </PanelButton>
    </div>
  );
}

function PanelButton({
  onPress,
  className,
  children,
}: {
  onPress: () => void;
  className: string;
  children: React.ReactNode;
}) {
  const press = useTap(onPress);
  return (
    <button type="button" {...press} className={className}>
      {children}
    </button>
  );
}
