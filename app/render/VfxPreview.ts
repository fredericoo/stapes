import * as THREE from "three";
import { tilesetUrl } from "../lib/api";
import {
  baseCellWorldOrigin,
  depthBox,
  depthStackBias,
  spriteWorldOrigin,
} from "../lib/geometry";
import { hexToRgb01, STAPES_PALETTE } from "../lib/palette";
import { taperedGlow, taperedTint, type StatusVfx } from "../lib/statusVfx";
import { getFrames } from "../lib/tileResolve";
import type { Frame, TileDef, TilesetDef } from "../lib/types";
import { CELL_SIZE, frameIndexAtTime, HEIGHT_PER_LEVEL } from "../lib/types";
import { ParticleLayer } from "./particleLayer";
import type { ParticleEmitterSpec } from "./particles";
import { PalettePass } from "./palettePass";
import {
  noTintUniforms,
  type TintUniforms,
  writeTintUniforms,
} from "./spriteTint";
import {
  buildSingleQuadGeometry,
  injectWorldShader,
  type LevelLightUniforms,
  type Quad,
  WORLD_SHADER_CACHE_KEY,
} from "./worldQuads";

/**
 * The status editor's rendering simulation: one sprite, one plume, one palette.
 *
 * ## Why this is not a `WorldRenderer`
 *
 * The obvious move is to build a one-tile map and hand it to the real renderer,
 * and it is the wrong one: that renderer is a light baker, a chunk cache, an
 * incremental level rebuilder and a roof cut, none of which have anything to say
 * about what a plume looks like. What the author is asking is a narrow question —
 * *this colour on this sprite, these particles over it, through the palette* —
 * and the honest way to answer it is to share the parts that decide the answer
 * and skip the parts that do not.
 *
 * So what is shared is everything that could make the preview lie:
 *
 * - the **particle simulation and layer** (`./particles`, `./particleLayer`),
 *   the same objects play uses, driven by the same clock;
 * - the **tint material** (`./spriteTint` through `injectWorldShader`), so the
 *   OKLab mix is not reimplemented here and cannot drift;
 * - the **palette pass** (`./palettePass`), which is what makes an off-ramp hex
 *   land where it will land in the world rather than where it was typed.
 *
 * What is not shared is lighting. The preview is lit flat and deliberately: an
 * author tuning a fire wants to see the fire, not the fire at nine in the
 * evening in a room with a lantern in it. The world's own light will darken it
 * exactly as it darkens every other sprite.
 *
 * ## What it can draw on
 *
 * Any tile in the catalogue — that is the whole point of taking a `TileDef`
 * rather than a `SpriteRef`. A bush cannot yet *carry* a status in play (see
 * `./spriteTint` for why a merged tile has no material of its own), but it can
 * be designed here, which is the order these two things were always going to
 * arrive in.
 */

/** How many cells of world fit across the preview. */
const PREVIEW_CELLS_ACROSS = 9;

/** Where the subject stands: the middle of the ground, so the view is centred. */
const SUBJECT_CELL = { x: 4, y: 4 };

/**
 * Ground cells drawn past the visible span, on every side.
 *
 * The camera is centred on the subject and fitted to the shorter side of the
 * canvas, so a panel that is not square sees further along one axis than the
 * other. A grid sized exactly to the span therefore ran out along the long axis
 * and left a bar of clear colour at the edge. Cheap insurance: this is a few
 * dozen quads drawn once.
 */
const FLOOR_MARGIN_CELLS = 4;

/** Ground squares, so the sprite has a floor and the author has a sense of scale. */
const FLOOR_LIGHT = "#4d65b4";
const FLOOR_DARK = "#484a77";

/** Behind everything, and never depth-tested — it is a backdrop, not a floor. */
const FLOOR_RENDER_ORDER = -1;

/** The plume's own id. One subject, one status, so it never needs to vary. */
const PREVIEW_EMITTER_ID = "preview";

/**
 * Longest a frame may claim to be, in milliseconds.
 *
 * A tab left in the background stops firing animation frames, and the first one
 * after it comes back carries the whole gap. Without this the plume would
 * advance by minutes in a single step — every particle dead, every debt spent —
 * and the author would come back to an empty canvas that fills again a second
 * later. The same clamp the play loop applies, for the same reason.
 */
const MAX_FRAME_MS = 100;

