import { IconSkull } from "@tabler/icons-react";
import { useState } from "react";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Tooltip } from "../ui/Tooltip";
import { ACTION_BUTTON_SIZE_CLASS, type ActionButtonSize } from "./actionButton";
import { useTap } from "./useTap";

/**
 * The switch that says whether you are in the fighting. @see `../game/pvp`
 *
 * **In the row of controls rather than in a menu**, and lit rather than plain,
 * which is the one thing that separates it from the panel buttons beside it:
 * those only open something and this changes what other people can do to you.
 *
 * **One glyph, and the colour is the state.** A skull either way, red once the
 * switch is on: a button that changed its picture as well as its colour would be
 * two controls to learn, and the thing a player has to read at a glance is
 * whether it is *on* rather than which of two drawings is showing.
 *
 * **Frozen mid-fight, and the button says so rather than the press.** Whether
 * the switch may be moved is the session's answer, not this component's — see
 * `../game/GameSession`'s `canSetPvp` — and it arrives on the snapshot beside
 * the state itself. A control that looked pressable and did nothing is exactly
 * the refusal `../game/notices` is written against, so it is drawn disabled and
 * the tooltip says which fight is holding it.
 */
/**
 * What a press on the switch asks for. @see pvpPress
 *
 * - `"explain"` — put the dialog up and wait. Nothing has changed yet.
 * - `"stop"` — turn it off, with nothing to confirm.
 * - `"nothing"` — the body is in a fight, and the button is drawn disabled.
 */
export type PvpPress = "explain" | "stop" | "nothing";

/**
 * What pressing the button means, which is not symmetric.
 *
 * **Only the way in is explained.** Turning it on is the press that changes
 * what strangers can do to you, and a player who has just found a new button
 * should not discover what it meant by being killed. Turning it *off* asks
 * nothing: backing out of violence needs no warning, and a dialog between a
 * player and the one press that makes them safe is a dialog in the way.
 *
 * Its own function rather than a branch inside the handler, on
 * `./SpellBar`'s `spellAppearance` terms: it is the decision the component is
 * about, and the rest of the file is React.
 */
export function pvpPress(on: boolean, changeable: boolean): PvpPress {
  if (!changeable) return "nothing";
  return on ? "stop" : "explain";
}

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
  /** Whether the explanation is up. @see pvpPress */
  const [asking, setAsking] = useState(false);

  // Pointer-driven rather than click-driven, so the row still answers a thumb
  // that is holding the d-pad down. See `./useTap`.
  const tap = useTap(() => {
    const press = pvpPress(on, changeable);
    if (press === "stop") onChange(false);
    if (press === "explain") setAsking(true);
  });

  const label = on ? "Fighting other players" : "Not fighting other players";

  return (
    <>
      <Tooltip
        content={changeable ? label : `${label} — cannot change during a fight`}
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
            // The world's danger colour, because that is what it means — where
            // the panel buttons beside it are deliberately plain paper, a
            // promise they keep by changing nothing out there.
            on
              ? "border-danger bg-danger text-paper"
              : "border-paper/40 bg-transparent text-paper",
            changeable ? "" : "opacity-40",
          ].join(" ")}
        >
          <IconSkull
            size={size === "touch" ? 24 : 18}
            stroke={2}
            aria-hidden="true"
          />
        </button>
      </Tooltip>

      {/* What the press means, in the words of what it lets happen to you. The
          three lines are the three things that surprise people: that it takes
          two, that creatures are not in it, and that it cannot be undone while
          somebody is swinging. */}
      <Dialog
        open={asking}
        onOpenChange={setAsking}
        title="Fight other players?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setAsking(false);
                onChange(true);
              }}
            >
              Fight
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm">
          <p>
            Other players will be able to attack you, curse you and burn you,
            and you will be able to do the same to them. Your name is marked so
            everybody can see it.
          </p>
          <p>
            It takes two: nothing passes between you and somebody who has not
            turned this on as well.
          </p>
          <p>
            Creatures are unaffected — they fight you either way.
          </p>
          <p>
            You can turn it off again whenever you are out of a fight, but not
            during one.
          </p>
        </div>
      </Dialog>
    </>
  );
}
