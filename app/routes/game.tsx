import { redirect, useLoaderData, useNavigate } from "react-router";
import { WorldPage } from "../components/WorldPage";
import { fetchMe } from "../lib/auth";
import { forgetCharacter, resolveRemembered } from "../lib/playing";
import { onlineLink } from "../net/link";
import { usePlayerShell } from "./player";

/**
 * The shared world, as whichever character this tab chose.
 *
 * **The route decides who, and nothing else.** The page is
 * `../components/WorldPage` and the connection is `../net/link`'s
 * `onlineLink`; what is left here is the two preconditions the world cannot
 * start without, and where somebody goes when one is missing.
 *
 * No session is the front door. A session with no character chosen — a fresh
 * tab, or one whose character was deleted — is the chooser. Rendering a world
 * for neither would be a canvas with no body to centre on.
 *
 * The catalogues are not fetched here: `./player` has them, and had them while
 * somebody was still typing a username.
 *
 * **The module is `game.tsx` and not `_index.tsx`.** The build names a route's
 * chunk after its file, and the preview workflow reads the client's protocol
 * version out of that chunk by name; two routes called `_index.tsx` leave that
 * step picking one by luck. `routes.ts` is what says which route is the index.
 */
export async function clientLoader() {
  const me = await fetchMe();
  if (!me.user) throw redirect("/sign-in");
  const character = resolveRemembered(me.characters);
  if (!character) throw redirect("/characters");
  return { character };
}

export default function GamePage() {
  const { character } = useLoaderData<typeof clientLoader>();
  const { tiles, tilesets, statuses } = usePlayerShell();
  const navigate = useNavigate();

  /**
   * Take this character out of the world, keeping the account signed in.
   *
   * Forgetting the choice and navigating away is the whole of it: this route
   * unmounts and the page's connection goes with it, which takes the renderer,
   * the session and this player's body out of the world.
   *
   * **The session is deliberately left alone.** Leaving the world is not
   * signing out — those are two different things in this game, and this is the
   * first of them. It is how somebody swaps to another of their three, and
   * coming back to the one they left is the same body standing where it was.
   * @see ../components/LeaveWorldButton
   */
  const leave = () => {
    forgetCharacter();
    void navigate("/characters");
  };

  return (
    <WorldPage
      // Keyed by the character, so swapping to another of the account's three
      // is a fresh page rather than a live world handed a different body. The
      // connection is opened on mount and there is no path that re-opens one in
      // place.
      key={character.id}
      link={onlineLink}
      tiles={tiles}
      tilesets={tilesets}
      statuses={statuses}
      onLeave={leave}
      // The world refused this character — an expired session, or one that is
      // no longer this account's. The chooser's own loader asks who this
      // browser is now and sends it to the front door if the answer is nobody,
      // so one redirect decides, and it is the one whose job that already is.
      onRefused={leave}
    />
  );
}
