import type { TileDef } from "./types";

export type DialogTextPart = { kind: "text"; text: string } | { kind: "item"; tileId: string };

const ITEM_MENTION = /\{item:([^{}\s]+)\}/g;

/** Splits a line or a button label at each `{item:<tile id>}` it holds. */
export function dialogTextParts(text: string): DialogTextPart[] {
  if (!text.includes("{item:")) return text === "" ? [] : [{ kind: "text", text }];
  const parts: DialogTextPart[] = [];
  let from = 0;
  for (const match of text.matchAll(ITEM_MENTION)) {
    if (match.index > from) parts.push({ kind: "text", text: text.slice(from, match.index) });
    parts.push({ kind: "item", tileId: match[1]! });
    from = match.index + match[0].length;
  }
  if (from < text.length) parts.push({ kind: "text", text: text.slice(from) });
  return parts;
}

export function mentionedTileIds(text: string): string[] {
  const ids: string[] = [];
  for (const part of dialogTextParts(text)) {
    if (part.kind === "item" && !ids.includes(part.tileId)) ids.push(part.tileId);
  }
  return ids;
}

/** The text with each mention replaced by the item's name, for speech and screen readers. */
export function dialogPlainText(text: string, tilesById: Record<string, TileDef>): string {
  return dialogTextParts(text)
    .map((part) =>
      part.kind === "text" ? part.text : (tilesById[part.tileId]?.name ?? part.tileId),
    )
    .join("");
}

const ASCII_FOR: Record<string, string> = {
  "—": "-",
  "–": "-",
  "…": "...",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "×": "x",
};

const NOT_IN_PIXEL_FONT = new RegExp(`[${Object.keys(ASCII_FOR).join("")}]`, "g");

/**
 * The bubble's font draws ASCII only, and anything else falls back to a face
 * with other metrics, so the punctuation authors type is swapped for its
 * ASCII spelling before the text is drawn.
 */
export function pixelFontText(text: string): string {
  return text.replace(NOT_IN_PIXEL_FONT, (char) => ASCII_FOR[char] ?? char);
}
