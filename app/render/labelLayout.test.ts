import { describe, expect, it } from "vitest";
import {
  layoutLabels,
  type LabelKind,
  type LabelPlacement,
  type LabelRequest,
} from "./labelLayout";

const VIEW = { width: 600, height: 600 };

function request(
  id: string,
  kind: LabelKind,
  anchorX: number,
  anchorY: number,
  size: {
    width?: number;
    height?: number;
    lift?: number;
    barWidth?: number;
  } = {},
): LabelRequest {
  return {
    id,
    kind,
    anchorX,
    anchorY,
    width: size.width ?? 100,
    height: size.height ?? 24,
    lift: size.lift ?? 0,
    barWidth: size.barWidth,
  };
}

function boxOf(layout: Map<string, LabelPlacement>, id: string, requests: LabelRequest[]) {
  const at = layout.get(id);
  if (!at) throw new Error(`${id} was not placed`);
  const req = requests.find((r) => r.id === id);
  if (!req) throw new Error(`no request for ${id}`);
  return {
    left: at.left,
    right: at.left + req.width,
    top: at.top,
    bottom: at.top + req.height,
  };
}

function intersects(
  a: { left: number; right: number; top: number; bottom: number },
  b: { left: number; right: number; top: number; bottom: number },
): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

describe("an uncontested label", () => {
  it("hangs above its anchor, centred on it", () => {
    const requests = [request("a", "speech", 300, 400, { width: 80, height: 24 })];
    const layout = layoutLabels(requests, VIEW);

    expect(layout.get("a")).toEqual({ left: 260, top: 376 });
  });

  it("is lifted clear of the anchor by however much it asked for", () => {
    const requests = [request("a", "speech", 300, 400, { width: 80, height: 24, lift: 30 })];
    expect(layoutLabels(requests, VIEW).get("a")).toEqual({
      left: 260,
      top: 346,
    });
  });
});

describe("fitting the screen", () => {
  it("slides a label at the right edge back inside the view", () => {
    const requests = [request("a", "speech", 595, 400, { width: 200 })];
    const box = boxOf(layoutLabels(requests, VIEW), "a", requests);

    expect(box.right).toBeLessThanOrEqual(VIEW.width);
    expect(box.right).toBeGreaterThan(VIEW.width - 10);
  });

  it("pushes a label down when its anchor is near the top", () => {
    const requests = [request("a", "speech", 300, 10, { height: 24 })];
    const box = boxOf(layoutLabels(requests, VIEW), "a", requests);

    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(VIEW.height);
  });

  it("drops a label anchored outside the view", () => {
    const requests = [
      request("above", "speech", 300, -20),
      request("left", "speech", -5, 300),
      request("below", "speech", 300, 620),
      request("right", "speech", 700, 300),
    ];
    expect(layoutLabels(requests, VIEW).size).toBe(0);
  });
});

describe("two labels at one spot", () => {
  it("stacks the second above the first instead of over it", () => {
    const requests = [request("first", "speech", 300, 400), request("second", "speech", 300, 400)];
    const layout = layoutLabels(requests, VIEW);

    const first = boxOf(layout, "first", requests);
    const second = boxOf(layout, "second", requests);
    expect(intersects(first, second)).toBe(false);
    expect(second.bottom).toBeLessThanOrEqual(first.top);
  });

  it("leaves the earlier label where it was", () => {
    const alone = layoutLabels([request("first", "speech", 300, 400)], VIEW);
    const crowded = layoutLabels(
      [request("first", "speech", 300, 400), request("second", "speech", 300, 400)],
      VIEW,
    );

    expect(crowded.get("first")).toEqual(alone.get("first"));
  });

  it("keeps a column of many apart", () => {
    const requests = Array.from({ length: 6 }, (_, i) => request(`s${i}`, "speech", 300, 500));
    const layout = layoutLabels(requests, VIEW);
    const boxes = requests.map((r) => boxOf(layout, r.id, requests));

    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) {
        expect(intersects(a, b)).toBe(false);
      }
    }
  });

  it("does not move a label that was never in the way", () => {
    const requests = [
      request("here", "speech", 150, 400, { width: 100 }),
      request("there", "speech", 450, 400, { width: 100 }),
    ];
    const layout = layoutLabels(requests, VIEW);

    expect(layout.get("here")).toEqual({ left: 100, top: 376 });
    expect(layout.get("there")).toEqual({ left: 400, top: 376 });
  });
});

