import { useState } from "react";
import { useLoaderData } from "react-router";
import { ADMIN_DESTINATIONS } from "../../components/AppShell";
import { WorldPage } from "../../components/WorldPage";
import { fetchBootstrap } from "../../lib/api";
import { localLink } from "../../local/link";

export async function clientLoader() {
  // The same catalogues the game loads, for the same reason: the renderer needs
  // them and the world reads its own copy. Nothing here opens a world — the
  // Log in press does, exactly as it does on `/`.
  return await fetchBootstrap();
}

/**
 * The same game, against a world running in this tab.
 *
 * **This is the online route, connected differently, and nothing else.** The
 * page is `../../components/WorldPage`, the protocol is `app/net/protocol.ts`,
 * the simulation is `server/GameServer.ts` — all three shared with `/`, none of
 * them stubbed. What is different is that the far end of the wire is a worker
 * instead of a machine: no socket, no account, no server to be running.
 *
 * That is what it is for. `/` is growing a login, and hand-testing a change to
 * the world should not mean hand-testing the way in to it first. This is the
 * path to open when the question is "does the game still work".
 *
 * @see ../../local/link
 * @see docs/notes.md, "`/admin/play` runs the server in the tab"
 */
export default function PlayPage() {
  const { tiles, tilesets, statuses } = useLoaderData<typeof clientLoader>();
  return (
    <WorldPage
      link={localLink}
      tiles={tiles}
      tilesets={tilesets}
      statuses={statuses}
      destinations={ADMIN_DESTINATIONS}
      menuExtras={<ResetWorldButton />}
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
