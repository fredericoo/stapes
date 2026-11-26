import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { MAX_PILE_SPRITES, pileOffsets, pileRings } from "./pileLayout";
import { depthBox } from "../lib/geometry";
import { buildSpreadQuadGeometry } from "./worldQuads";
import {
  OUTLINE_ALPHA_UNIFORM,
  OutlineMaterials,
  PULSE_PERIOD_MS,
  disposeGroupChildren,
  followSource,
  makeFollowingPileOutlines,
  makeFollowingSpriteOutline,
  makeSpriteOutline,
  pulseAlphaAt,
} from "./overlayMeshes";

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
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: new THREE.Texture() }));
    mesh.position.set(40, 24, 0);
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);
    return mesh;
  }

  it("lands on the sprite, lerp and all", () => {
    const source = sourceMesh();
    const outline = makeFollowingSpriteOutline(source, 0xffffff, materials)!;
    expect(outline.matrixWorld.elements).toEqual(source.matrixWorld.elements);
  });

  it("reads the atlas scale off the mesh", () => {
    const outline = makeFollowingSpriteOutline(sourceMesh(), 0xffffff, materials)!;
    const px = (outline.material as THREE.ShaderMaterial).uniforms.uPx!.value;
    expect(px.x).toBeCloseTo(1 / TILESET_PX, 6);
    expect(px.y).toBeCloseTo(1 / TILESET_PX, 6);
  });

  it("reads the frame the sprite is on, however many times it flips", () => {
    const source = sourceMesh();
    const outline = makeFollowingSpriteOutline(source, 0xffffff, materials)!;
    const flipTo = (u: number) => {
      const uvs = source.geometry.attributes.uv!;
      uvs.setXY(0, u, 0);
      uvs.needsUpdate = true;
    };

    const seen = [];
    for (const u of [0.25, 0.5, 0.75]) {
      flipTo(u);
      seen.push(outline.geometry.attributes.uv!.getX(0));
    }

    expect(seen).toEqual([0.25, 0.5, 0.75]);
  });

  it("points a reused material at the sprite it is now following", () => {
    const first = sourceMesh();
    const group = new THREE.Group();
    group.add(makeFollowingSpriteOutline(first, 0xffffff, materials)!);
    disposeGroupChildren(group, materials);

    const second = sourceMesh();
    const outline = makeFollowingSpriteOutline(second, 0xffffff, materials)!;
    const map = (outline.material as THREE.ShaderMaterial).uniforms.map!.value;
    expect(map).toBe((second.material as THREE.MeshBasicMaterial).map);
  });

  it("gives up on a mesh with no art rather than outlining nothing", () => {
    const source = sourceMesh();
    (source.material as THREE.MeshBasicMaterial).map = null;
    expect(makeFollowingSpriteOutline(source, 0xffffff, materials)).toBeNull();
  });

  it("is thrown away without taking the sprite's quad with it", () => {
    const source = sourceMesh();
    let quadFreed = false;
    source.geometry.addEventListener("dispose", () => {
      quadFreed = true;
    });
    const group = new THREE.Group();
    group.add(makeFollowingSpriteOutline(source, 0xffffff, materials)!);
    disposeGroupChildren(group, materials);
    expect(quadFreed).toBe(false);
    expect(group.children).toHaveLength(0);
  });
});

