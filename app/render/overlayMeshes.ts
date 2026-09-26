import * as THREE from "three";
import { MAX_PILE_SPRITES } from "./pileLayout";
import type { SpriteQuad } from "./spriteQuad";

export const OVERLAY_RENDER_ORDER = {
  spriteFill: 1_000_000_010,
  spriteLift: 1_000_000_011,
  spriteOutline: 1_000_000_015,
  rect: 1_000_000_020,
} as const;

const HEAVY_INSET_PX = 0.5;
const HEAVY_INSET_OPACITY = 0.85;

export function makeRectOutline(
  originX: number,
  originY: number,
  w: number,
  h: number,
  color: number,
  heavy = false,
  opacity = 1,
): THREE.Line[] {
  const makeLine = (ox: number, oy: number, ww: number, hh: number, opacity: number) => {
    const pts = [
      new THREE.Vector3(ox, oy, 0),
      new THREE.Vector3(ox + ww, oy, 0),
      new THREE.Vector3(ox + ww, oy + hh, 0),
      new THREE.Vector3(ox, oy + hh, 0),
      new THREE.Vector3(ox, oy, 0),
    ];
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthTest: false,
        depthWrite: false,
      }),
    );
    line.renderOrder = OVERLAY_RENDER_ORDER.rect;
    line.matrixAutoUpdate = false;
    line.updateMatrix();
    return line;
  };

  const lines = [makeLine(originX, originY, w, h, opacity)];
  if (heavy) {
    lines.push(
      makeLine(
        originX + HEAVY_INSET_PX,
        originY + HEAVY_INSET_PX,
        w - HEAVY_INSET_PX * 2,
        h - HEAVY_INSET_PX * 2,
        HEAVY_INSET_OPACITY * opacity,
      ),
    );
  }
  return lines;
}

export type SpriteMeshOptions = {
  color: number;
  opacity: number;
  blending: THREE.Blending;
  renderOrder: number;
  alphaTest?: number;
};

