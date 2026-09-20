import { IconDoorExit } from "@tabler/icons-react";
import { useState } from "react";
import { Button, Dialog } from "../ui";

/**
 * The way back out of the world, in the menu the lighting switch is in.
 *
 * **A character leaves the world; it does not sign out.** Those are two
 * different things in this game and the words are kept apart everywhere: you
 * sign in and out of an *account*, and a *character* enters and leaves. All
 * this does is close the socket and put the character chooser back up — see
 * `../routes/game` — so it is how somebody swaps to another of their three, and
 * coming back to the one they left is the same body standing where it was.
 *
 * **Signing out is deliberately not here at all**, and not just further away:
 * it is on the chooser, because that is the screen the account lives on. A
 * menu offering both would be the one place teaching people the two words mean
 * the same thing — and on an account with no password recovery, being signed
 * out is a state worth having to ask for.
 *
 * So it asks nothing in the ordinary case. A confirmation on an act you can
 * undo by pressing the button beside it teaches people to click through the
 * confirmation that matters.
 *
 * **The one that matters is leaving mid-fight.** A body in combat does not go
 * with its socket: it stands there, idle and hittable, until the minute since
 * the last blow runs out — see `docs/notes.md`, "Closing the tab does not end a
 * fight". That is worth a sentence beforehand, because what the player is
 * walking away from is a body somebody else can still kill, and they will not
 * be there to see it happen.
 */
export function LeaveWorldButton({
  inCombat,
  onLeave,
}: {
  /** Whether the engine's `combat` status is running on this player's body. */
  inCombat: boolean;
  onLeave: () => void;
}) {
  const [asking, setAsking] = useState(false);

  return (
    <>
      <Button
        variant="ghost-inverse"
        size="sm"
        onClick={() => (inCombat ? setAsking(true) : onLeave())}
      >
        <IconDoorExit size={16} stroke={2} aria-hidden="true" />
        Leave world
      </Button>
      <Dialog
        open={asking}
        onOpenChange={setAsking}
        title="Leave mid-fight"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAsking(false)}>
              Stay
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setAsking(false);
                onLeave();
              }}
            >
              Leave
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed">
          You are in a fight, so your body stays in the world until the fight is
          over — about a minute after the last blow lands. It stands still while
          it is there, and anything aimed at it still hits, with everything you
          are carrying on it.
        </p>
      </Dialog>
    </>
  );
}
