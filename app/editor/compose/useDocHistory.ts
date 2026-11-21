import { useCallback, useEffect, useRef, useState } from "react";
import { parseMapDoc, type MapDoc } from "./doc";

const STORAGE_KEY = "stapes:compose:v1";
const MAX_UNDO = 200;

type History = { past: MapDoc[]; present: MapDoc; future: MapDoc[] };

export function readSavedDoc(): MapDoc | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = parseMapDoc(JSON.parse(raw));
    return parsed.ok ? parsed.doc : null;
  } catch {
    return null;
  }
}

function writeSavedDoc(doc: MapDoc) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
  } catch {
    /** A private window or a full quota keeps the tree for this visit only. */
  }
}

/**
 * The tree with undo and redo, kept in this browser between visits. A drag
 * sends many `preview`s and one `settle`, so it is one step of undo however
 * far it went: the first preview remembers where the drag started, and the
 * settle files that as the step.
 */
export function useDocHistory(initial: () => MapDoc) {
  const [history, setHistory] = useState<History>(() => ({
    past: [],
    present: readSavedDoc() ?? initial(),
    future: [],
  }));
  const dragStart = useRef<MapDoc | null>(null);

  useEffect(() => writeSavedDoc(history.present), [history.present]);

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