describe("priority", () => {
  it("gives a look the spot and moves the speech, whatever the order", () => {
    const requests = [request("said", "speech", 300, 400), request("looked", "look", 300, 400)];
    const layout = layoutLabels(requests, VIEW);

    expect(layout.get("looked")).toEqual(
      layoutLabels([request("looked", "look", 300, 400)], VIEW).get("looked"),
    );
    const look = boxOf(layout, "looked", requests);
    const said = boxOf(layout, "said", requests);
    expect(intersects(look, said)).toBe(false);
    expect(said.bottom).toBeLessThanOrEqual(look.top);
  });

  it("drops the speech rather than the look when only one can fit", () => {
    const tall = { width: 100, height: 300 };
    const requests = [
      request("said", "speech", 300, 590, tall),
      request("looked", "look", 300, 590, tall),
    ];
    const layout = layoutLabels(requests, VIEW);

    expect(layout.has("looked")).toBe(true);
    expect(layout.has("said")).toBe(false);
  });
});

describe("names", () => {
  it("sits on its anchor and is left to be covered", () => {
    const requests = [request("name", "name", 300, 400), request("said", "speech", 300, 400)];
    const layout = layoutLabels(requests, VIEW);

    expect(layout.get("name")).toEqual({ left: 250, top: 376 });
    expect(layout.get("said")).toEqual({ left: 250, top: 376 });
  });

  it("never pushes a look off its target", () => {
    const requests = [request("name", "name", 300, 400), request("looked", "look", 300, 400)];
    const layout = layoutLabels(requests, VIEW);

    expect(layout.get("looked")).toEqual(
      layoutLabels([request("looked", "look", 300, 400)], VIEW).get("looked"),
    );
  });

  it("is never an obstacle, even to another name", () => {
    const requests = [request("a", "name", 300, 400), request("b", "name", 300, 400)];
    const layout = layoutLabels(requests, VIEW);

    expect(layout.get("a")).toEqual(layout.get("b"));
  });
});

describe("a health bar inside a name", () => {
  const BAR = 52;

  it("is centred on the anchor, not on the name above it", () => {
    const requests = [request("name", "name", 300, 400, { width: 200, barWidth: BAR })];
    const layout = layoutLabels(requests, VIEW);

    expect(layout.get("name")?.barLeft).toBe(300 - BAR / 2);
  });

  it("stays on its target when the name has to slide inside the view", () => {
    const requests = [request("name", "name", 40, 400, { width: 300, barWidth: BAR })];
    const layout = layoutLabels(requests, VIEW);

    expect(layout.get("name")?.left).toBe(2);
    expect(layout.get("name")?.barLeft).toBe(40 - BAR / 2);
  });

  it("is pulled inside the view by its own width when it has to be", () => {
    const requests = [request("name", "name", 1, 400, { width: 300, barWidth: BAR })];
    const layout = layoutLabels(requests, VIEW);

    expect(layout.get("name")?.barLeft).toBe(2);
    expect(
      layoutLabels([request("name", "name", 599, 400, { width: 300, barWidth: BAR })], VIEW).get(
        "name",
      )?.barLeft,
    ).toBe(VIEW.width - BAR - 2);
  });

  it("has no opinion at all for a label without one", () => {
    const layout = layoutLabels([request("said", "speech", 300, 400)], VIEW);

    expect(layout.get("said")?.barLeft).toBeUndefined();
  });
});

describe("nowhere left to go", () => {
  it("goes below when there is no room above", () => {
    const requests = [
      request("first", "speech", 300, 30, { height: 24 }),
      request("second", "speech", 300, 30, { height: 24 }),
    ];
    const layout = layoutLabels(requests, VIEW);

    const first = boxOf(layout, "first", requests);
    const second = boxOf(layout, "second", requests);
    expect(intersects(first, second)).toBe(false);
    expect(second.top).toBeGreaterThanOrEqual(first.bottom);
  });

  it("takes the shorter way out when up is a long climb", () => {
    const requests = [
      request("tall", "look", 300, 300, { height: 250 }),
      request("late", "speech", 300, 320, { height: 40 }),
    ];
    const layout = layoutLabels(requests, VIEW);

    const late = boxOf(layout, "late", requests);
    const tall = boxOf(layout, "tall", requests);
    expect(intersects(late, tall)).toBe(false);
    expect(late.top).toBeGreaterThan(tall.bottom - 1);
    expect(late.top - 320).toBeLessThan(60);
  });

  it("hides what it cannot place rather than printing it on top", () => {
    const full = { width: 100, height: 200 };
    const requests = Array.from({ length: 5 }, (_, i) =>
      request(`s${i}`, "speech", 300, 590, full),
    );
    const layout = layoutLabels(requests, VIEW);

    expect(layout.size).toBeLessThan(requests.length);
    const boxes = [...layout.keys()].map((id) => boxOf(layout, id, requests));
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) {
        expect(intersects(a, b)).toBe(false);
      }
    }
  });

  it("still places a label too big for the screen", () => {
    const requests = [request("a", "speech", 300, 400, { width: 900 })];
    expect(layoutLabels(requests, VIEW).get("a")?.left).toBe(2);
  });
});
