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
 * It is server-rendered along with the rest of the page, which is the reason it
 * is an element and not a class set from an effect: an effect runs after the
 * first paint, and the first paint is exactly the one that would be cream.
 */

/**
 * On `html` and not `body`, because it is the root element's background that
 * propagates to the canvas — set on the body it would be painted inside the
 * layout, the one place it was never needed.
 *
 * `color-scheme` says the same thing in the browser's own words. It is what
 * darkens the things that take no colour from us: the overscroll gutter, the
 * scrollbars, and the default rendering of any control that has not been given
 * an appearance of its own.
 */
const INK_DOCUMENT_CSS = `html {
  background-color: var(--color-ink);
  color-scheme: dark;
}`;

export function InkDocument() {
  return <style>{INK_DOCUMENT_CSS}</style>;
}