export class VfxPreview {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly palettePass = new PalettePass();
  private readonly particles: ParticleLayer;
  private readonly lightUniforms: LevelLightUniforms;
  private readonly whiteTex: THREE.DataTexture;
  /**
   * A light map that says "no block light here", so the ambient decides
   * everything.
   *
   * The white one cannot: the shader reads `texel.a * uAmbient + texel.rgb`, and
   * white has `rgb = 1`, which saturates to full brightness whatever the ambient
   * is. Dimming needs a texel with alpha and no colour.
   */
  private readonly darkTex: THREE.DataTexture;
  private night = false;
  /**
   * Where the scrubber has the effect wound down to, 1 being untouched.
   *
   * Scrubbed rather than run, because the preview has no clock and no status: a
   * fade the author had to wait thirty seconds to see the end of is a fade
   * nobody would tune. @see setTaper
   */
  private taper = 1;
  /**
   * The subject's tint, held rather than rebuilt.
   *
   * `injectWorldShader` binds these by reference, so retinting is three number
   * writes — which is what lets a dragged slider recolour the sprite without
   * throwing the material away sixty times a second.
   */
  private readonly tintU: TintUniforms = noTintUniforms();

  private subject: THREE.Mesh | null = null;
  private subjectMaterial: THREE.MeshBasicMaterial | null = null;
  private texture: THREE.Texture | null = null;
  private frames: Frame[] = [];
  private tileset: TilesetDef | null = null;
  private def: TileDef | null = null;
  private frameIdx = -1;

  private vfx: StatusVfx = {
    tint: null,
    particles: null,
    light: null,
    taperMs: 0,
  };
  private clockMs = 0;
  private lastFrameMs = 0;
  private raf = 0;
  private running = false;
  private disposed = false;
  /** Bumped per load, so a slow texture cannot land on a subject already replaced. */
  private loadToken = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.renderer.setPixelRatio(1);
    this.renderer.autoClear = true;

    this.scene.matrixWorldAutoUpdate = false;
    this.camera = new THREE.OrthographicCamera(0, 1, 0, 1, -10, 50);
    this.camera.position.z = 25;

    // Flat white, so the shared world shader's light multiply is the identity.
    // See the class note: the preview answers a question about colour, and a
    // clock would be a second variable in the answer.
    const white = new Uint8Array([255, 255, 255, 255]);
    this.whiteTex = new THREE.DataTexture(white, 1, 1, THREE.RGBAFormat);
    this.whiteTex.needsUpdate = true;
    const dark = new Uint8Array([0, 0, 0, 255]);
    this.darkTex = new THREE.DataTexture(dark, 1, 1, THREE.RGBAFormat);
    this.darkTex.needsUpdate = true;
    this.lightUniforms = {
      uLightMap: { value: this.whiteTex },
      uLightOrigin: { value: new THREE.Vector2(0, 0) },
      uLightSize: { value: new THREE.Vector2(1, 1) },
      uLightingEnabled: { value: 0 },
      uAmbient: { value: new THREE.Vector3(1, 1, 1) },
    };

