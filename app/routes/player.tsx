import { Outlet, useLoaderData, useOutletContext } from "react-router";
import { fetchBootstrap } from "../lib/api";
import { useGameAssets } from "../lib/gameAssets";
import type { TileDef, TilesetDef } from "../lib/types";

/**
 * Everything a player sees, and the one thing all of it needs.
 *
 * The screens under here are small and there are six of them — sign in, sign
 * up, the character chooser, naming a character, changing a password, and the
 * world — because each of them is one question, with its own loader saying what
 * it needs and its own redirect when that is missing. What they share is the
 * *boot*: the tile, tileset and status catalogues, and the decode of every
 * tileset image.
 *
 * **That is why this is a layout and not a helper.** A layout's loader runs
 * once and its component stays mounted across every navigation between its
 * children, so the catalogues are fetched once per tab and the tilesets are
 * decoded once per tab — while somebody is still typing a username. By the time
 * a character is pressed there is nothing left to fetch, which is the property
 * the single does-it-all route had by accident and this keeps on purpose.
 *
 * `shouldRevalidate` is off because none of it can change under a player:
 * authored content changes when an author saves, and a save replaces the world
 * and pushes a fresh `hello` rather than expecting the page to re-fetch.
 *
 * **The decode is started here and waited for in `WorldPage`.** This one does
 * not pass `assetsReady` down: `WorldPage` asks for itself, so it does not depend
 * on which layout it is drawn under, and `useGameAssets` remembers the lists it
 * has settled so the second ask is free. @see ../lib/gameAssets
 *
 * **Nothing here connects.** The socket belongs to one child — the world — and
 * it is opened as a character. `/play` is the other child that draws a world,
 * and it connects to a worker in the tab rather than to the server, so a tab parked at any of the other screens
 * costs the world nothing: no body on the board, no chunks sent.
 */
export async function clientLoader() {
  return await fetchBootstrap();
}

export function shouldRevalidate() {
  return false;
}

/** The catalogues, for a screen underneath. @see usePlayerShell */
export type PlayerShell = {
  tiles: TileDef[];
  tilesets: TilesetDef[];
  /** Raw, because `WorldPage` compiles them. */
  statuses: unknown[];
};

export function usePlayerShell(): PlayerShell {
  return useOutletContext<PlayerShell>();
}

export default function PlayerLayout() {
  const shell = useLoaderData<typeof clientLoader>();
  // Started here rather than in the world, so the decode overlaps with whatever
  // somebody is typing on the way in rather than with the wait after they have
  // pressed. The answer is not used on this screen — there is nothing to draw —
  // and the hook does not re-run on a navigation between children, because this
  // component never unmounts.
  useGameAssets(shell.tilesets);

  return <Outlet context={shell} />;
}
