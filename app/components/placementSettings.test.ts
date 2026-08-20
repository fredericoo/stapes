import { describe, expect, it } from "vitest";
import { readDestination } from "./PlacementSettingsDialog";

/**
 * What the three destination fields commit to the map.
 *
 * The interesting cases are all about blankness, because the fields start blank
 * on any placement nobody has authored yet and show `0` as their placeholder.
 * Typing into one of the three and leaving the others alone is the ordinary way
 * to author a ladder, and it used to commit nothing at all.
 */
describe("readDestination", () => {
  it("reads three filled fields as the cell", () => {
    expect(readDestination({ x: "10", y: "-7", z: "1" })).toEqual({
      x: 10,
      y: -7,
      z: 1,
    });
  });

  it("takes a blank axis as the zero its placeholder promises", () => {
    // The ladder case: only the climb is typed, and the two untouched fields
    // must not throw the edit away.
    expect(readDestination({ x: "", y: "", z: "1" })).toEqual({
      x: 0,
      y: 0,
      z: 1,
    });
  });

  it("un-authors the placement only when every field is empty", () => {
    expect(readDestination({ x: "", y: "", z: "" })).toBeNull();
    expect(readDestination({ x: "  ", y: "", z: " " })).toBeNull();
  });

  it("keeps a zero somebody typed", () => {
    expect(readDestination({ x: "0", y: "0", z: "0" })).toEqual({
      x: 0,
      y: 0,
      z: 0,
    });
  });

  it("refuses junk rather than reading it as nothing", () => {
    expect(readDestination({ x: "abc", y: "0", z: "1" })).toBeNull();
  });
});
