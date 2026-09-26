/**
 * `100lvh` (not `100%`) keeps the document as tall as the full screen rather
 * than the area above Safari's collapsible toolbar, so the toolbar floats over
 * content instead of leaving a strip of unstyled background behind it.
 * `overflow: hidden` has to come with it: a document taller than the current
 * viewport is one iOS lets you drag, which would scroll the game out of frame.
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
