import { LoadingScreen } from "./LoadingScreen";
import { Button } from "../ui";

/**
 * What stands over the whole page once this player has been killed.
 *
 * It **darkens rather than replaces**, and that is the one decision this
 * component makes. The world behind it is the last frame the server sent — the
 * body gone from the cell, the kit lying in it — and that frame is the answer
 * to "what happened", so covering it would be taking away the only thing on
 * screen worth reading. It sits over the page's chrome as well as its canvas,
 * because the clock and the headcount are equally not this player's business
 * for as long as they have no body.
 *
 * The blocking is not done here. The page marks everything underneath `inert`,
 * which is what actually takes the game out of reach: a panel dimmed by an
 * overlay is still tabbable, and a button that is merely hard to hit is a
 * button somebody hits. This is the visible half of that.
 *
 * `role="alertdialog"` rather than `dialog`: it arrives unrequested and in
 * response to something that happened, which is the whole distinction between
 * the two — anything reading the page aloud should say so on the spot rather
 * than waiting to be asked.
 *
 * @param pending whether Rebirth has been pressed and the body has not arrived.
 *   See the loading screen below for why that is a state this screen has rather
 *   than something the button shows.
 */
export function DeathScreen({ onRebirth, pending }: { onRebirth: () => void; pending: boolean }) {
  // A press is answered by the server with a whole `hello`, which is a round
  // trip plus a fresh map plus the frame that rebuilds every chunk of it — long
  // enough that a button which merely stopped responding reads as a button that
  // did not take. So the wait is the wait this page already has: the same
  // loading screen the tab opened on, which is what the player is owed anyway,
  // since what is behind this screen is about to be replaced outright.
  //
  // Full-page like the screen it replaces rather than over the canvas alone,
  // for the reason the death screen covers the chrome: the clock and the
  // headcount are still not this player's business until they have a body. It
  // also has to be *here* rather than beside the game, because the page marks
  // everything under this screen `inert` — and an inert live region is one
  // nothing reads aloud.
  if (pending) {
    return (
      <div className="fixed inset-0 z-50">
        <LoadingScreen />
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/75 p-6"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="death-screen-title"
    >
      {/* A panel under the words rather than the words alone. What is behind
          them is a game — a name tag, a row of toolbar buttons — and without
          this the Rebirth button lands inside that row on a narrow screen and
          reads as one more tool. Small enough that the map and the panels are
          still there around it, which is the whole point of darkening rather
          than covering. */}
      <div className="flex flex-col items-center gap-6 border-2 border-paper bg-ink px-8 py-7">
        <h2
          id="death-screen-title"
          className="text-center text-2xl font-bold tracking-wide uppercase text-paper"
        >
          You have died.
        </h2>
        <Button
          variant="primary"
          // Focus goes here on the frame the screen appears, which is the only
          // reachable control on the page: everything else is inert, so a
          // keyboard left where it was would be pointed at nothing.
          autoFocus
          onClick={onRebirth}
        >
          Rebirth
        </Button>
      </div>
    </div>
  );
}