describe("OutlineMaterials", () => {
  const art = () => ({
    texture: new THREE.Texture(),
    uvPerPx: new THREE.Vector2(1 / 256, 1 / 256),
  });

  function watchDispose(material: THREE.Material): () => boolean {
    let freed = false;
    material.addEventListener("dispose", () => {
      freed = true;
    });
    return () => freed;
  }

  it("keeps the material when the chrome layer is emptied", () => {
    const materials = new OutlineMaterials();
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), materials.take(art(), 0xffffff, []));
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

describe("makeSpriteOutline, around a heap", () => {
  const quad = () => ({
    x: 0,
    y: 0,
    w: 8,
    h: 8,
    texture: new THREE.Texture(),
    u0: 0,
    v0: 0,
    u1: 1 / 32,
    v1: 1 / 32,
  });
  const uniformsOf = (mesh: THREE.Mesh) => (mesh.material as THREE.ShaderMaterial).uniforms;

  it("tells a ring how many siblings it has, and where each one is", () => {
    const materials = new OutlineMaterials();
    const ring = pileRings(5)[2]!;
    const outline = makeSpriteOutline(quad(), 0xffffff, materials, ring.peers);

    const u = uniformsOf(outline);
    expect(u.uPeerCount!.value).toBe(4);
    expect(
      (u.uPeer!.value as THREE.Vector2[]).slice(0, 4).map((v) => ({ dx: v.x, dy: v.y })),
    ).toEqual([...ring.peers]);
  });

  it("tells a lone sprite it has none", () => {
    const materials = new OutlineMaterials();
    const outline = makeSpriteOutline(quad(), 0xffffff, materials);
    expect(uniformsOf(outline).uPeerCount!.value).toBe(0);
  });

  it("clears a borrowed material's peers when the next has none", () => {
    const materials = new OutlineMaterials();
    const group = new THREE.Group();
    group.add(
      makeSpriteOutline(quad(), 0xffffff, materials, pileRings(MAX_PILE_SPRITES)[0]!.peers),
    );
    disposeGroupChildren(group, materials);

    const lone = makeSpriteOutline(quad(), 0xffffff, materials);
    const u = uniformsOf(lone);
    expect(u.uPeerCount!.value).toBe(0);
    expect((u.uPeer!.value as THREE.Vector2[]).every((v) => v.x === 0 && v.y === 0)).toBe(true);
  });

  it("never lends one material to two rings of the same heap", () => {
    const materials = new OutlineMaterials();
    const rings = pileRings(6);
    const outlines = rings.map((ring) =>
      makeSpriteOutline(quad(), 0xffffff, materials, ring.peers),
    );
    expect(new Set(outlines.map((o) => o.material)).size).toBe(rings.length);
  });
});

describe("makeFollowingPileOutlines", () => {
  const SPRITE = {
    w: 8,
    h: 8,
    u0: 0,
    v0: 0,
    u1: 1 / 32,
    v1: 1 / 32,
    box: depthBox(2, 3, 0, 1),
    stackBias: 0,
    lightX0: 0,
    lightY0: 0,
    lightX1: 1,
    lightY1: 1,
    unlit: false,
  };

  function movingPile(count: number) {
    const geometry = buildSpreadQuadGeometry(
      SPRITE,
      pileOffsets(count).map((o) => ({ ...o, stackNudge: 0 })),
    );
    const source = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ map: new THREE.Texture() }),
    );
    source.position.set(40, 24, 0);
    source.updateMatrixWorld(true);
    return source;
  }

  const cornersOf = (mesh: THREE.Mesh, world: boolean) => {
    const pos = mesh.geometry.attributes.position!;
    return Array.from({ length: 4 }, (_, v) => {
      const p = new THREE.Vector3().fromBufferAttribute(pos, v);
      if (world) p.applyMatrix4(mesh.matrixWorld);
      return [p.x, p.y];
    });
  };

  /** The outline shader reads a corner and the sprite's size off a vertex's position, so a ring offset from its origin samples the wrong texels. */
  it("centres each ring on its own sprite and keeps it where the sprite is drawn", () => {
    const count = 5;
    const source = movingPile(count);
    const rings = makeFollowingPileOutlines(
      source,
      pileRings(count),
      0xffffff,
      new OutlineMaterials(),
    );

    expect(rings).toHaveLength(count);
    rings.forEach((ring, i) => {
      expect(cornersOf(ring, false)).toEqual([
        [-4, 4],
        [4, 4],
        [-4, -4],
        [4, -4],
      ]);
      const pos = source.geometry.attributes.position!;
      const drawn = Array.from({ length: 4 }, (_, v) => {
        const p = new THREE.Vector3()
          .fromBufferAttribute(pos, i * 4 + v)
          .applyMatrix4(source.matrixWorld);
        return [p.x, p.y];
      });
      expect(cornersOf(ring, true)).toEqual(drawn);
    });
  });

  it("follows the pile when it moves", () => {
    const source = movingPile(2);
    const [ring] = makeFollowingPileOutlines(
      source,
      pileRings(2),
      0xffffff,
      new OutlineMaterials(),
    );
    source.position.set(41, 30, 0);
    source.updateMatrixWorld(true);
    followSource(ring!, source);

    const first = new THREE.Vector3().fromBufferAttribute(source.geometry.attributes.position!, 0);
    expect(cornersOf(ring!, true)[0]).toEqual([first.x + 41, first.y + 30]);
  });
});
