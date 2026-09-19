import { IconShield, IconSwords } from "@tabler/icons-react";
import { Tooltip } from "../ui/Tooltip";
import { ACTION_BUTTON_SIZE_CLASS, type ActionButtonSize } from "./actionButton";
import { useTap } from "./useTap";

/**
 * The switch that says whether you are in the fighting. @see `../game/pvp`
 *
 * **In the row of controls rather than in a menu**, and lit rather than plain,
 * which is the one thing that separates it from the panel buttons beside it:
 * those only open something and this changes what other people can do to you.
 * On, it is the state worth noticing and reads as one — the same reversal the
 * bag button's "full" badge uses.
 *
 * **Frozen mid-fight, and the button says so rather than the press.** Whether
 * the switch may be moved is the session's answer, not this component's — see
 * `../game/GameSession`'s `canSetPvp` — and it arrives on the snapshot beside
 * the state itself. A control that looked pressable and did nothing is exactly
 * the refusal `../game/notices` is written against, so it is drawn disabled and
 * the tooltip says which fight is holding it.
 */
export function PvpToggle({
  on,
  changeable,
  onChange,
  size = "touch",
}: {
  on: boolean;
  /** Whether this body is out of the fighting long enough to change its mind. */
  changeable: boolean;
  onChange: (on: boolean) => void;
  size?: ActionButtonSize;
}) {
  // Pointer-driven rather than click-driven, so the row still answers a thumb
  // that is holding the d-pad down. See `./useTap`.
  const tap = useTap(() => {
    if (changeable) onChange(!on);
  });

  const label = on ? "Fighting other players" : "Not fighting other players";
  const Icon = on ? IconSwords : IconShield;

  return (
    <Tooltip
      content={
        changeable ? label : `${label} — cannot change during a fight`
      }
    >
      <button
        type="button"
        aria-pressed={on}
        aria-label={label}
        disabled={!changeable}
        {...tap}
        className={[
          "flex items-center justify-center border-2 shadow-hard",
          ACTION_BUTTON_SIZE_CLASS[size],
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          // The world's danger colour, because that is what it means — where the
          // panel buttons beside it are deliberately plain paper, a promise they
          // keep by changing nothing out there.
          on
            ? "border-danger bg-danger text-paper"
            : "border-paper/40 bg-transparent text-paper",
          changeable ? "" : "opacity-40",
        ].join(" ")}
      >
        <Icon size={size === "touch" ? 24 : 18} stroke={2} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
