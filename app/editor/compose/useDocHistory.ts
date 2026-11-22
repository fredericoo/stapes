import { useCallback, useEffect, useRef, useState } from "react";
import { parseMapDoc, type MapDoc } from "./doc";

const STORAGE_KEY = "stapes:compose:v2";
const MAX_UNDO = 200;

type History = { past: MapDoc[]; present: MapDoc; future: MapDoc[] };

/** An unsaved tree, with the world's tree it was edited from. */
type Draft = { base: string; doc: unknown };

/**
 * The tree this browser was editing, if it was edited from `base`. A draft of
 * an older tree is dropped: somebody saved since, and opening it would offer
 * to put their save back.
 */
function readDraft(base: string): MapDoc | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as Draft;
    if (draft.base !== base) return null;
    const parsed = parseMapDoc(draft.doc);
    return parsed.ok ? parsed.doc : null;
  } catch {
    return null;
  }
}

function writeDraft(base: string, doc: MapDoc) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ base, doc } satisfies Draft));
  } catch {
    /** A private window or a full quota keeps the tree for this visit only. */
  }
}

/**
 * The tree with undo and redo, kept in this browser between visits until it
 * is saved. `base` is the world's tree as the server sent it. A drag
 * sends many `preview`s and one `settle`, so it is one step of undo however
 * far it went: the first preview remembers where the drag started, and the
 * settle files that as the step.
 */
export function useDocHistory(base: string, initial: () => MapDoc) {
  const [history, setHistory] = useState<History>(() => ({
    past: [],
    present: readDraft(base) ?? initial(),
    future: [],
  }));
  const dragStart = useRef<MapDoc | null>(null);

  useEffect(() => writeDraft(base, history.present), [base, history.present]);

  const commit = useCallback((next: MapDoc | ((doc: MapDoc) => MapDoc)) => {
    setHistory((h) => {
      const doc = typeof next === "function" ? next(h.present) : next;
      if (doc === h.present) return h;
      return { past: [...h.past, h.present].slice(-MAX_UNDO), present: doc, future: [] };
    });
  }, []);

  const preview = useCallback((next: (doc: MapDoc) => MapDoc) => {
    setHistory((h) => {
      dragStart.current ??= h.present;
      return { ...h, present: next(h.present) };
    });
  }, []);

  const settle = useCallback(() => {
    const start = dragStart.current;
    dragStart.current = null;
    if (!start) return;
    setHistory((h) =>
      h.present === start
        ? h
        : { past: [...h.past, start].slice(-MAX_UNDO), present: h.present, future: [] },
    );
  }, []);

  const undo = useCallback(() => {
    setHistory((h) =>
      h.past.length
        ? { past: h.past.slice(0, -1), present: h.past.at(-1)!, future: [h.present, ...h.future] }
        : h,
    );
  }, []);

  const redo = useCallback(() => {
    setHistory((h) =>
      h.future.length
        ? { past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1) }
        : h,
    );
  }, []);

  return {
    doc: history.present,
    commit,
    preview,
    settle,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}
