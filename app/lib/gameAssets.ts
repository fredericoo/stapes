import { useEffect, useState } from "react";
import type { TilesetDef } from "./types";

/**
 * Everything that has to be in hand before the world is allowed on screen.
 *
 * The game does not degrade gracefully while its assets arrive — it comes up
 * *wrong* and stays that way, which is worse than coming up late.
 *
 * The tell was a name tag sitting a few pixels left of the head it belonged to
 * on a cold load and correctly on every reload afterwards. Names are placed by
 * measuring the box the browser made and centring it on the anchor
 * (`../render/labelLayout`), and that measurement is *held* — text is the only
 * thing that invalidates it, because text is the only thing that normally
 * changes it. On a cold load the pixel font has not arrived yet, so the first
 * measurement is of the fallback face at the wrong metrics, and the label spends
 * the rest of the session centred on a width it no longer has. Second load, the
 * font is in the disk cache, the first measurement is right, and the bug is
 * gone — which is exactly the shape of a bug that survives being looked for.
 *
 * So nothing is drawn until the assets are all here. That is a stronger promise
 * than the one bug needs and deliberately so: it is one rule to hold in your
 * head — the world is not drawn against assets that are still arriving — rather
 * than an invalidation per asset per consumer, each of which is a thing to
 * remember when the next asset type is added.
 *
 * Two things are waited for.
 *
 * - **The label font**, which has to be asked for explicitly. `document.fonts`
 *   only knows about faces something has already tried to typeset in, and the
 *   only thing on the page in this one is the world's own text — which does not
 *   exist yet, because it is what is being waited for. `fonts.ready` alone would
 *   resolve immediately and prove nothing.
 * - **Every tileset**, including the ones this map never places. The set is
 *   small and authored by hand, and the alternative is deciding which tiles the
 *   map can reach — a question whose answer changes with an editor save.
 *
 * This is only the first of two waits the loading screen covers. The renderer
 * fetches the tilesets a second time on its own account — it needs them as GPU
 * textures, not as decoded images — and paints nothing until it has them, so a
 * page holds its loading screen until `setOnFirstFrame` says there is a world
 * on the canvas. What this gate buys is that the second fetch is served warm.
 */

/**
 * The face named in `app/app.css`. Kept in sync by hand, which is what a
 * `@font-face` rule costs: the family name is a string on both sides and there
 * is nowhere to hold it that both a stylesheet and a module can read.
 */
const WORLD_LABEL_FONT_FAMILY = "NF Pixels";

/**
 * A size for the font shorthand `fonts.load` insists on. Which size is asked
 * for does not matter — the family is what selects the face, and there is one —
 * so this deliberately does not chase `--world-label-size`.
 */
const FONT_PROBE = `20px "${WORLD_LABEL_FONT_FAMILY}"`;

/**
 * How long the loading screen may hold the game back.
 *
 * A cap rather than a promise of correctness: a request that never settles is a
 * game that never starts, and a misplaced name tag is a far smaller failure than
 * a black square. `../render/textLabels` re-measures when a font finishes
 * arriving late, which is what makes this escape hatch survivable rather than
 * permanent.
 */
const ASSET_TIMEOUT_MS = 10_000;

/**
 * Whether the world may be drawn yet.
 *
 * False on the server and on the first client render, so a route can simply not
 * mount its canvas until this says otherwise — see the loading screen in
 * `../components/LoadingScreen`.
 */
export function useGameAssets(tilesets: TilesetDef[]): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    void loadGameAssets(tilesets).then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [tilesets]);

  return ready;
}

/**
 * Resolves when everything is here, or when waiting has stopped being worth it.
 *
 * Never rejects. Every asset is allowed to fail on its own — a tileset that
 * 404s is already drawn as magenta by the renderer, and a font that will not
 * load is a label in the fallback face — and neither is a reason to keep the
 * player on a loading screen for the one that is fine.
 */
async function loadGameAssets(tilesets: TilesetDef[]): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ASSET_TIMEOUT_MS);
  });

  try {
    await Promise.race([
      Promise.all([
        settle(loadLabelFont()),
        ...tilesets.map((tileset) => settle(loadTileset(tileset))),
      ]),
      expired,
    ]);
  } finally {
    // Or the tab holds a timer for the rest of the cap on every load that beat
    // it, which is every load.
    clearTimeout(timer);
  }
}

/**
 * This one face, and deliberately not `document.fonts.ready`.
 *
 * `ready` waits for everything the page has in flight, which here includes the
 * chrome's IBM Plex Mono — a third-party download that the world's labels do
 * not depend on in any way. Waiting on it would put the game's first frame
 * behind Google's CDN to no end. `load` resolves against the faces it matched,
 * which is exactly the one thing measuring a label needs.
 */
async function loadLabelFont(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  // The explicit ask, without which nothing would have requested the face.
  await document.fonts.load(FONT_PROBE);
}

/**
 * Fetched *and decoded*, which is the difference between an image the browser
 * has and one it can draw. `decode` is what keeps the first upload to the GPU
 * off the frame that was supposed to be the first frame.
 */
async function loadTileset(tileset: TilesetDef): Promise<void> {
  const image = new Image();
  image.src = `/tilesets/${tileset.file}`;
  await image.decode();
}

/** A failure is one asset's problem, not the loading screen's. */
async function settle(work: Promise<void>): Promise<void> {
  try {
    await work;
  } catch (err) {
    console.warn("asset failed to load", err);
  }
}
