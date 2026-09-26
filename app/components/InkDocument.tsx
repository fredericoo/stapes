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
