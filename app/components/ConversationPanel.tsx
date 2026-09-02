import { IconArrowBackUp, IconMinus, IconPlus, IconX } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import type { Conversation, TalkAction } from "../game/dialogRuntime";
import { optionsAt, resolveDialog, type DialogOption } from "../lib/dialog";
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
 * sends where you are and the last line, never the buttons, because both ends
 * hold the same dialog and a list on the wire would be a second copy of one.
 * The line is the only thing here that changes without the player having
 * touched anything, so it is the live region.
 *
 * Takes the interaction list's place rather than a place of its own, on
 * desktop and on a phone alike: a conversation is what is in reach, said
 * longer. Same walls, same button rows, same close button as a container
 * panel, so nothing about it has to be learnt.
 */

const CLOSE_ICON_SIZE_PX = 12;
const STEP_ICON_SIZE_PX = 12;

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
  // A def the catalogue no longer holds, or one whose dialog stopped parsing
  // under an open panel: the line still reads, and Close is the only button.
  const options = dialog ? optionsAt(dialog, conversation.path) : [];
  const atRoot = conversation.path.length === 0;
  const title = def?.name ?? conversation.tileId;

  return (
    <section
      aria-label={`Talking to ${title}`}
      className={`flex flex-col gap-1 border-2 border-paper/25 bg-paper/5 p-1.5 ${className}`}
    >
      <div className="flex items-center gap-1.5">
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

      <p
        role="log"
        aria-live="polite"
        className="text-[12px] leading-snug text-paper"
      >
        {conversation.line}
      </p>

      <div className="flex min-h-0 flex-col gap-1 overflow-y-auto overscroll-contain">
        {options.map((option, index) => (
          <OptionButton
            // The path is in the key so a stepper's count does not survive a
            // press that led somewhere else with a button of the same label.
            key={`${conversation.path.join(".")}:${index}`}
            option={option}
            onPress={(amount) => onTalk({ kind: "choose", index, amount })}
          />
        ))}
        {atRoot ? null : (
          <PanelButton onPress={() => onTalk({ kind: "back" })}>
            <IconArrowBackUp size={STEP_ICON_SIZE_PX} stroke={2.5} aria-hidden="true" />
            <span className="truncate text-[11px] leading-snug font-medium tracking-tight">
              Back
            </span>
          </PanelButton>
        )}
      </div>
    </section>
  );
}

/**
 * One thing you can say, with a stepper beside it when the author gave it an
 * amount. The count is the button's own state: it means nothing until the
 * press that carries it.
 */
function OptionButton({
  option,
  onPress,
}: {
  option: DialogOption;
  onPress: (amount: number | undefined) => void;
}) {
  const [amount, setAmount] = useState(option.amount?.min ?? 1);
  const range = option.amount;
  const press = useTap(() => onPress(range ? amount : undefined));

  return (
    <div className="flex items-stretch gap-1">
      <button
        type="button"
        {...press}
        className="relative flex min-h-6 min-w-0 flex-1 items-center gap-1 border border-paper/30 px-1 py-0.5 text-left text-paper hover:border-paper hover:bg-paper/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent pointer-coarse:min-h-9"
      >
        <span className="truncate text-[11px] leading-snug font-medium tracking-tight">
          {option.label}
        </span>
        {range ? (
          <span className="ml-auto tabular-nums text-[11px] text-paper/70">×{amount}</span>
        ) : null}
      </button>
      {range ? (
        <Stepper
          amount={amount}
          min={range.min}
          max={range.max}
          onChange={setAmount}
        />
      ) : null}
    </div>
  );
}

/** Minus and plus, held to the author's range. */
function Stepper({
  amount,
  min,
  max,
  onChange,
}: {
  amount: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
}) {
  const less = useTap(() => onChange(Math.max(min, amount - 1)));
  const more = useTap(() => onChange(Math.min(max, amount + 1)));
  const stepClass =
    "grid w-6 shrink-0 place-items-center border border-paper/30 text-paper hover:border-paper hover:bg-paper/10 aria-disabled:text-paper/30 aria-disabled:hover:border-paper/30 aria-disabled:hover:bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent pointer-coarse:w-9";
  return (
    <>
      <button type="button" {...less} aria-label="Fewer" aria-disabled={amount <= min} className={stepClass}>
        <IconMinus size={STEP_ICON_SIZE_PX} stroke={3} aria-hidden="true" />
      </button>
      <button type="button" {...more} aria-label="More" aria-disabled={amount >= max} className={stepClass}>
        <IconPlus size={STEP_ICON_SIZE_PX} stroke={3} aria-hidden="true" />
      </button>
    </>
  );
}

function PanelButton({
  onPress,
  children,
}: {
  onPress: () => void;
  children: React.ReactNode;
}) {
  const press = useTap(onPress);
  return (
    <button
      type="button"
      {...press}
      className="flex min-h-6 w-full items-center gap-1 border border-dashed border-paper/30 px-1 py-0.5 text-left text-paper/80 hover:border-paper hover:bg-paper/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent pointer-coarse:min-h-9"
    >
      {children}
    </button>
  );
}
