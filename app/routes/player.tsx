import { useMemo } from "react";
import { Outlet, useLoaderData, useOutletContext } from "react-router";
import { fetchBootstrap } from "../lib/api";
import { useGameAssets } from "../lib/gameAssets";
import { statusesById } from "../lib/status";
import type { StatusDef } from "../lib/status";
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
 * **Nothing here connects.** The socket belongs to one child — the world — and
 * it is opened as a character, so a tab parked at any of the other screens
 * costs the world nothing: no body on the board, no chunks sent.
 */
export async function clientLoader() {
  return await fetchBootstrap();
}

export function shouldRevalidate() {
  return false;
}

/** What the boot hands its children. @see usePlayerShell */
export type PlayerShell = {
  tiles: TileDef[];
  tilesets: TilesetDef[];
  /**
   * The status catalogue keyed by id, compiled once here rather than per
   * screen: both ends load the same catalogue, and only ids and clocks travel.
   */
  statusDefs: Record<string, StatusDef>;
  /**
   * Whether the tilesets and the label font are in hand.
   *
   * The world refuses to mount a canvas until this is true — see
   * `../lib/gameAssets`, which explains why a world drawn against assets that
   * are still arriving comes up *wrong* rather than late.
   */
  assetsReady: boolean;
};

/** The boot's data, for a screen underneath it. */
export function usePlayerShell(): PlayerShell {
  return useOutletContext<PlayerShell>();
}

export default function PlayerLayout() {
  const { tiles, tilesets, statuses } = useLoaderData<typeof clientLoader>();
  const statusDefs = useMemo(() => statusesById(statuses), [statuses]);
  // Here rather than in the world, so the decode overlaps with whatever
  // somebody is typing on the way in rather than with the wait after they have
  // pressed. The hook does not re-run on a navigation between children: this
  // component never unmounts.
  const assetsReady = useGameAssets(tilesets);

  const shell: PlayerShell = useMemo(
    () => ({ tiles, tilesets, statusDefs, assetsReady }),
    [tiles, tilesets, statusDefs, assetsReady],
  );

  return <Outlet context={shell} />;
}
