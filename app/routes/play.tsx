import { useState } from "react";
import { type Destination, MenuRow } from "../components/AppShell";
import { WorldPage } from "../components/WorldPage";
import { localLink } from "../local/link";
import { usePlayerShell } from "./player";

/**
 * The menu's way to the shared world. `/` sends a visitor with no account to
 * the sign-in screen, and a signed-in one to their character.
 */
const ONLINE_DESTINATIONS: Destination[] = [{ to: "/", label: "Play online" }];

/**
 * The game with no account, against a world running in this tab.
 *
 * **This is the online route, connected differently, and nothing else.** The
 * page is `../components/WorldPage`, the protocol is `app/net/protocol.ts`, and
 * the simulation is `server/GameServer.ts`. All three are shared with `/` and
 * none of them is stubbed. The difference is that the far end of the wire is a
 * worker instead of a machine: no socket, no account, and no server running
 * the world.
 *
 * It has two uses. A visitor who wants to see the game before making an
 * account opens it from the sign-in screen. And somebody hand-testing a change
 * to the world does not have to sign in and pick a character first. Online
 * stays the path the sign-in screen recommends. This one is the alternative.
 *
 * **Everything expensive loads only here.** `../local/link` and the worker it
 * starts are imported by this route and nothing else, so they are in this
 * route's chunk and the worker's. The worker downloads the whole authored map
 * over `GET /api/map` when the world first opens. Online play never imports
 * either one and never fetches the whole map.
 *
 * The player is seated as an administrator, so `/goto`, `/tile` and the other
 * commands work. Chat goes to the world in the worker and back, so a visitor
 * can talk, but only to themselves. @see ../local/LocalWorld
 *
 * @see ../local/link
 * @see docs/notes.md, "`/play` runs the server in the tab"
 */
export default function PlayPage() {
  const { tiles, tilesets, statuses } = usePlayerShell();
  return (
    <WorldPage
      link={localLink}
      tiles={tiles}
      tilesets={tilesets}
      statuses={statuses}
      destinations={ONLINE_DESTINATIONS}
      menuExtras={
        <MenuRow label="World">
          <ResetWorldButton />
        </MenuRow>
      }
    />
  );
}

/**
 * Throw this world away and start again on the authored map.
 *
 * `POST /api/reset` is the same act online and is behind `ADMIN_SECRET`,
 * because that world is everybody's. This one is yours, and a testing path
 * whose only way back to a known state is clearing site data is a testing path
 * people stop using.
 *
 * Asks first, and asks in place rather than in a dialog: it destroys every
 * position, kit, reward and mastery in the world, and it sits in a menu beside
 * a lighting switch that does not. The press that confirms it is the press that
 * does it, so there is nothing to undo.
 */
function ResetWorldButton() {
  const [asking, setAsking] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        if (!asking) return setAsking(true);
        setAsking(false);
        void localLink.reset?.();
      }}
      onBlur={() => setAsking(false)}
      className="border-2 border-paper/40 px-2 py-1 text-xs uppercase text-paper hover:border-paper"
    >
      {asking ? "Sure? Everything goes" : "Reset world"}
    </button>
  );
}
