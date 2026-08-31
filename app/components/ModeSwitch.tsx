import { IconEye, IconHandFinger, IconSword } from "@tabler/icons-react";
import type { PlayMode } from "./usePlayModes";
import { Tooltip } from "../ui/Tooltip";
import { useTap } from "./useTap";

/**
 * What a tap on the world means, as three settings of one switch.
 *
 * They were two independent buttons and the failure was reported rather than
 * guessed at: people would draw the sword, walk off, and not connect the red
 * outline under everything they pointed at with a button they had pressed a
 * minute ago — because "not attacking" was not a state anything on screen was
 * showing. A switch with three positions cannot have that problem. Exactly one
 * is lit, always, so the mode you are in is readable without remembering what
 * you last pressed, and getting out of a mode is choosing another one rather
 * than finding the lit thing and pressing it again.
 *
 * Each position wears the colour of the outline it puts in the world — yellow
 * acts on a thing, blue looks at it, red fights it — so the switch and the
 * canvas are never two vocabularies to learn. See `../app.css`, which is where
 * those four colours are written down.
 */

/**
 * Two sizes, because this switch lives in two places that want different
 * things. A thumb needs a target it will not miss; a desktop toolbar beside a
 * list of rows wants to be chrome rather than the main event.
 */
export type ActionButtonSize = "touch" | "compact";

/**
 * Exported because the talk button and the panel toggles ride in the same row on
 * a phone, and a row of controls whose heights are declared in two places is a
 * row that ends up ragged. See {@link ChatButton} and `./PanelToggle`.
 *
 * The touch size is a *ceiling* rather than a size. Squares of 3.5rem plus their
 * gaps want more than a small phone is wide, so a fixed size put the last
 * control off the edge and gave the page a horizontal scrollbar — which is the
 * worst of the options, because the control that ends up off screen is the one
 * nothing on screen says is there. Instead every button takes an equal share of
 * the row and stops growing at the size it always was: identical on a screen
 * with room, and evenly a little smaller on one without, with the row still
 * ending where the screen does.
 *
 * `flex-1` off a zero basis rather than a percentage width, so the gaps and the
 * rule between the halves are subtracted before the share is worked out — the
 * row cannot be made to overflow by adding chrome that is not a button. The
 * square comes from the ratio and not from a matching height, since the width
 * is now the browser's answer rather than ours.
 */
export const ACTION_BUTTON_SIZE_CLASS: Record<ActionButtonSize, string> = {
  touch: "aspect-square h-auto w-full max-w-14 flex-1",
  compact: "h-9 w-9 shrink-0",
};

const ICON_SIZE_PX: Record<ActionButtonSize, number> = {
  touch: 24,
  compact: 18,
};

/**
 * What each position is, in the order a hand meets them.
 *
 * Interact first because it is where you start and where you come back to,
 * inspect in the middle because it is the one shift reaches, and attack last
 * because it is the one with consequences — a thumb travelling to the end of the
 * row is a small deliberate act, which is the right price for drawing a sword.
 */
const MODES: {
  mode: PlayMode;
  icon: typeof IconEye;
  label: string;
  /** The same, plus how to do it from the keyboard, for the tooltip. */
  hint: string;
  /** The fill it wears while it is the one in force. Its outline's colour. */
  onClass: string;
}[] = [
  {
    mode: "interact",
    icon: IconHandFinger,
    label: "Interact",
    hint: "Interact with things",
    onClass: "bg-interact text-ink",
  },
  {
    mode: "inspect",
    icon: IconEye,
    label: "Inspect",
    hint: "Inspect things (hold Shift)",
    onClass: "bg-look text-ink",
  },
  {
    mode: "attack",
    icon: IconSword,
    label: "Attack",
    hint: "Attack your target (E)",
    onClass: "bg-danger text-paper",
  },
];

/**
 * The switch itself: one track, three positions, exactly one lit.
 *
 * A radio group rather than three toggle buttons, and said that way out loud:
 * `aria-pressed` on three separate buttons describes three independent switches,
 * which is precisely the thing this stopped being. `radio` is the one role that
 * carries "these are the options and this is the chosen one".
 *
 * **The box belongs to the switch and not to the positions.** One outline round
 * all three, with the chosen one filled and inset inside it — no rules between
 * them, nothing drawn round the two that are off. Three outlined squares was
 * still a picture of three buttons, however they were joined; a lit block
 * sliding about inside a track is a picture of one control with a setting. Which
 * is the whole claim being made: you are not pressing three things, you are
 * putting one switch somewhere.
 */
export function ModeSwitch({
  mode,
  onChange,
  size = "touch",
}: {
  mode: PlayMode;
  onChange: (mode: PlayMode) => void;
  size?: ActionButtonSize;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="What a tap does"
      className={[
        // The inset: a couple of pixels of ink between the track and whatever is
        // filled inside it, which is what makes the fill read as sitting *in*
        // the box rather than as being the box.
        "flex shrink-0 items-stretch border-2 border-paper/40 p-0.5 shadow-hard",
        size === "touch"
          ? // Three positions' worth of the share a single button gets, so the
            // row's arithmetic stays the browser's, and a third as tall as it is
            // wide so the track ends up exactly as tall as the square buttons
            // beside it however the row divides up. The cap is three of theirs.
            "aspect-[3/1] h-auto min-w-0 max-w-42 flex-[3]"
          : "h-9 w-27",
      ].join(" ")}
    >
      {MODES.map(({ mode: value, icon: Icon, label, hint, onClass }) => (
        <ModeSegment
          key={value}
          icon={Icon}
          label={label}
          hint={hint}
          on={mode === value}
          onClass={onClass}
          size={size}
          onSelect={() => onChange(value)}
        />
      ))}
    </div>
  );
}

function ModeSegment({
  icon: Icon,
  label,
  hint,
  on,
  onClass,
  size,
  onSelect,
}: {
  icon: typeof IconEye;
  label: string;
  hint: string;
  on: boolean;
  onClass: string;
  size: ActionButtonSize;
  onSelect: () => void;
}) {
  // Pointer-driven rather than click-driven, so the row still answers a thumb
  // that is holding the d-pad down. See `./useTap`.
  const tap = useTap(onSelect);

  return (
    <Tooltip content={hint}>
      <button
        type="button"
        role="radio"
        aria-checked={on}
        aria-label={label}
        // Only the chosen position is in the tab order, which is what a radio
        // group is: Tab reaches the switch, and the arrow keys would move within
        // it if there were anywhere else for arrow keys to go on this page. There
        // is not — they walk — so the remaining positions are reached by
        // pointing, and by the keys each mode already has.
        tabIndex={on ? 0 : -1}
        {...tap}
        className={[
          // Each position fills its third of the track's inside and carries no
          // border of its own: the only line in this control is the one around
          // all three.
          "flex h-full min-w-0 flex-1 items-center justify-center",
          "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
          on ? onClass : "bg-transparent text-paper",
        ].join(" ")}
      >
        <Icon size={ICON_SIZE_PX[size]} stroke={2} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
