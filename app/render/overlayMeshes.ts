import * as THREE from "three";
import type { SpriteQuad } from "./spriteQuad";

/**
 * Chrome sits far past any world draw order so it always wins, and the layers
 * within it are ordered fill → lift → silhouette → line.
 */
export const OVERLAY_RENDER_ORDER = {
  spriteFill: 1_000_000_010,
  spriteLift: 1_000_000_011,
  spriteOutline: 1_000_000_015,
  rect: 1_000_000_020,
  /** Health bars, over every outline: a bar is read, not aimed at. */
  bar: 1_000_000_025,
} as const;

/** Second inset line for a heavy outline; keeps 1px art readable at low zoom. */
const HEAVY_INSET_PX = 0.5;
const HEAVY_INSET_OPACITY = 0.85;

/**
 * Axis-aligned outline in world pixels — an explicit 5-point line, not
 * EdgesGeometry, which is unreliable under the Y-down ortho camera.
 */
export function makeRectOutline(
  originX: number,
  originY: number,
  w: number,
  h: number,
  color: number,
  heavy = false,
): THREE.Line[] {
  const makeLine = (
    ox: number,
    oy: number,
    ww: number,
    hh: number,
    opacity: number,
  ) => {
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

  const lines = [makeLine(originX, originY, w, h, 1)];
  if (heavy) {
    lines.push(
      makeLine(
        originX + HEAVY_INSET_PX,
        originY + HEAVY_INSET_PX,
        w - HEAVY_INSET_PX * 2,
        h - HEAVY_INSET_PX * 2,
        HEAVY_INSET_OPACITY,
      ),
    );
  }
  return lines;
}

/**
 * A flat rectangle in world pixels — the whole of what a health bar is made of.
 *
 * World pixels rather than screen pixels, unlike the text in `./textLabels`. A
 * bar has no glyphs to keep crisp, and drawing it at the art's own scale is what
 * makes it look like part of the game rather than like a widget floating over
 * it: at 3× zoom a two-pixel bar is six screen pixels, exactly as a two-pixel
 * sprite detail is.
 */
export function makeFilledRect(
  x: number,
  y: number,
  w: number,
  h: number,
  color: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({
      color,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  );
  mesh.position.set(x + w / 2, y + h / 2, 0);
  mesh.renderOrder = OVERLAY_RENDER_ORDER.bar;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

export type SpriteMeshOptions = {
  color: number;
  opacity: number;
  blending: THREE.Blending;
  renderOrder: number;
  /** Match world cutouts when covering lit tiles. */
  alphaTest?: number;
};

export function makeSpriteMesh(
  quad: SpriteQuad,
  opts: SpriteMeshOptions,
): THREE.Mesh {
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

/**
 * 1px outer silhouette outline via alpha edge detect.
 * Mesh is padded 1 world-px; UVs outside the sprite rect count as
 * transparent so neighbouring atlas tiles never bleed in.
 */
export function makeSpriteOutline(quad: SpriteQuad, color: number): THREE.Mesh {
  const pad = OUTLINE_PAD_PX;
  const du = (quad.u1 - quad.u0) / quad.w;
  const dv = (quad.v1 - quad.v0) / quad.h;
  const geo = new THREE.PlaneGeometry(quad.w + pad * 2, quad.h + pad * 2);
  const uvs = geo.attributes.uv!;
  uvs.setXY(0, quad.u0 - du * pad, quad.v0 - dv * pad);
  uvs.setXY(1, quad.u1 + du * pad, quad.v0 - dv * pad);
  uvs.setXY(2, quad.u0 - du * pad, quad.v1 + dv * pad);
  uvs.setXY(3, quad.u1 + du * pad, quad.v1 + dv * pad);
  uvs.needsUpdate = true;

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: quad.texture },
      uUvMin: { value: new THREE.Vector2(quad.u0, quad.v0) },
      uUvMax: { value: new THREE.Vector2(quad.u1, quad.v1) },
      uPx: { value: new THREE.Vector2(du, dv) },
      uColor: { value: new THREE.Color(color) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform vec2 uUvMin;
      uniform vec2 uUvMax;
      uniform vec2 uPx;
      uniform vec3 uColor;
      varying vec2 vUv;

      float sampleA(vec2 uv) {
        if (uv.x < uUvMin.x || uv.x >= uUvMax.x ||
            uv.y < uUvMin.y || uv.y >= uUvMax.y) {
          return 0.0;
        }
        return texture2D(map, uv).a;
      }

      void main() {
        // Outer ring only — opaque texels belong to the sprite itself.
        if (sampleA(vUv) >= 0.5) discard;

        // 4-connected only: including diagonals fattens stair-step edges
        // (corner-touch pixels fill the staircase and read as ~2px thick).
        float n = max(
          max(sampleA(vUv + vec2(-uPx.x, 0.0)), sampleA(vUv + vec2(uPx.x, 0.0))),
          max(sampleA(vUv + vec2(0.0, -uPx.y)), sampleA(vUv + vec2(0.0, uPx.y)))
        );
        if (n < 0.5) discard;

        gl_FragColor = vec4(uColor, 1.0);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(quad.x + quad.w / 2, quad.y + quad.h / 2, 0);
  mesh.renderOrder = OVERLAY_RENDER_ORDER.spriteOutline;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

/** Empty an overlay group, freeing the throwaway geometry and materials. */
export function disposeGroupChildren(group: THREE.Group) {
  while (group.children.length) {
    const child = group.children.pop()!;
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose?.();
  }
}
