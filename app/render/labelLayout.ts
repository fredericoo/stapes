export type LabelKind = "name" | "speech" | "noise" | "look";

const LABEL_GAP_PX = 4;

const VIEW_PADDING_PX = 2;

export type LabelRequest = {
  id: string;
  kind: LabelKind;
  anchorX: number;
  anchorY: number;
  width: number;
  height: number;
  lift: number;
  barWidth?: number;
};

export type LabelPlacement = {
  left: number;
  top: number;
  barLeft?: number;
};

export type LabelLayout = Map<string, LabelPlacement>;

type Rect = { left: number; right: number; top: number; bottom: number };

const PLACEMENT_ORDER: Record<LabelKind, number> = {
  look: 0,
  speech: 1,
  noise: 2,
  name: 3,
};

export function layoutLabels(
  requests: LabelRequest[],
  view: { width: number; height: number },
): LabelLayout {
  const layout: LabelLayout = new Map();
  const taken: Rect[] = [];

  for (const request of byPriority(requests)) {
    const wanted = wantedRect(request, view);
    if (!wanted) continue;

    const barLeft = barLeftFor(request, view);

    if (request.kind === "name") {
      layout.set(request.id, { left: wanted.left, top: wanted.top, barLeft });
      continue;
    }

    const top = clearTop(wanted, taken, view);
    if (top === null) continue;

    taken.push({
      ...wanted,
      top,
      bottom: top + request.height,
    });
    layout.set(request.id, { left: wanted.left, top, barLeft });
  }

  return layout;
}

function byPriority(requests: LabelRequest[]): LabelRequest[] {
  return [...requests].sort((a, b) => PLACEMENT_ORDER[a.kind] - PLACEMENT_ORDER[b.kind]);
}

function wantedRect(request: LabelRequest, view: { width: number; height: number }): Rect | null {
  const { anchorX, anchorY, width, height } = request;
  if (anchorX < 0 || anchorX > view.width) return null;
  if (anchorY < 0 || anchorY > view.height) return null;

  const left = clamp(
    Math.round(anchorX - width / 2),
    VIEW_PADDING_PX,
    view.width - width - VIEW_PADDING_PX,
  );
  const top = clamp(
    Math.round(anchorY - request.lift - height),
    VIEW_PADDING_PX,
    view.height - height - VIEW_PADDING_PX,
  );
  return { left, right: left + width, top, bottom: top + height };
}

function barLeftFor(
  request: LabelRequest,
  view: { width: number; height: number },
): number | undefined {
  const { barWidth } = request;
  if (barWidth === undefined) return undefined;
  return clamp(
    Math.round(request.anchorX - barWidth / 2),
    VIEW_PADDING_PX,
    view.width - barWidth - VIEW_PADDING_PX,
  );
}

function clearTop(
  wanted: Rect,
  taken: Rect[],
  view: { width: number; height: number },
): number | null {
  const up = slide(wanted, taken, view, -1);
  const down = slide(wanted, taken, view, 1);
  if (up === null) return down;
  if (down === null) return up;
  return wanted.top - up <= down - wanted.top ? up : down;
}

function slide(
  wanted: Rect,
  taken: Rect[],
  view: { width: number; height: number },
  direction: 1 | -1,
): number | null {
  const height = wanted.bottom - wanted.top;
  let top = wanted.top;

  for (let step = 0; step <= taken.length; step++) {
    if (!fitsVertically(top, height, view)) return null;
    const hit = taken.find((rect) => overlaps({ ...wanted, top, bottom: top + height }, rect));
    if (!hit) return top;
    top = direction < 0 ? hit.top - LABEL_GAP_PX - height : hit.bottom + LABEL_GAP_PX;
  }

  return null;
}

function fitsVertically(
  top: number,
  height: number,
  view: { width: number; height: number },
): boolean {
  return top >= VIEW_PADDING_PX && top + height <= view.height - VIEW_PADDING_PX;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}
