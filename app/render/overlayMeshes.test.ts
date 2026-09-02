import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  OUTLINE_ALPHA_UNIFORM,
  OutlineMaterials,
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
  const materials = new OutlineMaterials();

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
    const outline = makeFollowingSpriteOutline(source, 0xffffff, materials)!;
    expect(outline.geometry).toBe(source.geometry);
  });

  it("lands on the sprite, lerp and all", () => {
    const source = sourceMesh();
    const outline = makeFollowingSpriteOutline(source, 0xffffff, materials)!;
    expect(outline.matrixWorld.elements).toEqual(source.matrixWorld.elements);
  });

  /** One texel, worked out from the quad rather than handed in. */
  it("reads the atlas scale off the mesh", () => {
    const outline =
      makeFollowingSpriteOutline(sourceMesh(), 0xffffff, materials)!;
    const px = (outline.material as THREE.ShaderMaterial).uniforms.uPx!.value;
    expect(px.x).toBeCloseTo(1 / TILESET_PX, 6);
    expect(px.y).toBeCloseTo(1 / TILESET_PX, 6);
  });

  it("gives up on a mesh with no art rather than outlining nothing", () => {
    const source = sourceMesh();
    (source.material as THREE.MeshBasicMaterial).map = null;
    expect(makeFollowingSpriteOutline(source, 0xffffff, materials)).toBeNull();
  });

  it("is thrown away without taking the sprite's quad with it", () => {
    const source = sourceMesh();
    const group = new THREE.Group();
    group.add(makeFollowingSpriteOutline(source, 0xffffff, materials)!);
    disposeGroupChildren(group, materials);
    // A disposed buffer is one the tile underneath would stop drawing with.
    expect(source.geometry.attributes.position).toBeDefined();
    expect(group.children).toHaveLength(0);
  });
});

/**
 * What keeps the outline shader compiled.
 *
 * Three refcounts a compiled program by the materials using it, and the outline
 * shader is the one program in the game whose only users are in the chrome
 * layer. So freeing those materials freed the program, and the next outline
 * compiled and linked it again from source — inside `render`, on the frame it
 * was wanted, which is why it read as the *draw* phase having got slower rather
 * than as anything to do with the chrome.
 *
 * The assertions are about disposal rather than about timing, because disposal
 * is the thing that can regress and the milliseconds are the driver's business:
 * a material the pool still owns must never be freed, and one handed back must
 * come out fit for its next outline.
 */
describe("OutlineMaterials", () => {
  const art = () => ({
    texture: new THREE.Texture(),
    uvPerPx: new THREE.Vector2(1 / 256, 1 / 256),
  });

  /** Disposal is an event, and the only way to watch for one from outside. */
  function watchDispose(material: THREE.Material): () => boolean {
    let freed = false;
    material.addEventListener("dispose", () => {
      freed = true;
    });
    return () => freed;
  }

  it("keeps the material when the chrome layer is emptied", () => {
    const materials = new OutlineMaterials();
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(8, 8),
      materials.take(art(), 0xffffff, []),
    );
    const freed = watchDispose(mesh.material as THREE.Material);

    const group = new THREE.Group();
    group.add(mesh);
    disposeGroupChildren(group, materials);

    expect(freed()).toBe(false);
  });

  it("lends the same one out again rather than making a second", () => {
    const materials = new OutlineMaterials();
    const first = materials.take(art(), 0xffffff, []);

    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.PlaneGeometry(8, 8), first));
    disposeGroupChildren(group, materials);

    expect(materials.take(art(), 0xff0000, [])).toBe(first);
  });

  /**
   * The one uniform something else writes. A pulsing outline has its alpha
   * driven down sixty times a second, and the material it leaves behind would
   * start the next steady outline part-lit if taking it back did not undo that.
   */
  it("puts the alpha back, so a reused material is not left part-lit", () => {
    const materials = new OutlineMaterials();
    const pulsing = materials.take(art(), 0xffffff, []);
    pulsing.uniforms[OUTLINE_ALPHA_UNIFORM]!.value = pulseAlphaAt(0);

    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.PlaneGeometry(8, 8), pulsing));
    disposeGroupChildren(group, materials);

    const steady = materials.take(art(), 0xffffff, []);
    expect(steady.uniforms[OUTLINE_ALPHA_UNIFORM]!.value).toBe(1);
  });

  /** A ghost's material is the pool's business only in that it is not. */
  it("frees a material it never lent", () => {
    const materials = new OutlineMaterials();
    const ghost = new THREE.MeshBasicMaterial();
    const freed = watchDispose(ghost);

    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.PlaneGeometry(8, 8), ghost));
    disposeGroupChildren(group, materials);

    expect(freed()).toBe(true);
  });

  it("frees what it is holding when the renderer goes", () => {
    const materials = new OutlineMaterials();
    const lent = materials.take(art(), 0xffffff, []);
    const spare = materials.take(art(), 0xffffff, []);
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.PlaneGeometry(8, 8), spare));
    disposeGroupChildren(group, materials);

    const lentFreed = watchDispose(lent);
    const spareFreed = watchDispose(spare);
    materials.dispose();

    expect([lentFreed(), spareFreed()]).toEqual([true, true]);
  });
});
