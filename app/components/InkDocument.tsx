/**
 * Paints the document itself ink, for as long as it is on the page.
 *
 * The play pages fill the window with dark chrome, so none of the document's
 * own colour is *inside* the layout. But a browser paints the canvas around
 * that layout in the background it took from the root element, and that is the
 * cream the editor pages are made of: on iOS Safari it comes out as the pale
 * band under a rubber-band scroll and the strip behind the toolbar, which is a
 * light grey frame around a black game. `theme-color` in `../root.tsx` tints the
 * browser's own furniture and cannot reach the page canvas; this is the other
 * half of that.
 *
 * **A stylesheet the page carries, rather than a rule keyed off the page's
 * shape.** `html:has(.game-surface)` in `app.css` says the same thing in one
 * line, and asks the browser to re-check an ancestor of everything every time
 * anything is added to or removed from the document — which here is a render
 * loop writing labels into the world every frame. A style element mounts with
 * the route, unmounts with it, and costs nothing in between.
 *
 * It is an element rather than a class set from an effect because it lands with
 * the route's own first paint, where an effect runs after one — and that paint
 * is exactly the one that would be cream.
 *
 * **It does not cover the wait in front of that paint.** There is no server
 * rendering here, and this mounts with the page component, which React Router
 * does not render until `clientLoader` has been to the server and back. The
 * loading screen in that gap paints itself ink over the game's own slot; the
 * document behind it is still whatever the last route left, so a cold load of
 * this page has a cream document for as long as the map takes to arrive. The
 * honest fix is a default at the document level rather than a later override
 * here, which is a bigger change than the bands were worth.
 */

/**
 * Both elements, and the second one is not redundant.
 *
 * `html` is the one that propagates to the canvas, which is the overscroll
 * gutter and everything outside the layout. `body` matters because `app.css`
 * paints it `bg-paper` for the editor pages and nothing here was overriding it:
 * the body box is the whole viewport, so on a game page the cream was still
 * being painted across all of it and only hidden by whatever chrome happened to
 * cover those pixels. Under `viewport-fit=cover` the safe-area bands are pixels
 * nothing covers, which is where it showed.
 *
 * `color-scheme` says the same thing in the browser's own words. It is what
 * darkens the things that take no colour from us: the overscroll gutter, the
 * scrollbars, and the default rendering of any control that has not been given
 * an appearance of its own.
 *
 * **`100lvh` is what makes the page as tall as the screen rather than as tall as
 * the gap above the toolbar.** `app.css` sizes the document at `height: 100%`,
 * which on iOS is the viewport Safari is currently showing — so the layout ended
 * where the toolbar began and the strip behind the toolbar was a band of ink
 * nothing could use. The large viewport is the screen with the toolbars
 * retracted, so the reading column runs the whole way down and the toolbar
 * floats over its last rows, which `.scrolls-past-toolbar` lets you scroll clear
 * of. `min-height` rather than `height`, so this can only ever add to whatever
 * `app.css` worked out.
 *
 * Which is also why `overflow: hidden` comes with it and must: a document taller
 * than the viewport is a document iOS will let you drag, and dragging this one
 * scrolls the game out of the frame. Nothing here wants the page to scroll —
 * every scrolling surface in the game is an inner one — so refusing it costs
 * nothing and closes the hole `100lvh` would otherwise open.
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
