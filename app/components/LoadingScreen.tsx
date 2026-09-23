/**
 * What stands over the game until there is a world on the canvas.
 *
 * It covers the game's own slot rather than the page, so the chrome around it —
 * the bar, the clock, the navigation — is there from the first paint and does
 * not jump into position when the world arrives. It stays up through two
 * separate waits, which is why it overlays rather than replaces: first the
 * assets (`../lib/gameAssets`), then the renderer's first frame, since the
 * world is not painted until its tilesets are on the GPU. Taking it down on the
 * first of those alone shows an empty canvas in the gap.
 *
 * **Typeset in a font that is already on the machine**, which is the one rule
 * this screen has. Both of the page's own faces are downloads — the pixel font
 * the world uses and the mono the chrome uses — so a loading message set in
 * either is a message that cannot be read until roughly the moment it stops
 * being needed. `font-display: block` makes that literal for the pixel font:
 * invisible text on a black square.
 *
 * The crystal above the text is a download too, which is why it sits beside
 * the message rather than replacing it. It is 1.7 KB and usually lands first,
 * but the text does not wait for it. `width` and `height` reserve its box, so
 * the text does not move down when it arrives.
 */

/**
 * The system's own monospace, named rather than inherited from the theme.
 * `font-sans` here would be IBM Plex Mono, which is fetched from Google Fonts —
 * exactly the dependency this screen must not have.
 */
const SYSTEM_MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

export function LoadingScreen() {
  return (
    <div
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-ink"
      // A live region rather than a caption, because the interesting moment is
      // the one where it goes away: anything reading the page aloud otherwise
      // announces the world exists at a point of its own choosing.
      role="status"
    >
      <img
        // Rendered by `bun run generate:spinner`, at 32px; shown at 2x.
        src="/crystal-spinner.gif"
        // Decorative: the text beside it is what the live region announces.
        alt=""
        width={64}
        height={64}
        style={{ imageRendering: "pixelated" }}
      />
      <span
        className="text-xs uppercase tracking-widest text-paper/70"
        style={{ fontFamily: SYSTEM_MONO }}
      >
        Loading…
      </span>
    </div>
  );
}
