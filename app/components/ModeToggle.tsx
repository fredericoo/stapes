import { IconEye, IconSword } from "@tabler/icons-react";
import { Tooltip } from "../ui/Tooltip";

/**
 * The modes a tap can be in, as buttons you can see the state of.
 *
 * Both of these started as keyboard modifiers and both outgrew that. Looking is
 * shift on a desktop, which is unfindable — a modifier is only discoverable to
 * somebody who already knows it is there — and unavailable to a thumb. Attacking
 * used to not be a mode at all: clicking a creature *was* the attack, so there
 * was no way to point at something without swinging at it.
 *
 * They are drawn the same and behave the same on purpose. One is blue and one is
 * red, and the colour of each is the colour of the outline it puts in the world,
 * so the button and the thing it is doing are never separately learned. Neither
 * mode excludes the other: you can look at things while your sword is out.
 */

/**
 * Two sizes, because these buttons live in two places that want different
 * things. A thumb needs a target it will not miss; a desktop toolbar beside a
 * list of rows wants to be chrome rather than the main event.
 */
export type ModeToggleSize = "touch" | "compact";

/**
 * Exported because the talk button rides in the same row on a phone, and a row
 * of controls whose heights are declared in two places is a row that ends up
 * ragged. See {@link ChatButton}.
 *
 * The touch size is a *ceiling* rather than a size. Six squares of 3.5rem plus
 * their gaps want 409px and a small phone is 375px wide, so a fixed size put
 * the bag button off the edge and gave the page a horizontal scrollbar — which
 * is the worst of the options, because the control that ends up off screen is
 * the one nothing on screen says is there. Instead every button takes an equal
 * share of the row and stops growing at the size it always was: identical on a
 * screen with room, and evenly a little smaller on one without, with the row
 * still ending where the screen does.
 *
 * `flex-1` off a zero basis rather than a percentage width, so the gaps and the
 * rule between the two halves are subtracted before the share is worked out —
 * the row cannot be made to overflow by adding chrome that is not a button. The
 * square comes from the ratio and not from a matching height, since the width
 * is now the browser's answer rather than ours.
 */
export const MODE_TOGGLE_SIZE_CLASS: Record<ModeToggleSize, string> = {
  touch: "aspect-square h-auto w-full max-w-14 flex-1",
  compact: "h-9 w-9 shrink-0",
};

const ICON_SIZE_PX: Record<ModeToggleSize, number> = {
  touch: 24,
  compact: 18,
};

/** Which colour a mode wears while it is on. Matches its outline in the world. */
type ModeTone = "look" | "attack";

const ON_CLASS: Record<ModeTone, string> = {
  look: "border-look bg-look text-ink",
  attack: "border-danger bg-danger text-paper",
};

function ModeToggle({
  icon: Icon,
  label,
  hint,
  tone,
  on,
  onChange,
  size,
}: {
  icon: typeof IconEye;
  /** What the mode is called, for anything reading the page aloud. */
  label: string;
  /** The same, plus how to do it from the keyboard, for the tooltip. */
  hint: string;
  tone: ModeTone;
  on: boolean;
  onChange: (on: boolean) => void;
  size: ModeToggleSize;
}) {
  return (
    <Tooltip content={hint}>
      <button
        type="button"
        // A toggle, said out loud: without this a screen reader announces a
        // button that seemingly does nothing, since the effect is a mode change
        // out in the canvas where there is nothing to announce.
        aria-pressed={on}
        aria-label={label}
        onClick={() => onChange(!on)}
        className={[
          "flex items-center justify-center border-2 shadow-hard",
          MODE_TOGGLE_SIZE_CLASS[size],
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          // Outlined on the ink surround while off, exactly as the arrows are:
          // filled chrome here reads as a lit button and undoes the whole point
          // of the colour meaning "on".
          on ? ON_CLASS[tone] : "border-paper/40 bg-transparent text-paper",
        ].join(" ")}
      >
        <Icon size={ICON_SIZE_PX[size]} stroke={2} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

/**
 * Look at things rather than touching them.
 *
 * Held on a keyboard and latched here, and the two are ORed by whoever owns the
 * page — see `bindLookKey`. A momentary key and a sticky button are the right
 * shapes for their respective hands: shift is already under a finger that is on
 * the keys, and a thumb cannot hold anything down while it is also tapping.
 */
export function LookToggle({
  looking,
  onChange,
  size = "touch",
}: {
  looking: boolean;
  onChange: (looking: boolean) => void;
  size?: ModeToggleSize;
}) {
  return (
    <ModeToggle
      icon={IconEye}
      label="Look at things"
      hint="Look at things (hold Shift)"
      tone="look"
      on={looking}
      onChange={onChange}
      size={size}
    />
  );
}

/**
 * Fight whoever you are pointing at, instead of just pointing at them.
 *
 * A latch on both input devices, unlike looking: a fight lasts longer than a
 * hand stays still, and a mode that ended when a key came up would end mid-swing.
 */
export function AttackToggle({
  attacking,
  onChange,
  size = "touch",
}: {
  attacking: boolean;
  onChange: (attacking: boolean) => void;
  size?: ModeToggleSize;
}) {
  return (
    <ModeToggle
      icon={IconSword}
      label="Attack mode"
      hint="Attack your target (E)"
      tone="attack"
      on={attacking}
      onChange={onChange}
      size={size}
    />
  );
}
