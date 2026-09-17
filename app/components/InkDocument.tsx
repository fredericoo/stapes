/**
 * Paints the document itself ink, for as long as it is on the page.
 *
 * The play pages fill the window with dark chrome, but a browser paints the
 * canvas around the layout in the root element's background, which is the
 * editor pages' cream: on iOS Safari that shows as the band under a
 * rubber-band scroll and the strip behind the toolbar. `theme-color` in
 * `../root.tsx` tints the browser's own furniture and cannot reach the page
 * canvas.
 *
 * A stylesheet the page carries rather than `html:has(.game-surface)` in
 * `app.css`: `:has` on an ancestor of everything is re-checked every time the
 * document changes, and the render loop writes labels into the world every
 * frame. A style element costs nothing between mount and unmount.
 *
 * An element rather than a class set from an effect because it lands with the
 * route's first paint, where an effect runs after one.
 *
 * It does not cover the wait in front of that paint. This mounts with the page
 * component, which React Router does not render until `clientLoader` has
 * returned, so a cold load has a cream document until the map arrives. The
 * fix is a default at the document level, which is a bigger change than the
 * bands are worth.
 */

/**
 * `html` propagates to the canvas outside the layout. `body` matters because
 * `app.css` paints it `bg-paper`, and under `viewport-fit=cover` the safe-area
 * bands are body pixels nothing covers.
 *
 * `color-scheme` darkens what takes no colour from us: the overscroll gutter,
 * the scrollbars, and any control without an appearance of its own.
 *
 * `100lvh` makes the page as tall as the screen rather than the gap above the
 * toolbar: `app.css` sizes the document at `height: 100%`, which on iOS is the
 * viewport Safari is currently showing, so the strip behind the toolbar was
 * unusable. The toolbar floats over the last rows, which
 * `.scrolls-past-toolbar` lets you scroll clear of. `min-height` rather than
 * `height`, so this only adds to what `app.css` worked out.
 *
 * `overflow: hidden` must come with it: iOS lets you drag a document taller
 * than the viewport, and dragging this one scrolls the game out of the frame.
 * Every scrolling surface in the game is an inner one.
 */
const INK_DOCUMENT_CSS = `html, body {
  background-color: var(--color-ink);
}
html {
  color-scheme: dark;
}
html, body, #root {
  min-height: 100lvh;
}
html, body {
  overflow: hidden;
}`;

export function InkDocument() {
  return <style>{INK_DOCUMENT_CSS}</style>;
}