    this.scene.add(this.buildFloor());
    // One set for every level, because the preview is one tile on one floor —
    // there is no second storey here for a plume to be lit by the wrong room.
    this.particles = new ParticleLayer(() => this.lightUniforms);
    this.scene.add(this.particles.mesh);
    this.particles.mesh.updateMatrixWorld(true);
  }

  /**
   * Draw the effect on this tile.
   *
   * Null clears the subject and leaves the plume over bare ground, which is a
   * useful thing to look at on its own — an emitter is easier to judge without a
   * sprite in front of half of it.
   *
   * **Compared by object, not by id**, because one caller's subject is a tile
   * being edited: the tile dialog hands over its own draft, whose art changes
   * under it while the dialog is open, and an id comparison would leave the
   * preview showing the sprite the tile had when it was opened. The status
   * editor picks from the catalogue, where the defs are stable objects, so it
   * still costs it nothing.
   *
   * The sheet is only re-fetched when the *tileset* changes. Without that, a
   * dragged slider on a draft would re-download a tilesheet a frame.
   */
  setSubject(def: TileDef | null, tilesets: readonly TilesetDef[]) {
    if (def === this.def) return;
    const heldTilesetId = this.tileset?.id;
    const held = this.texture;
    this.def = def;
    // The texture is handed back if the next subject can use it, so `clearSubject`
    // does not dispose the thing that is about to be re-bound.
    this.texture = null;
    this.clearSubject();
    if (!def) {
      held?.dispose();
      return;
    }

    const frames = getFrames(def, {});
    const first = frames?.[0];
    if (!first) {
      held?.dispose();
      return;
    }
    const tileset = tilesets.find((t) => t.id === first.sprite.tilesetId);
    if (!tileset) {
      held?.dispose();
      return;
    }

    this.frames = frames;
    this.tileset = tileset;

    if (held && tileset.id === heldTilesetId) {
      this.texture = held;
      this.buildSubject();
      return;
    }
    held?.dispose();

    const token = ++this.loadToken;
    const loader = new THREE.TextureLoader();
    void loader
      .loadAsync(tilesetUrl(tileset.file))
      .then((tex) => {
        // The author can change subject faster than a sheet loads, and a texture
        // arriving for a tile nobody is looking at any more must not replace the
        // one they are.
        if (this.disposed || token !== this.loadToken) {
          tex.dispose();
          return;
        }
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.flipY = true;
        tex.needsUpdate = true;
        this.texture = tex;
        this.buildSubject();
      })
      .catch((err) => {
        console.warn(`preview tileset failed to load: ${tileset.file}`, err);
      });
  }

  /** Change what is being previewed. Cheap enough to call on every keystroke. */
  setVfx(vfx: StatusVfx) {
    this.vfx = vfx;
    this.applyTint();
    this.applyLighting();
    this.particles.setEmitters(this.emitterSpecs());
  }

  /**
   * Put the subject in an unlit room, or back in daylight.
   *
   * The only way the editor can show what `lit` means. In daylight the shader's
   * light step is skipped outright and everything is drawn at its authored
   * colour, which is the right thing to tune a ramp against; at night the room
   * goes dark and the difference between a spark that lights itself and a bubble
   * the room lights is the whole picture.
   */
  setNight(night: boolean) {
    this.night = night;
    this.applyLighting();
  }

  /**
   * Show the effect as it looks with this much of it left.
   *
   * The same scalar the world computes from a status's remaining time, handed in
   * directly — so what the scrubber shows at 0.25 is what a bearer looks like a
   * quarter of the way through their wind-down, not an impression of one.
   */
  setTaper(taper: number) {
    this.taper = taper;
    this.applyTint();
    this.applyLighting();
    this.particles.setEmitters(this.emitterSpecs());
  }

  /**
   * Point the light uniforms at whatever the preview is currently claiming.
   *
   * **The glow is an approximation and is labelled as one.** A real cast is the
   * flood fill in `../lib/lightingFlood` over a map, and there is no map here —
   * so what this does instead is raise the ambient by the light's own colour,
   * which is very nearly what a body standing inside its own light sees. It
   * answers "is this bright enough, and is it the right colour"; it cannot
   * answer "how far does it reach".
   */
  private applyLighting() {
    const u = this.lightUniforms;
    if (!this.night) {
      u.uLightingEnabled.value = 0;
      u.uLightMap.value = this.whiteTex;
      return;
    }
    u.uLightingEnabled.value = 1;
    u.uLightMap.value = this.darkTex;

    const glow = this.vfx.light
      ? taperedGlow(this.vfx.light, this.taper)
      : null;
    if (!glow) {
      u.uAmbient.value.setScalar(NIGHT_AMBIENT);
      return;
    }
    const [r, g, b] = hexToRgb01(glow.color);
    u.uAmbient.value.set(
      Math.min(1, NIGHT_AMBIENT + r * glow.intensity),
      Math.min(1, NIGHT_AMBIENT + g * glow.intensity),
      Math.min(1, NIGHT_AMBIENT + b * glow.intensity),
    );
  }

  start() {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastFrameMs = performance.now();
    const loop = () => {
      if (!this.running || this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(MAX_FRAME_MS, now - this.lastFrameMs);
      this.lastFrameMs = now;
      this.clockMs += dt;
      this.particles.update(dt, undefined);
      this.updateSubjectFrame();
      this.render();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose() {
    this.disposed = true;
    this.stop();
    this.clearSubject();
    this.particles.dispose();
    this.palettePass.dispose();
    this.whiteTex.dispose();
    this.darkTex.dispose();
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    this.renderer.dispose();
  }

  /** The plume this frame, or none when the status emits nothing. */
  private emitterSpecs(): ParticleEmitterSpec[] {
    const particles = this.vfx.particles;
    if (!particles) return [];
    // The same rule play applies: a two-high tile standing on top of the
    // subject's stack. Derived from the subject's own height, so a wall's plume
    // starts where a wall ends and a bush's where a bush does.
    const height = this.def?.height ?? HEIGHT_PER_LEVEL;
    return [
      {
        id: PREVIEW_EMITTER_ID,
        config: particles,
        cx: SUBJECT_CELL.x + 0.5,
        cy: SUBJECT_CELL.y + 0.5,
        footElev: 0,
        z: 0,
        box: depthBox(
          SUBJECT_CELL.x,
          SUBJECT_CELL.y,
          height,
          height + HEIGHT_PER_LEVEL,
        ),
        stackBias: depthStackBias(0, 1),
        taper: this.taper,
      },
    ];
  }

  private applyTint() {
    writeTintUniforms(
      this.tintU,
      this.vfx.tint ? taperedTint(this.vfx.tint, this.taper) : null,
    );
  }

  private buildSubject() {
    if (!this.texture || !this.tileset || !this.def) return;
    const frame = this.frames[Math.max(0, this.frameIdx)] ?? this.frames[0];
    if (!frame) return;

    this.clearSubjectMesh();

    const { rect } = frame.sprite;
    const origin = spriteWorldOrigin(
      baseCellWorldOrigin(SUBJECT_CELL.x, SUBJECT_CELL.y, 0, 0),
      frame.sprite.base,
    );
    const w = rect.w * CELL_SIZE;
    const h = rect.h * CELL_SIZE;
    const quad: Omit<Quad, "x" | "y"> = {
      w,
      h,
      u0: (rect.x * CELL_SIZE) / this.tileset.width,
      u1: ((rect.x + rect.w) * CELL_SIZE) / this.tileset.width,
      v0: 1 - ((rect.y + rect.h) * CELL_SIZE) / this.tileset.height,
      v1: 1 - (rect.y * CELL_SIZE) / this.tileset.height,
      box: depthBox(SUBJECT_CELL.x, SUBJECT_CELL.y, 0, this.def.height),
      stackBias: depthStackBias(0, 0),
      lightX0: SUBJECT_CELL.x,
      lightY0: SUBJECT_CELL.y,
      lightX1: SUBJECT_CELL.x + 1,
      lightY1: SUBJECT_CELL.y + 1,
      // Lit, so night mode reaches the body as well as the plume. In daylight
      // the light step is skipped anyway, so this costs the common case nothing.
      unlit: false,
    };

    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      side: THREE.DoubleSide,
      transparent: true,
      alphaTest: SPRITE_ALPHA_TEST,
    });
    material.onBeforeCompile = (shader) => {
      injectWorldShader(shader, this.lightUniforms, this.tintU);
    };
    material.customProgramCacheKey = () => WORLD_SHADER_CACHE_KEY;

    const mesh = new THREE.Mesh(buildSingleQuadGeometry(quad), material);
    mesh.position.set(origin.x + w / 2, origin.y + h / 2, 0);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.scene.add(mesh);
    mesh.updateMatrixWorld(true);

    this.subject = mesh;
    this.subjectMaterial = material;
  }

  /** Point the subject at whatever frame the shared clock says is live. */
  private updateSubjectFrame() {
    if (!this.subject || this.frames.length < 2) return;
    const idx = frameIndexAtTime(this.frames, this.clockMs);
    if (idx === this.frameIdx) return;
    this.frameIdx = idx;
    const frame = this.frames[idx];
    if (!frame || !this.tileset) return;
    const { rect } = frame.sprite;
    const attr = this.subject.geometry.getAttribute("uv") as THREE.BufferAttribute;
    const uv = attr.array as Float32Array;
    const u0 = (rect.x * CELL_SIZE) / this.tileset.width;
    const u1 = ((rect.x + rect.w) * CELL_SIZE) / this.tileset.width;
    const v0 = 1 - ((rect.y + rect.h) * CELL_SIZE) / this.tileset.height;
    const v1 = 1 - (rect.y * CELL_SIZE) / this.tileset.height;
    uv[0] = u0;
    uv[1] = v0;
    uv[2] = u1;
    uv[3] = v0;
    uv[4] = u0;
    uv[5] = v1;
    uv[6] = u1;
    uv[7] = v1;
    attr.needsUpdate = true;
  }

  private render() {
    const w = this.canvas.clientWidth || this.canvas.width;
    const h = this.canvas.clientHeight || this.canvas.height;
    if (w === 0 || h === 0) return;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.renderer.setSize(w, h, false);
    }

    // Fitted to the shorter side so the whole span is visible whatever shape the
    // panel is, and centred on the subject's cell.
    const zoom = Math.min(w, h) / (PREVIEW_CELLS_ACROSS * CELL_SIZE);
    const viewW = w / zoom;
    const viewH = h / zoom;
    const centreX = (SUBJECT_CELL.x + 0.5) * CELL_SIZE;
    const centreY = (SUBJECT_CELL.y + 0.5) * CELL_SIZE;
    this.camera.left = centreX - viewW / 2;
    this.camera.right = centreX + viewW / 2;
    this.camera.top = centreY - viewH / 2;
    this.camera.bottom = centreY + viewH / 2;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);

    // Into the offscreen target and then through the quantise, exactly as play
    // does. This is the step that makes an authored hex honest: what comes out
    // is a palette entry, and an author who picked a colour the ramp cannot hold
    // sees the one it lands on instead.
    const target = this.palettePass.sceneTarget(this.renderer);
    this.renderer.setRenderTarget(target);
    this.renderer.setClearColor(BACKDROP, 1);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.palettePass.blitToCanvas(this.renderer);
  }

  /** A flat chequer of ground cells, drawn once, behind everything. */
  private buildFloor(): THREE.Mesh {
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    // Through THREE.Color rather than `hexToRgb01`, because a vertex colour is
    // multiplied into `diffuseColor` in **linear** space and an sRGB triple put
    // there directly comes out visibly too bright — which quantised the two
    // chequer greys onto the same palette entry and made the ground look flat.
    const light = linearRgb(FLOOR_LIGHT);
    const dark = linearRgb(FLOOR_DARK);

    const from = -FLOOR_MARGIN_CELLS;
    const to = PREVIEW_CELLS_ACROSS + FLOOR_MARGIN_CELLS;
    for (let y = from; y < to; y++) {
      for (let x = from; x < to; x++) {
        const [r, g, b] = (x + y) % 2 === 0 ? light : dark;
        const base = positions.length / 3;
        const x0 = x * CELL_SIZE;
        const y0 = y * CELL_SIZE;
        const x1 = x0 + CELL_SIZE;
        const y1 = y0 + CELL_SIZE;
        positions.push(x0, y1, 0, x1, y1, 0, x0, y0, 0, x1, y0, 0);
        for (let v = 0; v < 4; v++) colors.push(r, g, b);
        indices.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(positions), 3),
    );
    geo.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(colors), 3),
    );
    geo.setIndex(indices);

    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        // A backdrop rather than a floor: it takes no part in sorting, so a
        // particle that drifts off the subject is never hidden by the ground it
        // is drifting over.
        depthTest: false,
        depthWrite: false,
      }),
    );
    mesh.renderOrder = FLOOR_RENDER_ORDER;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);
    return mesh;
  }

  private clearSubject() {
    this.clearSubjectMesh();
    this.texture?.dispose();
    this.texture = null;
    this.frames = [];
    this.tileset = null;
    this.frameIdx = -1;
  }

  private clearSubjectMesh() {
    if (!this.subject) return;
    this.scene.remove(this.subject);
    this.subject.geometry.dispose();
    this.subjectMaterial?.dispose();
    this.subject = null;
    this.subjectMaterial = null;
  }
}

/** A hex as the linear triple a vertex colour has to be. */
function linearRgb(hex: string): [number, number, number] {
  const c = new THREE.Color().setStyle(hex, THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
}

/**
 * How much of a colour survives in an unlit room.
 *
 * Dark enough that a lit thing plainly loses to an unlit one, light enough that
 * an author can still see the shape of what they are tuning. Not read off the
 * clock: this is a demonstration of a contrast, not a time of day.
 */
const NIGHT_AMBIENT = 0.16;

/** The same cutout every world sprite is drawn with. */
const SPRITE_ALPHA_TEST = 0.5;

/** Darkest palette entry — a backdrop that cannot be mistaken for a colour. */
const BACKDROP = new THREE.Color(STAPES_PALETTE[0] ?? "#2e222f");
