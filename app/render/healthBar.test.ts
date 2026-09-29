import { describe, expect, it } from "vitest";
import { CELL_SIZE } from "../lib/types";
import { VIEW_PX } from "./viewport";
import {
  HEALTH_BAR_FILL_STEPS,
  HEALTH_BAR_STOPS,
  healthBarColor,
  healthBarFillBricks,
  healthBarFillHeightBricks,
  healthBarTrackBricks,
  healthFraction,
} from "./healthBar";

describe("how full a bar is", () => {
  it("clamps to the ends", () => {
    expect(healthFraction(-5, 10)).toBe(0);
    expect(healthFraction(50, 10)).toBe(1);
  });

  it("survives a maximum of zero rather than dividing by it", () => {
    expect(healthFraction(0, 0)).toBe(0);
  });
});

describe("the colour ramp", () => {
  it("passes through four distinct colours on the way down", () => {
    const seen = new Set([1, 0.5, 0.25, 0.05].map((fraction) => healthBarColor(fraction)));
    expect(seen.size).toBe(HEALTH_BAR_STOPS.length);
  });

  it("only ever changes colour in one direction as health falls", () => {
    let previous = healthBarColor(1);
    const changes: string[] = [];
    for (let step = 100; step >= 0; step--) {
      const color = healthBarColor(step / 100);
      if (color !== previous) changes.push(color);
      previous = color;
    }
    expect(changes).toHaveLength(HEALTH_BAR_STOPS.length - 1);
    expect(new Set(changes).size).toBe(changes.length);
  });

  it("is at its darkest when nearly gone and its brightest when full", () => {
    expect(healthBarColor(0.01)).toBe(HEALTH_BAR_STOPS[0]!.color);
    expect(healthBarColor(1)).toBe(HEALTH_BAR_STOPS[HEALTH_BAR_STOPS.length - 1]!.color);
  });
});

describe("the fill", () => {
  it("spans the whole track at full health and none of it at zero", () => {
    expect(healthBarFillBricks(1)).toBe(HEALTH_BAR_FILL_STEPS);
    expect(healthBarFillBricks(0)).toBe(0);
  });

  it("keeps a brick for the last hit point of a big pool", () => {
    expect(healthBarFillBricks(healthFraction(1, 500))).toBe(1);
  });

  it("never reads as full while anything is missing", () => {
    expect(healthBarFillBricks(0.999)).toBeLessThan(HEALTH_BAR_FILL_STEPS);
    expect(healthBarFillBricks(healthFraction(499, 500))).toBeLessThan(HEALTH_BAR_FILL_STEPS);
  });

  it("stays on the brick grid, and inside the track", () => {
    for (let hp = 0; hp <= 20; hp++) {
      const bricks = healthBarFillBricks(healthFraction(hp, 20));
      expect(Number.isInteger(bricks)).toBe(true);
      expect(bricks).toBeGreaterThanOrEqual(0);
      expect(bricks).toBeLessThanOrEqual(HEALTH_BAR_FILL_STEPS);
    }
  });

  it("grows as health does", () => {
    let previous = -1;
    for (let hp = 0; hp <= 20; hp++) {
      const bricks = healthBarFillBricks(healthFraction(hp, 20));
      expect(bricks).toBeGreaterThanOrEqual(previous);
      previous = bricks;
    }
  });
});

const cellPxForPane = (paneCssPx: number) => CELL_SIZE * (paneCssPx / VIEW_PX);

const BRICK_PX = 2;

const BORDER_BRICKS = 2;

const MIN_TRACK_BRICKS = 4;

describe("fitting a track to a cell", () => {
  it("never exceeds the cell, borders included", () => {
    for (let pane = 320; pane <= 2000; pane += 7) {
      const cellPx = cellPxForPane(pane);
      const bricks = healthBarTrackBricks(cellPx, BRICK_PX);
      const drawnPx = (bricks + BORDER_BRICKS) * BRICK_PX;
      if (bricks > MIN_TRACK_BRICKS) {
        expect(drawnPx).toBeLessThanOrEqual(cellPx);
      }
    }
  });

  it("gives whole bricks, so every edge lands where the letters do", () => {
    for (let pane = 320; pane <= 2000; pane += 13) {
      expect(Number.isInteger(healthBarTrackBricks(cellPxForPane(pane), BRICK_PX))).toBe(true);
    }
  });

  it("grows with the window rather than staying put", () => {
    expect(healthBarTrackBricks(cellPxForPane(1200), BRICK_PX)).toBeGreaterThan(
      healthBarTrackBricks(cellPxForPane(600), BRICK_PX),
    );
  });

  it("keeps something to draw at a nonsensical size", () => {
    expect(healthBarTrackBricks(1, BRICK_PX)).toBeGreaterThan(0);
    expect(healthBarTrackBricks(cellPxForPane(1200), 0)).toBeGreaterThan(0);
  });
});

describe("the fill in a track that is not the default length", () => {
  const SHORT_TRACK_BRICKS = 11;

  it("still spans the whole track, and still empties", () => {
    expect(healthBarFillBricks(1, SHORT_TRACK_BRICKS)).toBe(SHORT_TRACK_BRICKS);
    expect(healthBarFillBricks(0, SHORT_TRACK_BRICKS)).toBe(0);
  });

  it("keeps the last hit point and never rounds a scratch back to full", () => {
    expect(healthBarFillBricks(healthFraction(1, 500), SHORT_TRACK_BRICKS)).toBe(1);
    expect(healthBarFillBricks(healthFraction(499, 500), SHORT_TRACK_BRICKS)).toBeLessThan(
      SHORT_TRACK_BRICKS,
    );
  });

  it("stays inside the track it was given", () => {
    for (let hp = 0; hp <= 20; hp++) {
      const bricks = healthBarFillBricks(healthFraction(hp, 20), SHORT_TRACK_BRICKS);
      expect(bricks).toBeGreaterThanOrEqual(0);
      expect(bricks).toBeLessThanOrEqual(SHORT_TRACK_BRICKS);
    }
  });
});

describe("how thick a track is", () => {
  it("never gets close to square", () => {
    for (let track = MIN_TRACK_BRICKS; track <= 40; track++) {
      expect(healthBarFillHeightBricks(track)).toBeLessThan(track);
    }
  });

  it("thickens as the track lengthens, and never thins as it does", () => {
    const phone = healthBarFillHeightBricks(healthBarTrackBricks(cellPxForPane(390), BRICK_PX));
    const desktop = healthBarFillHeightBricks(healthBarTrackBricks(cellPxForPane(1400), BRICK_PX));
    expect(phone).toBeLessThan(desktop);

    let previous = 0;
    for (let track = MIN_TRACK_BRICKS; track <= 40; track++) {
      const height = healthBarFillHeightBricks(track);
      expect(height).toBeGreaterThanOrEqual(previous);
      previous = height;
    }
  });

  it("stays thick enough to carry a colour at any size", () => {
    for (let track = 1; track <= 200; track++) {
      expect(healthBarFillHeightBricks(track)).toBeGreaterThanOrEqual(2);
    }
  });

  it("stops thickening rather than following a huge monitor up", () => {
    expect(healthBarFillHeightBricks(200)).toBe(healthBarFillHeightBricks(40));
  });

  it("gives whole bricks, like every other edge the bar has", () => {
    for (let track = 1; track <= 60; track++) {
      expect(Number.isInteger(healthBarFillHeightBricks(track))).toBe(true);
    }
  });
});
