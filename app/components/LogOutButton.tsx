import { IconLogout } from "@tabler/icons-react";
import { useState } from "react";
import { Button, Dialog } from "../ui";

/**
 * The way back out of the world, in the menu the lighting switch is in.
 *
 * **It leaves the character, not the account.** All it does is close the socket
 * and put the door back up — see `../routes/game`. The actor cookie stays, so
 * logging in again is the same body, standing where it was left. That is the
 * shape the account system will keep: the cookie becomes the account, and this
 * comes back to a character selection screen rather than signing anybody out.
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
export function LogOutButton({
  inCombat,
  onLogOut,
}: {
  /** Whether the engine's `combat` status is running on this player's body. */
  inCombat: boolean;
  onLogOut: () => void;
}) {
  const [asking, setAsking] = useState(false);

  return (
    <>
      <Button
        variant="ghost-inverse"
        size="sm"
        onClick={() => (inCombat ? setAsking(true) : onLogOut())}
      >
        <IconLogout size={16} stroke={2} aria-hidden="true" />
        Log out
      </Button>
      <Dialog
        open={asking}
        onOpenChange={setAsking}
        title="Log out mid-fight"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAsking(false)}>
              Stay
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setAsking(false);
                onLogOut();
              }}
            >
              Log out
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
