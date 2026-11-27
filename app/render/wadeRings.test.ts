import { describe, expect, it } from "vitest";
import { MAX_WADE_RINGS, createWadeRingUniforms, writeWadeRings, type WadeRing } from "./wadeRings";

const ringAt = (x: number): WadeRing => ({ x, y: 0, radiusPx: 4, foot: 0, phaseMs: 0 });

describe("writeWadeRings", () => {
  it("keeps the rings nearest the camera when more bodies wade than the shader holds", () => {
    const uniforms = createWadeRingUniforms();
    const rings = Array.from({ length: MAX_WADE_RINGS + 4 }, (_, i) => ringAt(1000 - i * 10));

    writeWadeRings(uniforms, rings, 0, 0);

    const kept = uniforms.uWadeRings.value.map((v) => v.x).sort((a, b) => a - b);
    expect(uniforms.uWadeRingCount.value).toBe(MAX_WADE_RINGS);
    expect(kept[0]).toBe(1000 - (MAX_WADE_RINGS + 3) * 10);
    expect(kept.at(-1)).toBe(1000 - 4 * 10);
  });

  it("says nothing changed when the same rings are written again", () => {
    const uniforms = createWadeRingUniforms();
    expect(writeWadeRings(uniforms, [ringAt(5)], 0, 0)).toBe(true);
    expect(writeWadeRings(uniforms, [ringAt(5)], 0, 0)).toBe(false);
  });
});
