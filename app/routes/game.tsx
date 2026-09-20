import { useLoaderData } from "react-router";
import { WorldPage } from "../components/WorldPage";
import { fetchBootstrap } from "../lib/api";
import { onlineLink } from "../net/link";

export async function clientLoader() {
  // The catalogues only. Minting the actor happens on the Log in press — see
  // `../components/LoginScreen` — because that is the moment somebody asked to
  // be in the world, and a tab that never presses it should cost the server
  // nothing.
  return await fetchBootstrap();
}

/**
 * The shared world, which is the front door.
 *
 * Four lines, because the page is `../components/WorldPage` and the only thing
 * this route decides is what it is connected to: a socket to the Bun process,
 * with identity in the `HttpOnly` cookie that rides the upgrade. The world
 * running in a tab is the same page against `../local/link` — see
 * `./admin/play`.
 *
 * **The module is `game.tsx` and not `_index.tsx`.** The build names a route's
 * chunk after its file, and the preview workflow reads the client's protocol
 * version out of that chunk by name; two routes called `_index.tsx` leave that
 * step picking one by luck. `routes.ts` is what says which route is the index.
 */
export default function GamePage() {
  const { tiles, tilesets, statuses } = useLoaderData<typeof clientLoader>();
  return (
    <WorldPage
      link={onlineLink}
      tiles={tiles}
      tilesets={tilesets}
      statuses={statuses}
    />
  );
}