export function makeSpriteMesh(quad: SpriteQuad, opts: SpriteMeshOptions): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(quad.w, quad.h);
  const uvs = geo.attributes.uv!;
  uvs.setXY(0, quad.u0, quad.v0);
  uvs.setXY(1, quad.u1, quad.v0);
  uvs.setXY(2, quad.u0, quad.v1);
  uvs.setXY(3, quad.u1, quad.v1);
  uvs.needsUpdate = true;

  const mat = new THREE.MeshBasicMaterial({
    map: quad.texture,
    color: opts.color,
    transparent: true,
    opacity: opts.opacity,
    blending: opts.blending,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    alphaTest: opts.alphaTest ?? 0,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(quad.x + quad.w / 2, quad.y + quad.h / 2, 0);
  mesh.renderOrder = opts.renderOrder;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

const OUTLINE_PAD_PX = 1;

export const BORROWED_GEOMETRY = "borrowedGeometry";

export const PULSE_PERIOD_MS = 1400;
const PULSE_MIN_ALPHA = 0.35;

export const OUTLINE_ALPHA_UNIFORM = "uAlpha";

export function pulseAlphaAt(elapsedMs: number): number {
  const phase = (elapsedMs % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
  const wave = (1 - Math.cos(phase * Math.PI * 2)) / 2;
  return PULSE_MIN_ALPHA + (1 - PULSE_MIN_ALPHA) * wave;
}

type OutlineArt = { texture: THREE.Texture; uvPerPx: THREE.Vector2 };

type OutlinePeers = readonly { dx: number; dy: number }[];

const MAX_OUTLINE_PEERS = MAX_PILE_SPRITES - 1;

function makeOutlineMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: null },
      uPx: { value: new THREE.Vector2() },
      uPad: { value: OUTLINE_PAD_PX },
      uColor: { value: new THREE.Color() },
      [OUTLINE_ALPHA_UNIFORM]: { value: 1 },
      uPeerCount: { value: 0 },
      uPeer: {
        value: Array.from({ length: MAX_OUTLINE_PEERS }, () => new THREE.Vector2()),
      },
    },
    vertexShader: `
      uniform vec2 uPx;
      uniform float uPad;
      varying vec2 vUv;
      varying vec2 vUvMin;
      varying vec2 vUvMax;
      void main() {
        vec2 grow = sign(position.xy);
        vec2 uvGrow = vec2(grow.x, -grow.y);
        vec2 span = abs(position.xy) * 2.0 * uPx;
        vUvMin = uv - step(0.0, uvGrow) * span;
        vUvMax = vUvMin + span;
        vUv = uv + uvGrow * uPad * uPx;
        gl_Position =
          projectionMatrix *
          modelViewMatrix *
          vec4(position + vec3(grow * uPad, 0.0), 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D map;
      uniform vec2 uPx;
      uniform vec3 uColor;
      uniform float uAlpha;
      uniform int uPeerCount;
      uniform vec2 uPeer[${MAX_OUTLINE_PEERS}];
      varying vec2 vUv;
      varying vec2 vUvMin;
      varying vec2 vUvMax;

      float sampleA(vec2 uv) {
        if (uv.x < vUvMin.x || uv.x >= vUvMax.x ||
            uv.y < vUvMin.y || uv.y >= vUvMax.y) {
          return 0.0;
        }
        return texture2D(map, uv).a;
      }

      float peerA(vec2 uv) {
        for (int i = 0; i < ${MAX_OUTLINE_PEERS}; i++) {
          if (i >= uPeerCount) break;
          vec2 step = vec2(uPeer[i].x * uPx.x, -uPeer[i].y * uPx.y);
          if (sampleA(uv + step) >= 0.5) return 1.0;
        }
        return 0.0;
      }

      float cornerTip(vec2 uv, vec2 d) {
        if (sampleA(uv + d) < 0.5) return 0.0;
        if (sampleA(uv + vec2(d.x * 2.0, 0.0)) >= 0.5) return 0.0;
        if (sampleA(uv + vec2(0.0, d.y * 2.0)) >= 0.5) return 0.0;
        return 1.0;
      }

      void main() {
        if (sampleA(vUv) >= 0.5) discard;
        if (peerA(vUv) >= 0.5) discard;

        float orth = max(
          max(sampleA(vUv + vec2(-uPx.x, 0.0)), sampleA(vUv + vec2(uPx.x, 0.0))),
          max(sampleA(vUv + vec2(0.0, -uPx.y)), sampleA(vUv + vec2(0.0, uPx.y)))
        );

        if (orth < 0.5) {
          float corner = max(
            max(cornerTip(vUv, vec2(-uPx.x, -uPx.y)), cornerTip(vUv, vec2(uPx.x, -uPx.y))),
            max(cornerTip(vUv, vec2(-uPx.x, uPx.y)), cornerTip(vUv, vec2(uPx.x, uPx.y)))
          );
          if (corner < 0.5) discard;
        }

        gl_FragColor = vec4(uColor, uAlpha);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

function dressOutline(
  material: THREE.ShaderMaterial,
  art: OutlineArt,
  color: number,
  peers: OutlinePeers,
) {
  const u = material.uniforms;
  u.map!.value = art.texture;
  (u.uPx!.value as THREE.Vector2).copy(art.uvPerPx);
  (u.uColor!.value as THREE.Color).set(color);
  u[OUTLINE_ALPHA_UNIFORM]!.value = 1;
  u.uPeerCount!.value = Math.min(peers.length, MAX_OUTLINE_PEERS);
  const slots = u.uPeer!.value as THREE.Vector2[];
  for (let i = 0; i < MAX_OUTLINE_PEERS; i++) {
    slots[i]!.set(peers[i]?.dx ?? 0, peers[i]?.dy ?? 0);
  }
}

export class OutlineMaterials {
  private free: THREE.ShaderMaterial[] = [];
  private lent = new Set<THREE.ShaderMaterial>();

  take(art: OutlineArt, color: number, peers: OutlinePeers): THREE.ShaderMaterial {
    const material = this.free.pop() ?? makeOutlineMaterial();
    dressOutline(material, art, color, peers);
    this.lent.add(material);
    return material;
  }

  reclaim(material: THREE.Material): boolean {
    if (!(material instanceof THREE.ShaderMaterial)) return false;
    if (!this.lent.delete(material)) return false;
    this.free.push(material);
    return true;
  }

  dispose() {
    for (const material of this.free) material.dispose();
    for (const material of this.lent) material.dispose();
    this.free = [];
    this.lent.clear();
  }
}

function outlineMesh(
  geometry: THREE.BufferGeometry,
  art: OutlineArt,
  color: number,
  materials: OutlineMaterials,
  peers: OutlinePeers = [],
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, materials.take(art, color, peers));
  mesh.renderOrder = OVERLAY_RENDER_ORDER.spriteOutline;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

export function makeSpriteOutline(
  quad: SpriteQuad,
  color: number,
  materials: OutlineMaterials,
  peers: OutlinePeers = [],
): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(quad.w, quad.h);
  const uvs = geo.attributes.uv!;
  uvs.setXY(0, quad.u0, quad.v0);
  uvs.setXY(1, quad.u1, quad.v0);
  uvs.setXY(2, quad.u0, quad.v1);
  uvs.setXY(3, quad.u1, quad.v1);
  uvs.needsUpdate = true;

  const mesh = outlineMesh(
    geo,
    {
      texture: quad.texture,
      uvPerPx: new THREE.Vector2((quad.u1 - quad.u0) / quad.w, (quad.v1 - quad.v0) / quad.h),
    },
    color,
    materials,
    peers,
  );
  mesh.position.set(quad.x + quad.w / 2, quad.y + quad.h / 2, 0);
  mesh.updateMatrix();
  return mesh;
}

export function makeFollowingSpriteOutline(
  source: THREE.Mesh,
  color: number,
  materials: OutlineMaterials,
): THREE.Mesh | null {
  const texture = (source.material as THREE.MeshBasicMaterial).map;
  const uvPerPx = uvPerWorldPx(source.geometry);
  if (!texture || !uvPerPx) return null;

  const mesh = outlineMesh(source.geometry, { texture, uvPerPx }, color, materials);
  mesh.userData[BORROWED_GEOMETRY] = true;
  mesh.matrix.copy(source.matrixWorld);
  mesh.matrixWorld.copy(source.matrixWorld);
  return mesh;
}

function uvPerWorldPx(geo: THREE.BufferGeometry): THREE.Vector2 | null {
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  if (!pos || !uv || pos.count < 3) return null;
  const w = Math.abs(pos.getX(1) - pos.getX(0));
  const h = Math.abs(pos.getY(2) - pos.getY(0));
  if (w === 0 || h === 0) return null;
  return new THREE.Vector2(
    Math.abs(uv.getX(1) - uv.getX(0)) / w,
    Math.abs(uv.getY(2) - uv.getY(0)) / h,
  );
}

export function disposeGroupChildren(group: THREE.Group, outlines?: OutlineMaterials) {
  const release = (material: THREE.Material) => {
    if (outlines?.reclaim(material)) return;
    material.dispose();
  };

  while (group.children.length) {
    const child = group.children.pop()!;
    const mesh = child as THREE.Mesh;
    if (!mesh.userData[BORROWED_GEOMETRY]) mesh.geometry?.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach(release);
    else if (mat) release(mat);
  }
}

export function makeSpriteGhost(quad: SpriteQuad, alpha: number): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(quad.w, quad.h);
  const uvs = geo.attributes.uv!;
  uvs.setXY(0, quad.u0, quad.v0);
  uvs.setXY(1, quad.u1, quad.v0);
  uvs.setXY(2, quad.u0, quad.v1);
  uvs.setXY(3, quad.u1, quad.v1);
  uvs.needsUpdate = true;

  const mat = new THREE.MeshBasicMaterial({
    map: quad.texture,
    transparent: true,
    opacity: alpha,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(quad.x + quad.w / 2, quad.y + quad.h / 2, 0);
  mesh.renderOrder = OVERLAY_RENDER_ORDER.spriteOutline;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}
