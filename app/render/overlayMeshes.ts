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
 * Marks an overlay whose geometry belongs to the world mesh it follows, so
 * emptying the chrome layer frees the material and leaves the sprite's own
 * buffers alone. Disposing them would take the tile down with the outline.
 */
export const BORROWED_GEOMETRY = "borrowedGeometry";

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
 * The atlas a silhouette is read out of, and how much uv one world pixel spans.
 *
 * Both hold for a placement across every frame and every `SpriteState` it can be
 * in: the frames of a sprite share one rect by construction, a state's sprites
 * are validated against idle's, and a mesh keeps the tileset it was built with.
 * That invariance is what lets an outline be built once and then left alone
 * while the sprite underneath it animates.
 */
type OutlineArt = { texture: THREE.Texture; uvPerPx: THREE.Vector2 };

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
 * The geometry is the sprite's own footprint and the vertex shader grows it by a
 * world pixel, rather than the mesh being built a pixel larger. That is what
 * lets an outline share the quad the world is drawing — see
 * {@link makeFollowingSpriteOutline} — since a shared buffer cannot be padded
 * for one of its readers. UVs outside the sprite rect count as transparent so
 * neighbouring atlas tiles never bleed in, and one pixel is all the growth
 * needed: only texels within a pixel of the sprite are ever *shaded*, and the
 * probes reaching two texels further are reads, which the rect test guards.
 *
 * The alpha is a uniform so a breathing outline costs a number written per frame
 * rather than a mesh rebuilt per frame — see {@link OUTLINE_ALPHA_UNIFORM} and
 * `WorldRenderer.tick`. A steady outline simply never has it written again.
 */
function outlineMesh(
  geometry: THREE.BufferGeometry,
  art: OutlineArt,
  color: number,
): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: art.texture },
      uPx: { value: art.uvPerPx },
      uPad: { value: OUTLINE_PAD_PX },
      uColor: { value: new THREE.Color(color) },
      [OUTLINE_ALPHA_UNIFORM]: { value: 1 },
    },
    vertexShader: /* glsl */ `
      uniform vec2 uPx;
      uniform float uPad;
      varying vec2 vUv;
      varying vec2 vUvMin;
      varying vec2 vUvMax;
      void main() {
        // The quad is centred on its own origin, so a corner's sign is the
        // direction it grows in and |position| * 2 is the sprite's footprint.
        // Between them every vertex can work out the frame's uv rect for itself,
        // which is the point: there is no uniform for anyone to rewrite when the
        // frame flips underneath.
        vec2 grow = sign(position.xy);
        // uv runs down the atlas while the mesh runs up the screen, so the top
        // corners carry the *smaller* v.
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
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform vec2 uPx;
      uniform vec3 uColor;
      uniform float uAlpha;
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

  const mesh = new THREE.Mesh(geometry, mat);
  mesh.renderOrder = OVERLAY_RENDER_ORDER.spriteOutline;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

/**
 * An outline cut from the map, for a tile the world draws inside a merged batch.
 *
 * It owns its quad because there is no single mesh to point at, and it can:
 * a tile only joins a batch when it can neither animate nor move, so the frame
 * this is cut from is the only frame it will ever have.
 */
export function makeSpriteOutline(quad: SpriteQuad, color: number): THREE.Mesh {
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
      uvPerPx: new THREE.Vector2(
        (quad.u1 - quad.u0) / quad.w,
        (quad.v1 - quad.v0) / quad.h,
      ),
    },
    color,
  );
  mesh.position.set(quad.x + quad.w / 2, quad.y + quad.h / 2, 0);
  mesh.updateMatrix();
  return mesh;
}

/**
 * An outline around the mesh the world is drawing, sharing its geometry.
 *
 * The sprite's own quad *is* the silhouette: the buffer this reads its uvs from
 * is the buffer the frame flip writes to and the state swap rewrites, and the
 * matrix is the one the walk lerp moves. So the outline is on the frame the
 * player is looking at, in the pose it is in, at the pixel it was drawn at,
 * because there is only one copy of each of those facts. Nothing here has to be
 * told that a sprite animated, and nothing can be told a frame late.
 *
 * Returns null for a mesh with no texture, which is a tileset still in flight
 * rather than a sprite worth outlining.
 *
 * The caller keeps the matrix in step — see `WorldRenderer.syncFollowingOutlines`
 * — since the chrome is a separate scene and cannot simply be parented.
 */
export function makeFollowingSpriteOutline(
  source: THREE.Mesh,
  color: number,
): THREE.Mesh | null {
  const texture = (source.material as THREE.MeshBasicMaterial).map;
  const uvPerPx = uvPerWorldPx(source.geometry);
  if (!texture || !uvPerPx) return null;

  const mesh = outlineMesh(source.geometry, { texture, uvPerPx }, color);
  mesh.userData[BORROWED_GEOMETRY] = true;
  mesh.matrix.copy(source.matrixWorld);
  mesh.matrixWorld.copy(source.matrixWorld);
  return mesh;
}

/**
 * How much uv a world pixel covers on this quad, read off the quad itself.
 *
 * One over the tileset's width and height, worked out from the corners rather
 * than passed in, so an outline needs nothing from the caller that the mesh it
 * follows does not already carry. Frame-invariant: every frame of a sprite
 * covers the same rect, so the ratio survives the uvs being rewritten.
 *
 * Vertex order is the one shared by `PlaneGeometry` and `buildSingleQuadGeometry`
 * — 0 and 1 are the two ends of the top edge, 0 and 2 the two ends of the left.
 */
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

/** Empty an overlay group, freeing the throwaway geometry and materials. */
export function disposeGroupChildren(group: THREE.Group) {
  while (group.children.length) {
    const child = group.children.pop()!;
    const mesh = child as THREE.Mesh;
    // Everything here is throwaway except a borrowed quad, which belongs to a
    // tile that is still on screen — see {@link BORROWED_GEOMETRY}.
    if (!mesh.userData[BORROWED_GEOMETRY]) mesh.geometry?.dispose();
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
