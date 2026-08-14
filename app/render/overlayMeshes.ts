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
 * How a chosen outline breathes: seconds per cycle, and how far down it dips.
 *
 * Slow enough to read as deliberate rather than as a warning light, and it never
 * goes out — a target that blinked away entirely would leave the player unsure
 * for half a second each cycle whether they still had one.
 */
export const PULSE_PERIOD_MS = 1400;
const PULSE_MIN_ALPHA = 0.35;

/**
 * The outline shader's alpha, named once so the renderer writing it every frame
 * and the shader reading it cannot drift apart over a typo.
 */
export const OUTLINE_ALPHA_UNIFORM = "uAlpha";

/** How lit an outline is this instant. Shared, so every one breathes together. */
export function pulseAlphaAt(elapsedMs: number): number {
  const phase = (elapsedMs % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
  // Cosine rather than a triangle: the ends of a linear ramp read as two
  // separate flicks rather than as one breath.
  const wave = (1 - Math.cos(phase * Math.PI * 2)) / 2;
  return PULSE_MIN_ALPHA + (1 - PULSE_MIN_ALPHA) * wave;
}

/**
 * 1px outer silhouette outline via alpha edge detect: four-connected, plus the
 * corner tips four-connected leaves off.
 *
 * ```
 * ####          # outline
 * #•••#         • sprite
 *  #•••#
 *   ####
 * ```
 *
 * The two tips at the ends are the whole difference. Four-connected alone leaves
 * them open, so a sharp corner reads chamfered; eight-connected closes them and
 * also doubles the width of every diagonal edge, which is worse. `cornerTip` in
 * the shader is what tells the two apart.
 *
 * Mesh is padded 1 world-px; UVs outside the sprite rect count as transparent so
 * neighbouring atlas tiles never bleed in. One pixel is all the padding needed:
 * only texels within a pixel of the sprite are ever *shaded*, and the probes
 * reaching two texels further are reads, which the rect test already guards.
 *
 * The alpha is a uniform so a breathing outline costs a number written per frame
 * rather than a mesh rebuilt per frame — see {@link OUTLINE_ALPHA_UNIFORM} and
 * `WorldRenderer.tick`. A steady outline simply never has it written again.
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
      [OUTLINE_ALPHA_UNIFORM]: { value: 1 },
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
      uniform float uAlpha;
      varying vec2 vUv;

      float sampleA(vec2 uv) {
        if (uv.x < uUvMin.x || uv.x >= uUvMax.x ||
            uv.y < uUvMin.y || uv.y >= uUvMax.y) {
          return 0.0;
        }
        return texture2D(map, uv).a;
      }

      // Is this texel the missing tip of a corner, or the crook of a staircase?
      //
      // Both look identical up close: an empty texel with the silhouette sitting
      // diagonally across from it and nothing on either side. Filling every one
      // of them is 8-connected, and that is what doubles a 45-degree edge —
      // every step along the diagonal has a crook, so the band comes out two
      // texels thick instead of one.
      //
      // What separates them is one texel further out. Walk two texels toward the
      // silhouette along each axis: at a real corner you are walking away from
      // the shape and find nothing, while in a crook the next step of the
      // staircase has already come back around to meet you. So the diagonal only
      // counts when both those probes come up empty.
      float cornerTip(vec2 uv, vec2 d) {
        if (sampleA(uv + d) < 0.5) return 0.0;
        if (sampleA(uv + vec2(d.x * 2.0, 0.0)) >= 0.5) return 0.0;
        if (sampleA(uv + vec2(0.0, d.y * 2.0)) >= 0.5) return 0.0;
        return 1.0;
      }

      void main() {
        // Outer ring only — opaque texels belong to the sprite itself.
        if (sampleA(vUv) >= 0.5) discard;

        // The four sides. Every texel touching the silhouette edge-on is outline,
        // and this alone is the whole outline everywhere except at a corner.
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

/**
 * A tile drawn where it *would* land, see-through so it reads as a proposal.
 *
 * Deliberately the sprite itself rather than a coloured box: what a player is
 * deciding is where this particular thing goes, and a shape standing in for it
 * would make them imagine the answer the picture could simply show. Half
 * transparent is the whole of "not there yet".
 *
 * `depthWrite` is off so the ghost never occludes the world it is a proposal
 * about, and the geometry is the quad's own footprint with the atlas rect on it
 * — no padding, unlike an outline, since nothing here is probing neighbouring
 * texels.
 */
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
