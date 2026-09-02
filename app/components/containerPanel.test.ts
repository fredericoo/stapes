import { describe, expect, it } from "vitest";
import { containerSlotGrid } from "./ContainerPanel";
import { ITEM_SLOT_SIZE_PX } from "./ItemSlot";

/**
 * How a container lays out in the two columns it actually lives in.
 *
 * The panel appears in the phone's reading column and in the desktop aside, and
 * those are far enough apart that one fixed square could not serve both: at the
 * desktop's width four squares fit and looked right, and at the phone's the same
 * four wrapped as three and an orphan. The interesting cases are therefore the
 * two real widths and the boundary between them.
 */

/** What the row measures in the phone's reading column, and in the aside. */
const PHONE_ROW_PX = 152;
const DESKTOP_ROW_PX = 192;

/**
 * Four squares at their floor, plus their three gaps — the width that earns a
 * dense row. The floor is under the natural size on purpose; see the panel.
 */
const DENSE_MIN_SLOT_PX = 40;
const DENSE_THRESHOLD_PX = 4 * DENSE_MIN_SLOT_PX + 3 * 4;

describe("containerSlotGrid", () => {
  it("keeps four across where four fit", () => {
    expect(containerSlotGrid(DESKTOP_ROW_PX).columns).toBe(4);
  });

  /** The reported bug: a four-slot bag drawn as three and one. */
  it("halves the row rather than wrapping ragged on a phone", () => {
    expect(containerSlotGrid(PHONE_ROW_PX).columns).toBe(2);
  });

  it("switches exactly where four naturals stop fitting", () => {
    expect(containerSlotGrid(DENSE_THRESHOLD_PX).columns).toBe(4);
    expect(containerSlotGrid(DENSE_THRESHOLD_PX - 1).columns).toBe(2);
  });

  /** Squares fill the row they are in; that is the point of measuring it. */
  it("grows the squares into the room two columns leave", () => {
    const { slotPx } = containerSlotGrid(PHONE_ROW_PX);
    expect(slotPx).toBeGreaterThan(ITEM_SLOT_SIZE_PX);
  });

  it("never lets a row overflow what it was measured at", () => {
    for (const width of [0, 60, 100, PHONE_ROW_PX, 180, DESKTOP_ROW_PX, 400]) {
      const { columns, slotPx } = containerSlotGrid(width);
      const used = columns * slotPx + (columns - 1) * 4;
      // Below a single row of squares at their floor there is nothing left to
      // give, and they stop shrinking rather than becoming unhittable.
      if (width >= 2 * ITEM_SLOT_SIZE_PX + 4)
        expect(used).toBeLessThanOrEqual(width);
    }
  });

  /** A wide panel must not hand two squares half a column each. */
  it("stops growing well short of the panel", () => {
    expect(containerSlotGrid(400).slotPx).toBeLessThanOrEqual(72);
  });

  /** Both real widths sit clear of the boundary rather than on top of it. */
  it("keeps the two columns it actually lives in off the threshold", () => {
    expect(DESKTOP_ROW_PX - DENSE_THRESHOLD_PX).toBeGreaterThanOrEqual(8);
    expect(DENSE_THRESHOLD_PX - PHONE_ROW_PX).toBeGreaterThanOrEqual(8);
  });

  it("draws a usable square before anything has measured", () => {
    expect(containerSlotGrid(0).slotPx).toBeGreaterThanOrEqual(
      DENSE_MIN_SLOT_PX,
    );
  });
});
