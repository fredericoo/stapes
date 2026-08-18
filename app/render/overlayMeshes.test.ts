import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  PULSE_PERIOD_MS,
  disposeGroupChildren,
  makeFollowingSpriteOutline,
  pulseAlphaAt,
} from "./overlayMeshes";

/**
 * How a chosen outline breathes.
 *
 * Asserted rather than eyeballed because both ends of the curve are decisions
 * with reasons: it never goes out, so a target is never briefly indistinguishable
 * from nothing, and it comes all the way back up, so the outline reads as one
 * breath rather than as a light that dimmed and stayed dim.
 */
describe("pulseAlphaAt", () => {
  it("never goes out", () => {
    for (let ms = 0; ms < PULSE_PERIOD_MS * 3; ms += 17) {
      expect(pulseAlphaAt(ms)).toBeGreaterThan(0);
    }
  });

  it("comes back to full, and dips well below it", () => {
    const samples = [];
    for (let ms = 0; ms < PULSE_PERIOD_MS * 3; ms += 17) {
      samples.push(pulseAlphaAt(ms));
    }

    expect(Math.max(...samples)).toBeCloseTo(1, 2);
    expect(Math.min(...samples)).toBeLessThan(0.5);
  });

  /** One cycle, repeating: an outline rebuilt mid-walk resumes where it was. */
  it("repeats", () => {
    const intoTheCycleMs = 350;
    expect(pulseAlphaAt(PULSE_PERIOD_MS + intoTheCycleMs)).toBeCloseTo(
      pulseAlphaAt(intoTheCycleMs),
      5,
    );
  });

  it("starts at its dimmest and climbs", () => {
    expect(pulseAlphaAt(0)).toBeLessThan(pulseAlphaAt(200));
  });
});

/**
 * What keeps an outline on the frame the player is actually looking at.
 *
 * The bug this pins is one the tests could not see and a screenshot could: a
 * silhouette cut from its own copy of the art froze on whichever frame was up
 * when a creature started moving, so a walking snake wore a coiled outline. The
 * fix is that there is no second copy — the outline reads the same quad the
 * world draws — and "same quad" is the assertion, since nothing downstream can
 * reintroduce the drift while it holds.
 */
describe("makeFollowingSpriteOutline", () => {
  const TILESET_PX = 256;
  const SPRITE_PX = 16;

  function sourceMesh(): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(SPRITE_PX, SPRITE_PX);
    const span = SPRITE_PX / TILESET_PX;
    const uvs = geo.attributes.uv!;
    uvs.setXY(0, 0, 0);
    uvs.setXY(1, span, 0);
    uvs.setXY(2, 0, span);
    uvs.setXY(3, span, span);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ map: new THREE.Texture() }),
    );
    mesh.position.set(40, 24, 0);
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);
    return mesh;
  }

  it("draws from the sprite's own quad, so a frame flip needs no telling", () => {
    const source = sourceMesh();
    const outline = makeFollowingSpriteOutline(source, 0xffffff)!;
    expect(outline.geometry).toBe(source.geometry);
  });

  it("lands on the sprite, lerp and all", () => {
    const source = sourceMesh();
    const outline = makeFollowingSpriteOutline(source, 0xffffff)!;
    expect(outline.matrixWorld.elements).toEqual(source.matrixWorld.elements);
  });

  /** One texel, worked out from the quad rather than handed in. */
  it("reads the atlas scale off the mesh", () => {
    const outline = makeFollowingSpriteOutline(sourceMesh(), 0xffffff)!;
    const px = (outline.material as THREE.ShaderMaterial).uniforms.uPx!.value;
    expect(px.x).toBeCloseTo(1 / TILESET_PX, 6);
    expect(px.y).toBeCloseTo(1 / TILESET_PX, 6);
  });

  it("gives up on a mesh with no art rather than outlining nothing", () => {
    const source = sourceMesh();
    (source.material as THREE.MeshBasicMaterial).map = null;
    expect(makeFollowingSpriteOutline(source, 0xffffff)).toBeNull();
  });

  it("is thrown away without taking the sprite's quad with it", () => {
    const source = sourceMesh();
    const group = new THREE.Group();
    group.add(makeFollowingSpriteOutline(source, 0xffffff)!);
    disposeGroupChildren(group);
    // A disposed buffer is one the tile underneath would stop drawing with.
    expect(source.geometry.attributes.position).toBeDefined();
    expect(group.children).toHaveLength(0);
  });
});
