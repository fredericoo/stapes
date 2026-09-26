import { describe, expect, it } from "vitest";
import { containerSlotGrid } from "./ContainerPanel";
import { ITEM_SLOT_SIZE_PX } from "./ItemSlot";

const PHONE_ROW_PX = 152;
const DESKTOP_ROW_PX = 192;

const DENSE_MIN_SLOT_PX = 40;
const DENSE_THRESHOLD_PX = 4 * DENSE_MIN_SLOT_PX + 3 * 4;

describe("containerSlotGrid", () => {
  it("keeps four across where four fit", () => {
    expect(containerSlotGrid(DESKTOP_ROW_PX).columns).toBe(4);
  });

  it("halves the row rather than wrapping ragged on a phone", () => {
    expect(containerSlotGrid(PHONE_ROW_PX).columns).toBe(2);
  });

  it("switches exactly where four naturals stop fitting", () => {
    expect(containerSlotGrid(DENSE_THRESHOLD_PX).columns).toBe(4);
    expect(containerSlotGrid(DENSE_THRESHOLD_PX - 1).columns).toBe(2);
  });

  it("grows the squares into the room two columns leave", () => {
    const { slotPx } = containerSlotGrid(PHONE_ROW_PX);
    expect(slotPx).toBeGreaterThan(ITEM_SLOT_SIZE_PX);
  });

  it("never lets a row overflow what it was measured at", () => {
    for (const width of [0, 60, 100, PHONE_ROW_PX, 180, DESKTOP_ROW_PX, 400]) {
      const { columns, slotPx } = containerSlotGrid(width);
      const used = columns * slotPx + (columns - 1) * 4;
      if (width >= 2 * ITEM_SLOT_SIZE_PX + 4) expect(used).toBeLessThanOrEqual(width);
    }
  });

  it("stops growing well short of the panel", () => {
    expect(containerSlotGrid(400).slotPx).toBeLessThanOrEqual(72);
  });

  it("keeps the two columns it actually lives in off the threshold", () => {
    expect(DESKTOP_ROW_PX - DENSE_THRESHOLD_PX).toBeGreaterThanOrEqual(8);
    expect(DENSE_THRESHOLD_PX - PHONE_ROW_PX).toBeGreaterThanOrEqual(8);
  });

  it("draws a usable square before anything has measured", () => {
    expect(containerSlotGrid(0).slotPx).toBeGreaterThanOrEqual(DENSE_MIN_SLOT_PX);
  });
});
