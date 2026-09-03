/**
 * What a client is sent, and — the half that actually bites — what it is sent
 * *next*.
 *
 * A subscription that is merely small is easy. One that is small and never
 * leaves a walker looking at country nobody told them about is the claim worth
 * pinning, so most of this is about movement: the margin beyond the edge of the
 * view, and the promise that a step hands over what has just come into reach
 * rather than a diff against a board the client has never held.
 */
import { describe, expect, it } from "vitest";
import { emptyMap, replaceStack } from "../lib/mapData";
import type { MapFile, PlacedTile } from "../lib/types";
import { VIEW_CELLS } from "../lib/view";
import {
  INTEREST_APRON_CELLS,
  cellsEntered,
  covers,
  interestAt,
  mapOfInterest,
  sameInterest,
} from "./interest";

/** Half the view, rounded down — the player stands in the centre cell. */
const HALF_VIEW = Math.floor(VIEW_CELLS / 2);

/** A floor covering `span` cells each way from the origin, on two levels. */
function floor(span: number): MapFile {
  let map = emptyMap();
  for (let x = -span; x <= span; x++) {
    for (let y = -span; y <= span; y++) {
      map = replaceStack(map, x, y, 0, [{ tileId: "grass" } as PlacedTile]);
      map = replaceStack(map, x, y, -1, [{ tileId: "dirt" } as PlacedTile]);
    }
  }
  return map;
}

describe("what a client is subscribed to", () => {
  it("covers everything it can see, and the apron past it", () => {
    const at = interestAt(0, 0);
    for (const [dx, dy] of [
      [HALF_VIEW, 0],
      [-HALF_VIEW, 0],
      [0, HALF_VIEW],
      [HALF_VIEW, HALF_VIEW],
    ] as const) {
      expect(covers(at, dx, dy), `cannot see ${dx},${dy}`).toBe(true);
    }

    // The guarantee the apron is for: this much built world lies past the edge
    // of the screen, so walking outward never outruns what has been sent.
    const reach = HALF_VIEW + INTEREST_APRON_CELLS;
    expect(covers(at, reach, reach)).toBe(true);
    expect(covers(at, reach + 1, 0)).toBe(false);
  });

  it("is a fraction of a map much bigger than a screen", () => {
    const span = 120;
    const whole = (span * 2 + 1) ** 2;
    const mine = mapOfInterest(floor(span), interestAt(0, 0));
    const sent = Object.keys(mine.levels["0"] ?? {}).length;

    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(whole / 20);
  });

  it("sends every level of the square it covers", () => {
    // Not scoped by level on purpose: you can see down a hole into the floor
    // below, and a body that falls has to land somewhere it has been told
    // about. @see the module comment.
    const mine = mapOfInterest(floor(40), interestAt(0, 0));
    expect(Object.keys(mine.levels).sort()).toEqual(["-1", "0"]);
  });

  it("holds nothing of a map that has nothing where it is looking", () => {
    expect(mapOfInterest(emptyMap(), interestAt(0, 0)).levels).toEqual({});
  });
});

describe("walking into country nobody has mentioned", () => {
  const map = floor(120);

  it("hands over one column for one step, not a square", () => {
    // The whole reason the unit is the cell. A chunk-quantised subscription
    // paid for a step at the boundary and paid ~50KB when it did; this pays a
    // strip, every step, and the strip is the same size wherever you stand.
    const entered = cellsEntered(map, interestAt(0, 0), interestAt(1, 0));
    const columns = new Set(entered.map((cell) => cell.x));

    expect(columns.size).toBe(1);
    // Two levels of a column that is as tall as the square is wide.
    const width = HALF_VIEW + INTEREST_APRON_CELLS;
    expect(entered.length).toBe((width * 2 + 1) * 2);
  });

  it("sends the whole square to somebody who arrived rather than walked", () => {
    // A teleport, a fall, a ramp between floors: nothing overlaps, so
    // everything is new. Which is right — you have arrived somewhere you have
    // never been.
    const far = interestAt(400, 400);
    const whole = mapOfInterest(map, far);
    const entered = cellsEntered(map, interestAt(0, 0), far);
    let cells = 0;
    for (const level of Object.values(whole.levels)) cells += Object.keys(level).length;
    expect(entered.length).toBe(cells);
  });

  it("says nothing when nothing has come into reach", () => {
    const still = interestAt(4, 4);
    expect(sameInterest(still, interestAt(4, 4))).toBe(true);
    expect(cellsEntered(map, still, still)).toEqual([]);
  });

  it("never re-sends country already held", () => {
    // Walking out and back must not pay twice: what comes into reach on the way
    // back is only what left on the way out.
    const before = interestAt(0, 0);
    const after = interestAt(0, 1);
    for (const cell of cellsEntered(map, before, after)) {
      expect(covers(before, cell.x, cell.y)).toBe(false);
    }
  });

  it("is empty for a step across a board with nothing on it", () => {
    // Walking to the edge of the world is not an error, and costs no message.
    expect(cellsEntered(emptyMap(), interestAt(0, 0), interestAt(1, 0))).toEqual([]);
  });
});
