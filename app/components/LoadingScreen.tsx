/**
 * What stands where the game will be until its assets are all here.
 *
 * It takes the game's own place in the layout rather than covering the page, so
 * the chrome around it — the bar, the clock, the navigation — is there from the
 * first paint and does not jump into position when the world arrives. The one
 * thing it must not do is claim the space *badly*: `h-full w-full` on the same
 * ink the viewport uses means the swap changes what is drawn and nothing else.
 *
 * Typeset in the page's own font, not the world's: the world's is the thing
 * being waited for, and a loading message that itself appears late — which is
 * what `font-display: block` guarantees — is a blank screen with extra steps.
 */
export function LoadingScreen() {
  return (
    <div
      className="flex h-full w-full items-center justify-center bg-ink"
      // A live region rather than a caption, because the interesting moment is
      // the one where it goes away: anything reading the page aloud otherwise
      // announces the world exists at a point of its own choosing.
      role="status"
    >
      <span className="text-xs uppercase tracking-widest text-paper/70">
        Loading…
      </span>
    </div>
  );
}
