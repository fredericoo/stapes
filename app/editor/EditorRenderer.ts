import * as THREE from "three";
import {
  baseCellWorldOrigin,
  drawOrder,
  screenToCoord,
  spriteWorldOrigin,
} from "../lib/geometry";
import {
  AMBIENT_PRESETS,
  computeLighting,
  type LevelLightMap,
  type LightGrid,
} from "../lib/lighting";
import { getStack, listCoords } from "../lib/mapData";
import type {
  Frame,
  MapFile,
  PlacedTile,
  TileDef,
  TilesetDef,
} from "../lib/types";
import {
  CELL_SIZE,
  MAX_LEVEL,
  MIN_LEVEL,
  getFrames,
  levelKey,
} from "../lib/types";
import { canReplaceStack } from "../lib/validation";
import { useEditorStore, type ToolId } from "./store";
import type { EditorPerfMeasure, EditorPerfSnapshot } from "./perf";

type AnimatedInstance = {
  mesh: THREE.Mesh;
  tileId: string;
  direction?: string;
  tilesetId: string;
  frames: Frame[];
  tileset: TilesetDef;
  animKey: string;
};

/** A textured rectangle in world pixels, ready to be turned into a mesh. */
type SpriteQuad = {
  x: number;
  y: number;
  w: number;
  h: number;
  texture: THREE.Texture;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
};

type Quad = {
  x: number;
  y: number;
  w: number;
  h: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** World Z — higher draws in front via the depth buffer. */
  depth: number;
  /** Sprite extent in cell space for light-map sampling (inclusive-exclusive). */
  lightX0: number;
  lightY0: number;
  lightX1: number;
  lightY1: number;
};

const BACKGROUND_COLOR = 0xb8b09e;

const GHOST_OPACITY = 0.55;
/** Big shapes fall back to outlines only — one mesh per sprite gets costly. */
const MAX_GHOST_CELLS = 256;

/** Spacing between consecutive painter-sorted quads on a level. */
const DEPTH_STEP = 0.0001;
/** Separates levels in Z so dimmed/opaque passes never z-fight across floors. */
const DEPTH_LEVEL_STRIDE = 1;

/** Debounce lighting recompute while painting. */
const LIGHTING_DEBOUNCE_MS = 50;

type LevelLightUniforms = {
  uLightMap: { value: THREE.Texture };
  uLightOrigin: { value: THREE.Vector2 };
  uLightSize: { value: THREE.Vector2 };
  uLightingEnabled: { value: number };
};

/** One BufferGeometry for every quad sharing a tileset inside a level. */
function buildMergedQuadGeometry(quads: Quad[]): THREE.BufferGeometry {
  const n = quads.length;
  const positions = new Float32Array(n * 4 * 3);
  const uvs = new Float32Array(n * 4 * 2);
  const lightUvs = new Float32Array(n * 4 * 2);
  const indices = n * 4 > 65535 ? new Uint32Array(n * 6) : new Uint16Array(n * 6);

  for (let i = 0; i < n; i++) {
    const q = quads[i]!;
    const x0 = q.x;
    const y0 = q.y;
    const x1 = q.x + q.w;
    const y1 = q.y + q.h;
    const z = q.depth;
    const pb = i * 12;
    // Match PlaneGeometry + Y-down UV mapping (see addQuadMesh).
    // vert0 (local +Y / screen-bottom): (x0, y1) uv (u0, v0)
    // vert1: (x1, y1) uv (u1, v0)
    // vert2 (local -Y / screen-top): (x0, y0) uv (u0, v1)
    // vert3: (x1, y0) uv (u1, v1)
    positions[pb] = x0;
    positions[pb + 1] = y1;
    positions[pb + 2] = z;
    positions[pb + 3] = x1;
    positions[pb + 4] = y1;
    positions[pb + 5] = z;
    positions[pb + 6] = x0;
    positions[pb + 7] = y0;
    positions[pb + 8] = z;
    positions[pb + 9] = x1;
    positions[pb + 10] = y0;
    positions[pb + 11] = z;

    const ub = i * 8;
    uvs[ub] = q.u0;
    uvs[ub + 1] = q.v0;
    uvs[ub + 2] = q.u1;
    uvs[ub + 3] = q.v0;
    uvs[ub + 4] = q.u0;
    uvs[ub + 5] = q.v1;
    uvs[ub + 6] = q.u1;
    uvs[ub + 7] = q.v1;

    // Same vert order as UVs — cell-space corners for the light map.
    lightUvs[ub] = q.lightX0;
    lightUvs[ub + 1] = q.lightY1;
    lightUvs[ub + 2] = q.lightX1;
    lightUvs[ub + 3] = q.lightY1;
    lightUvs[ub + 4] = q.lightX0;
    lightUvs[ub + 5] = q.lightY0;
    lightUvs[ub + 6] = q.lightX1;
    lightUvs[ub + 7] = q.lightY0;

    const base = i * 4;
    const ib = i * 6;
    // PlaneGeometry winding: 0,2,1 / 2,3,1
    indices[ib] = base;
    indices[ib + 1] = base + 2;
    indices[ib + 2] = base + 1;
    indices[ib + 3] = base + 2;
    indices[ib + 4] = base + 3;
    indices[ib + 5] = base + 1;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute("aLightUv", new THREE.BufferAttribute(lightUvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
}

function opacityForLevel(
  z: number,
  current: number,
  showOther: boolean,
  preview: boolean,
): number | null {
  if (preview) return 1;
  if (z === current) return 1;
  if (!showOther) return null;
  if (z < current) {
    const dist = current - z;
    return Math.max(0.15, 0.7 - dist * 0.15);
  }
  // above
  return 0.4;
}

/**
 * Flattens one level's render target onto the canvas at a single opacity.
 * The RT holds straight-alpha coverage (opaque cutouts write A=1; clear is A=0).
 */
function createCompositeMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      tLevel: { value: null as THREE.Texture | null },
      uOpacity: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tLevel;
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        vec4 texel = texture2D(tLevel, vUv);
        // Straight alpha → premultiplied for CustomBlending below.
        gl_FragColor = vec4(texel.rgb * texel.a, texel.a) * uOpacity;
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
}

function disposeObject3D(obj: THREE.Object3D) {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    // Shared materials are owned by the renderer — never dispose them here.
  });
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil(p * sortedAsc.length) - 1),
  );
  return sortedAsc[idx]!;
}

export class EditorRenderer {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private grid: THREE.Group;
  private overlays: THREE.Group;
  private world: THREE.Group;
  private textures = new Map<string, THREE.Texture>();
  /** Shared cutout materials keyed by `${texture.uuid}:${z}`. */
  private materials = new Map<string, THREE.MeshBasicMaterial>();
  private tilesets: TilesetDef[] = [];
  private tilesetById = new Map<string, TilesetDef>();
  private tilesById: Record<string, TileDef> = {};
  private levelGroups = new Map<number, THREE.Group>();
  private levelTarget: THREE.WebGLRenderTarget | null = null;
  private compositeScene: THREE.Scene;
  private compositeCamera: THREE.Camera;
  private compositeMaterial: THREE.ShaderMaterial;
  private drawBufferSize = new THREE.Vector2();
  /** Animated instances keyed by level. */
  private animatedByLevel = new Map<number, AnimatedInstance[]>();
  /** Flat list rebuilt whenever level animation lists change. */
  private animated: AnimatedInstance[] = [];
  /** Precomputed grouping of animated instances by anim key. */
  private animatedByKey = new Map<string, AnimatedInstance[]>();
  private animClock = 0;
  private lastAnimTime = 0;
  private frameIndices = new Map<string, number>();
  private raf = 0;
  private unsub: (() => void) | null = null;
  private spaceDown = false;
  private panning = false;
  private panLast = { x: 0, y: 0 };
  private painting = false;
  private shapeAnchor: { x: number; y: number } | null = null;
  private lastPaintKey = "";
  private disposed = false;
  private magentaTex: THREE.DataTexture;
  private whiteTex: THREE.DataTexture;
  private lightTextures = new Map<number, THREE.DataTexture>();
  private lightUniformsByZ = new Map<number, LevelLightUniforms>();
  private lightGrid: LightGrid | null = null;
  private lightingKey = "";
  private lightingTimer: ReturnType<typeof setTimeout> | null = null;
  private rebuildKey = "";
  private gridLevel = Number.NaN;
  /** Previous map for reference-diff dirty-chunk detection. */
  private prevMap: MapFile | null = null;
  private needsRender = true;
  private canvasW = 0;
  private canvasH = 0;
  private resizeObserver: ResizeObserver | null = null;
  private overlaySig = "";
  private statsEl: HTMLDivElement | null = null;
  private statsAccum = 0;
  private statsFrames = 0;
  private statsLastReport = 0;
  private lastFrameMs = 0;
  private assetsReady = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
    });
    this.renderer.setClearColor(BACKGROUND_COLOR, 1);
    this.renderer.setPixelRatio(1);
    // Levels are drawn one pass at a time, so clearing is done by hand.
    this.renderer.autoClear = false;
    // Accumulate draw calls across the multi-pass frame; we reset in renderFrame.
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();
    // World meshes never move after build — update matrices only on rebuild.
    this.scene.matrixWorldAutoUpdate = false;
    // Depths are ~[0, 20] from per-level sorted indices. Tight frustum keeps
    // the 24-bit depth buffer precise enough for DEPTH_STEP.
    this.camera = new THREE.OrthographicCamera(0, 1, 0, 1, -10, 50);
    this.camera.position.z = 25;

    this.world = new THREE.Group();
    this.grid = new THREE.Group();
    this.overlays = new THREE.Group();
    this.scene.add(this.world);
    this.scene.add(this.grid);
    this.scene.add(this.overlays);

    this.compositeMaterial = createCompositeMaterial();
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this.compositeMaterial,
    );
    quad.frustumCulled = false;
    this.compositeScene = new THREE.Scene();
    this.compositeScene.add(quad);
    this.compositeCamera = new THREE.Camera();

    const data = new Uint8Array([255, 0, 255, 255]);
    this.magentaTex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    this.magentaTex.magFilter = THREE.NearestFilter;
    this.magentaTex.minFilter = THREE.NearestFilter;
    this.magentaTex.colorSpace = THREE.SRGBColorSpace;
    this.magentaTex.needsUpdate = true;

    const white = new Uint8Array([255, 255, 255, 255]);
    this.whiteTex = new THREE.DataTexture(white, 1, 1, THREE.RGBAFormat);
    this.whiteTex.magFilter = THREE.LinearFilter;
    this.whiteTex.minFilter = THREE.LinearFilter;
    this.whiteTex.generateMipmaps = false;
    this.whiteTex.needsUpdate = true;

    this.bindEvents();
    this.bindResize();
    if (import.meta.env.DEV) this.createStatsEl();

    this.unsub = useEditorStore.subscribe(() => {
      this.syncFromStore();
    });
    this.syncFromStore(true);
    this.lastAnimTime = performance.now();
    this.loop();
  }

  setAssets(tilesets: TilesetDef[], tilesById?: Record<string, TileDef>) {
    this.tilesets = tilesets;
    this.tilesetById = new Map(tilesets.map((t) => [t.id, t]));
    if (tilesById) this.tilesById = tilesById;
    this.assetsReady = false;
    void this.preloadTextures()
      .then(() => {
        if (this.disposed) return;
        // Always rebuild from the live store so we don't race hydrate.
        this.tilesById = useEditorStore.getState().tilesById;
        this.rebuildKey = "";
        this.prevMap = null;
        this.rebuildAll();
        this.assetsReady = true;
        this.requestRender();
      })
      .catch((err) => {
        console.error("Failed to load tileset textures", err);
      });
  }

  /** True once tileset textures are in and the world has been built at least once. */
  isReady(): boolean {
    return !this.disposed && this.assetsReady && this.prevMap !== null;
  }

  getPerfSnapshot(): EditorPerfSnapshot {
    const s = useEditorStore.getState();
    const info = this.renderer.info.render;
    return {
      lastFrameMs: this.lastFrameMs,
      calls: info.calls,
      triangles: info.triangles,
      levels: this.levelGroups.size,
      worldMeshes: this.countWorldMeshes(),
      animated: this.animated.length,
      placedQuads: this.countPlacedQuads(),
      showOtherLevels: s.showOtherLevels,
      currentLevel: s.currentLevel,
      previewMode: s.previewMode,
    };
  }

  /**
   * Force `samples` synchronous frames and return timing percentiles.
   * Used by Playwright perf budgets — not on the hot path.
   */
  measureRenders(samples = 60): EditorPerfMeasure {
    const times: number[] = [];
    const warmup = Math.min(10, samples);
    for (let i = 0; i < warmup + samples; i++) {
      const s = useEditorStore.getState();
      const t0 = performance.now();
      this.applyCamera(s.camera.x, s.camera.y, s.zoom);
      this.renderFrame(s);
      const dt = performance.now() - t0;
      this.lastFrameMs = dt;
      if (i >= warmup) times.push(dt);
    }
    times.sort((a, b) => a - b);
    const info = this.renderer.info.render;
    return {
      samples: times.length,
      p50Ms: percentile(times, 0.5),
      p95Ms: percentile(times, 0.95),
      maxMs: times[times.length - 1] ?? 0,
      calls: info.calls,
      triangles: info.triangles,
      levels: this.levelGroups.size,
      worldMeshes: this.countWorldMeshes(),
      animated: this.animated.length,
      placedQuads: this.countPlacedQuads(),
    };
  }

  private countWorldMeshes(): number {
    let n = 0;
    this.world.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) n++;
    });
    return n;
  }

  private countPlacedQuads(): number {
    const map = this.prevMap ?? useEditorStore.getState().map;
    let n = 0;
    for (const level of Object.values(map.levels)) {
      for (const stack of Object.values(level)) n += stack.length;
    }
    return n;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.unsub?.();
    this.resizeObserver?.disconnect();
    this.statsEl?.remove();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointerleave", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.levelTarget?.dispose();
    this.compositeMaterial.dispose();
    this.renderer.dispose();
    for (const tex of this.textures.values()) tex.dispose();
    for (const mat of this.materials.values()) mat.dispose();
    for (const tex of this.lightTextures.values()) tex.dispose();
    if (this.lightingTimer) clearTimeout(this.lightingTimer);
    this.magentaTex.dispose();
    this.whiteTex.dispose();
  }

  private requestRender() {
    this.needsRender = true;
  }

  private bindResize() {
    this.resizeObserver = new ResizeObserver(() => {
      this.updateCanvasSize();
      this.requestRender();
    });
    this.resizeObserver.observe(this.canvas);
    this.updateCanvasSize();
  }

  private updateCanvasSize() {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    if (w === this.canvasW && h === this.canvasH) return;
    this.canvasW = w;
    this.canvasH = h;
    this.renderer.setSize(w, h, false);
  }

  private createStatsEl() {
    const el = document.createElement("div");
    el.style.cssText =
      "position:absolute;top:4px;right:4px;z-index:50;font:11px/1.3 ui-monospace,monospace;" +
      "background:rgba(0,0,0,0.65);color:#9f9;padding:4px 6px;pointer-events:none;" +
      "border-radius:3px;white-space:pre;";
    el.textContent = "…";
    const parent = this.canvas.parentElement;
    if (parent) {
      if (getComputedStyle(parent).position === "static") {
        parent.style.position = "relative";
      }
      parent.appendChild(el);
      this.statsEl = el;
    }
  }

  private async preloadTextures() {
    await Promise.all(
      this.tilesets.map(async (ts) => {
        if (this.textures.has(ts.id)) return;
        const loader = new THREE.TextureLoader();
        const tex = await loader.loadAsync(`/tilesets/${ts.file}`);
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.flipY = true;
        tex.needsUpdate = true;
        this.textures.set(ts.id, tex);
      }),
    );
  }

  private materialKey(texture: THREE.Texture, z: number) {
    return `${texture.uuid}:${z}`;
  }

  private ensureLightUniforms(z: number): LevelLightUniforms {
    let u = this.lightUniformsByZ.get(z);
    if (!u) {
      u = {
        uLightMap: { value: this.whiteTex },
        uLightOrigin: { value: new THREE.Vector2(0, 0) },
        uLightSize: { value: new THREE.Vector2(1, 1) },
        uLightingEnabled: { value: 1 },
      };
      this.lightUniformsByZ.set(z, u);
    }
    return u;
  }

  private materialFor(texture: THREE.Texture, z: number): THREE.MeshBasicMaterial {
    const key = this.materialKey(texture, z);
    let mat = this.materials.get(key);
    if (!mat) {
      const lightUniforms = this.ensureLightUniforms(z);
      mat = new THREE.MeshBasicMaterial({
        map: texture,
        // Ortho camera uses top < bottom for Y-down, which reverses winding.
        side: THREE.DoubleSide,
      });
      mat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, lightUniforms);
        shader.vertexShader = shader.vertexShader
          .replace(
            "#include <common>",
            /* glsl */ `#include <common>
attribute vec2 aLightUv;
varying vec2 vLightUv;`,
          )
          .replace(
            "#include <uv_vertex>",
            /* glsl */ `#include <uv_vertex>
vLightUv = aLightUv;`,
          );
        shader.fragmentShader = shader.fragmentShader
          .replace(
            "#include <common>",
            /* glsl */ `#include <common>
uniform sampler2D uLightMap;
uniform vec2 uLightOrigin;
uniform vec2 uLightSize;
uniform float uLightingEnabled;
varying vec2 vLightUv;`,
          )
          .replace(
            "#include <map_fragment>",
            /* glsl */ `#include <map_fragment>
if (uLightingEnabled > 0.5) {
  vec2 lightUv = (vLightUv - uLightOrigin) / uLightSize;
  vec3 light = texture2D(uLightMap, lightUv).rgb;
  diffuseColor.rgb *= light;
}`,
          );
      };
      mat.customProgramCacheKey = () => "stapes-lit-v1";
      mat.userData.lightUniforms = lightUniforms;
      this.materials.set(key, mat);
    }
    // Cutout with depth: alphaTest discards holes; depth buffer sorts overlaps
    // so we can merge quads. transparent:true keeps texture alpha in the level
    // RT so the composite pass can fade a whole level as one flat image.
    mat.alphaTest = 0.5;
    mat.transparent = true;
    mat.opacity = 1;
    mat.depthTest = true;
    mat.depthWrite = true;
    mat.needsUpdate = true;
    return mat;
  }

  private scheduleLightingUpdate() {
    if (this.lightingTimer) clearTimeout(this.lightingTimer);
    this.lightingTimer = setTimeout(() => {
      this.lightingTimer = null;
      this.updateLighting(true);
    }, LIGHTING_DEBOUNCE_MS);
  }

  /**
   * Recompute the light grid and upload DataTextures.
   */
  private updateLighting(force = false) {
    if (this.disposed) return;
    const s = useEditorStore.getState();
    const key = this.lightingFingerprint(s);
    if (!force && key === this.lightingKey) return;
    this.lightingKey = key;

    const ambient = AMBIENT_PRESETS[s.lighting.timeOfDay];
    const grid = computeLighting(s.map, s.tilesById, [...ambient]);
    this.lightGrid = grid;
    this.uploadLightGrid(grid);
    this.requestRender();
  }

  private uploadLightGrid(grid: LightGrid) {
    const seen = new Set<number>();
    for (const [z, level] of grid.levels) {
      seen.add(z);
      this.uploadLevelLight(z, level);
    }
    // Levels with no contribution still need ambient-only maps if we have uniforms.
    for (const z of this.lightUniformsByZ.keys()) {
      if (seen.has(z)) continue;
      const u = this.ensureLightUniforms(z);
      u.uLightingEnabled.value = 1;
      u.uLightMap.value = this.whiteTex;
      u.uLightOrigin.value.set(0, 0);
      u.uLightSize.value.set(1, 1);
      // Apply ambient via a 1×1 tinted texture when the grid skipped this z.
      const ambient = AMBIENT_PRESETS[useEditorStore.getState().lighting.timeOfDay];
      const data = new Uint8Array([
        Math.round(ambient[0] * 255),
        Math.round(ambient[1] * 255),
        Math.round(ambient[2] * 255),
        255,
      ]);
      let tex = this.lightTextures.get(z);
      if (!tex || tex.image.width !== 1) {
        tex?.dispose();
        tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;
        this.lightTextures.set(z, tex);
      } else {
        (tex.image.data as Uint8Array).set(data);
        tex.needsUpdate = true;
      }
      u.uLightMap.value = tex;
    }
  }

  private uploadLevelLight(z: number, level: LevelLightMap) {
    const u = this.ensureLightUniforms(z);
    u.uLightingEnabled.value = 1;
    u.uLightOrigin.value.set(level.x0, level.y0);
    u.uLightSize.value.set(level.w, level.h);

    const rgba = new Uint8Array(level.w * level.h * 4);
    for (let i = 0, p = 0; i < level.rgb.length; i += 3, p += 4) {
      rgba[p] = level.rgb[i]!;
      rgba[p + 1] = level.rgb[i + 1]!;
      rgba[p + 2] = level.rgb[i + 2]!;
      rgba[p + 3] = 255;
    }

    let tex = this.lightTextures.get(z);
    if (!tex || tex.image.width !== level.w || tex.image.height !== level.h) {
      tex?.dispose();
      tex = new THREE.DataTexture(rgba, level.w, level.h, THREE.RGBAFormat);
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.flipY = false;
      tex.needsUpdate = true;
      this.lightTextures.set(z, tex);
    } else {
      (tex.image as { data: Uint8Array }).data.set(rgba);
      tex.needsUpdate = true;
    }
    u.uLightMap.value = tex;
  }

  private syncFromStore(forceRebuild = false) {
    if (this.disposed) return;
    const s = useEditorStore.getState();
    this.tilesById = s.tilesById;
    this.applyCamera(s.camera.x, s.camera.y, s.zoom);
    if (this.gridLevel !== s.currentLevel) {
      this.drawGrid(s.currentLevel);
      this.gridLevel = s.currentLevel;
    }
    this.drawOverlays(s);
    // Level visibility and opacity are decided per frame, so they don't force a rebuild.
    const key = `${s.mapVersion}|${Object.keys(s.tilesById).length}`;
    if (forceRebuild || key !== this.rebuildKey) {
      const prevKey = this.rebuildKey;
      this.rebuildKey = key;
      // Full rebuild when tilesById count changed (defs loaded/replaced) or forced.
      const tilesChanged =
        forceRebuild ||
        !prevKey ||
        prevKey.split("|")[1] !== key.split("|")[1];
      if (tilesChanged || this.prevMap === null) {
        this.rebuildAll();
      } else {
        this.rebuildDirtyChunks(s.map);
      }
    }
    this.maybeScheduleLighting();
    this.requestRender();
  }

  private lightingFingerprint(s: ReturnType<typeof useEditorStore.getState>) {
    let lightDefsSig = 0;
    for (const t of s.tiles) {
      if (t.light) {
        const col = t.light.color;
        let colHash = 0;
        for (let i = 0; i < col.length; i++) colHash = (colHash * 31 + col.charCodeAt(i)) | 0;
        lightDefsSig =
          (lightDefsSig * 31 +
            t.id.length +
            t.light.radius * 10 +
            Math.round(t.light.intensity * 100) +
            colHash) |
          0;
      }
      if (t.lightPassing) lightDefsSig = (lightDefsSig * 17 + 3) | 0;
      if (t.blocksLight != null) {
        lightDefsSig = (lightDefsSig * 17 + (t.blocksLight ? 3 : 5)) | 0;
      }
    }
    const { timeOfDay } = s.lighting;
    return `${timeOfDay}|${s.mapVersion}|${lightDefsSig}|${Object.keys(s.tilesById).length}`;
  }

  private maybeScheduleLighting() {
    const s = useEditorStore.getState();
    if (this.lightingFingerprint(s) === this.lightingKey) return;
    this.scheduleLightingUpdate();
  }

  private applyCamera(camX: number, camY: number, zoom: number) {
    this.updateCanvasSize();
    const viewW = this.canvasW / zoom;
    const viewH = this.canvasH / zoom;
    this.camera.left = camX;
    this.camera.right = camX + viewW;
    // Y grows down in our world. top < bottom flips Y to match screen space.
    // That also reverses face winding — tile materials use DoubleSide to compensate.
    this.camera.top = camY;
    this.camera.bottom = camY + viewH;
    this.camera.scale.set(1, 1, 1);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
  }

  private drawGrid(level: number) {
    while (this.grid.children.length) {
      const c = this.grid.children.pop()!;
      (c as THREE.Line).geometry?.dispose();
      ((c as THREE.Line).material as THREE.Material)?.dispose();
    }
    const offset = -CELL_SIZE * level;
    const size = 40;
    const points: number[] = [];
    for (let i = -size; i <= size; i++) {
      points.push(
        i * CELL_SIZE + offset,
        -size * CELL_SIZE + offset,
        0,
        i * CELL_SIZE + offset,
        size * CELL_SIZE + offset,
        0,
      );
      points.push(
        -size * CELL_SIZE + offset,
        i * CELL_SIZE + offset,
        0,
        size * CELL_SIZE + offset,
        i * CELL_SIZE + offset,
        0,
      );
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(points, 3),
    );
    const mat = new THREE.LineBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.12,
      depthTest: false,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.renderOrder = -1000;
    lines.matrixAutoUpdate = false;
    lines.updateMatrix();
    this.grid.add(lines);

    // Origin axes
    const axisGeo = new THREE.BufferGeometry();
    axisGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [
          offset,
          -size * CELL_SIZE + offset,
          0,
          offset,
          size * CELL_SIZE + offset,
          0,
          -size * CELL_SIZE + offset,
          offset,
          0,
          size * CELL_SIZE + offset,
          offset,
          0,
        ],
        3,
      ),
    );
    const axis = new THREE.LineSegments(
      axisGeo,
      new THREE.LineBasicMaterial({
        color: 0x2d6a4f,
        transparent: true,
        opacity: 0.5,
        depthTest: false,
        depthWrite: false,
      }),
    );
    axis.renderOrder = -999;
    axis.matrixAutoUpdate = false;
    axis.updateMatrix();
    this.grid.add(axis);
    this.grid.updateMatrixWorld(true);
  }

  private overlaySignature(
    s: ReturnType<typeof useEditorStore.getState>,
  ): string {
    const h = s.hover;
    const sel = s.selected;
    const sp = s.shapePreview;
    // Include frame indices so animated overlay sprites stay in sync.
    let frames = "";
    for (const [k, v] of this.frameIndices) frames += `${k}=${v};`;
    return [
      s.mapVersion,
      s.currentLevel,
      s.tool,
      h ? `${h.x},${h.y}` : "",
      sel ? `${sel.x},${sel.y}` : "",
      sp ? `${sp.kind}:${sp.x0},${sp.y0},${sp.x1},${sp.y1}` : "",
      frames,
    ].join("|");
  }

  private drawOverlays(s: ReturnType<typeof useEditorStore.getState>) {
    const sig = this.overlaySignature(s);
    if (sig === this.overlaySig) return;
    this.overlaySig = sig;

    while (this.overlays.children.length) {
      const c = this.overlays.children.pop()!;
      const mesh = c as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose?.();
    }

    /** Axis-aligned outline in world pixels — LineLoop, not EdgesGeometry (unreliable with Y-down ortho). */
    const addRectOutline = (
      originX: number,
      originY: number,
      w: number,
      h: number,
      color: number,
      heavy = false,
    ) => {
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
        line.renderOrder = 1_000_000_020;
        line.matrixAutoUpdate = false;
        line.updateMatrix();
        this.overlays.add(line);
      };
      makeLine(originX, originY, w, h, 1);
      if (heavy) {
        makeLine(originX + 0.5, originY + 0.5, w - 1, h - 1, 0.85);
      }
    };

    const addSprite = (
      q: SpriteQuad,
      opts: {
        color: number;
        opacity: number;
        blending: THREE.Blending;
        renderOrder: number;
      },
    ) => {
      const geo = new THREE.PlaneGeometry(q.w, q.h);
      const uvs = geo.attributes.uv!;
      uvs.setXY(0, q.u0, q.v0);
      uvs.setXY(1, q.u1, q.v0);
      uvs.setXY(2, q.u0, q.v1);
      uvs.setXY(3, q.u1, q.v1);
      uvs.needsUpdate = true;

      const mat = new THREE.MeshBasicMaterial({
        map: q.texture,
        color: opts.color,
        transparent: true,
        opacity: opts.opacity,
        blending: opts.blending,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(q.x + q.w / 2, q.y + q.h / 2, 0);
      mesh.renderOrder = opts.renderOrder;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.overlays.add(mesh);
    };

    const z = s.currentLevel;
    const brush = s.selected
      ? getStack(s.map, s.selected.x, s.selected.y, z)
      : [];

    if (
      s.hover &&
      !(s.selected && s.hover.x === s.selected.x && s.hover.y === s.selected.y)
    ) {
      const origin = baseCellWorldOrigin(s.hover.x, s.hover.y, z, 0);
      addRectOutline(origin.x, origin.y, CELL_SIZE, CELL_SIZE, 0xffffff);
    }

    if (s.selected) {
      const { x, y } = s.selected;

      if (brush.length === 0) {
        const origin = baseCellWorldOrigin(x, y, z, 0);
        addRectOutline(origin.x, origin.y, CELL_SIZE, CELL_SIZE, 0xffcc00, true);
      }

      let elev = 0;
      brush.forEach((placed, stackIndex) => {
        const def = s.tilesById[placed.tileId];
        const quad = def ? this.spriteQuad(placed, def, x, y, z, elev) : null;

        if (!def || !quad) {
          const origin = baseCellWorldOrigin(x, y, z, elev);
          addRectOutline(
            origin.x,
            origin.y,
            CELL_SIZE,
            CELL_SIZE,
            0xff66ff,
            true,
          );
          return;
        }

        const isTop = stackIndex === brush.length - 1;
        if (isTop) {
          // Additive glow of the sprite itself — texture alpha is the mask.
          addSprite(quad, {
            color: 0xfff3b0,
            opacity: 0.75,
            blending: THREE.AdditiveBlending,
            renderOrder: 1_000_000_010,
          });
        }
        // Full sprite AABB outline (tree = 2×2, grass = 1×1, …)
        addRectOutline(
          quad.x,
          quad.y,
          quad.w,
          quad.h,
          isTop ? 0xffee55 : 0xe6b800,
          isTop,
        );

        elev += def.height;
      });
    }

    const targets = this.brushTargets(s);
    const showGhosts = brush.length > 0 && targets.length <= MAX_GHOST_CELLS;
    for (const c of targets) {
      if (s.shapePreview) {
        const origin = baseCellWorldOrigin(c.x, c.y, z, 0);
        addRectOutline(origin.x, origin.y, CELL_SIZE, CELL_SIZE, 0x2d6a4f);
      }
      // The source cell already shows the real thing.
      if (s.selected && c.x === s.selected.x && c.y === s.selected.y) continue;
      if (!showGhosts) continue;

      if (!canReplaceStack(s.map, c.x, c.y, z, brush, s.tilesById).ok) {
        const origin = baseCellWorldOrigin(c.x, c.y, z, 0);
        addRectOutline(origin.x, origin.y, CELL_SIZE, CELL_SIZE, 0xff4d4d, true);
        continue;
      }

      let elev = 0;
      brush.forEach((placed, stackIndex) => {
        const def = s.tilesById[placed.tileId];
        if (!def) return;
        const quad = this.spriteQuad(placed, def, c.x, c.y, z, elev);
        if (quad) {
          addSprite(quad, {
            color: 0xffffff,
            opacity: GHOST_OPACITY,
            blending: THREE.NormalBlending,
            renderOrder: drawOrder(c.x, c.y, stackIndex),
          });
        }
        elev += def.height;
      });
    }

    this.overlays.updateMatrixWorld(true);
  }

  /** Cells the current tool would paint if the pointer acted right now. */
  private brushTargets(
    s: ReturnType<typeof useEditorStore.getState>,
  ): Array<{ x: number; y: number }> {
    if (s.shapePreview) {
      const { kind, x0, y0, x1, y1 } = s.shapePreview;
      return kind === "rect"
        ? this.rectList(x0, y0, x1, y1)
        : this.circleList(x0, y0, x1, y1);
    }
    const paints =
      s.tool === "pencil" || s.tool === "rect" || s.tool === "circle";
    if (paints && s.hover) return [s.hover];
    return [];
  }

  /**
   * World-space quad for a placed tile, resolved against the frame that is on
   * screen right now so overlays stay in step with animated tiles.
   */
  private spriteQuad(
    placed: PlacedTile,
    def: TileDef,
    x: number,
    y: number,
    z: number,
    elevation: number,
  ): SpriteQuad | null {
    const frames = getFrames(def, placed.direction);
    let frame = frames?.[0];
    if (frames && frames.length > 1) {
      const key = `${def.id}:${placed.direction ?? "default"}`;
      frame = frames[this.frameIndices.get(key) ?? 0] ?? frames[0];
    }
    if (!frame) return null;

    const tileset = this.tilesetById.get(frame.sprite.tilesetId);
    const { rect } = frame.sprite;
    const tw = tileset?.width ?? CELL_SIZE;
    const th = tileset?.height ?? CELL_SIZE;
    const origin = spriteWorldOrigin(
      baseCellWorldOrigin(x, y, z, elevation),
      frame.sprite.base,
    );

    return {
      x: origin.x,
      y: origin.y,
      w: rect.w * CELL_SIZE,
      h: rect.h * CELL_SIZE,
      texture: (tileset && this.textures.get(tileset.id)) || this.magentaTex,
      u0: (rect.x * CELL_SIZE) / tw,
      u1: ((rect.x + rect.w) * CELL_SIZE) / tw,
      v0: 1 - ((rect.y + rect.h) * CELL_SIZE) / th,
      v1: 1 - (rect.y * CELL_SIZE) / th,
    };
  }

  private rectList(x0: number, y0: number, x1: number, y1: number) {
    const out: Array<{ x: number; y: number }> = [];
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
        out.push({ x, y });
      }
    }
    return out;
  }

  private circleList(x0: number, y0: number, x1: number, y1: number) {
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const rx = (maxX - minX) / 2 + 0.5;
    const ry = (maxY - minY) / 2 + 0.5;
    const out: Array<{ x: number; y: number }> = [];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) out.push({ x, y });
      }
    }
    return out;
  }

  private rebuildAnimatedIndex() {
    this.animated = [];
    for (const list of this.animatedByLevel.values()) {
      for (const inst of list) this.animated.push(inst);
    }
    this.animatedByKey.clear();
    for (const inst of this.animated) {
      let list = this.animatedByKey.get(inst.animKey);
      if (!list) {
        list = [];
        this.animatedByKey.set(inst.animKey, list);
      }
      list.push(inst);
    }
  }

  private removeLevel(z: number) {
    const group = this.levelGroups.get(z);
    if (group) {
      group.parent?.remove(group);
      disposeObject3D(group);
      this.levelGroups.delete(z);
    }
    this.animatedByLevel.delete(z);
  }

  private rebuildAll() {
    while (this.world.children.length) {
      const g = this.world.children.pop()!;
      disposeObject3D(g);
    }
    this.levelGroups.clear();
    this.animatedByLevel.clear();
    this.animated = [];
    this.animatedByKey.clear();

    const s = useEditorStore.getState();
    for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
      this.buildLevel(s.map, z);
    }
    this.rebuildAnimatedIndex();
    this.prevMap = s.map;
    this.world.updateMatrixWorld(true);
    // Force overlay refresh (map content changed under selection).
    this.overlaySig = "";
  }

  /**
   * Diff `next` against `prevMap` by stack reference identity and rebuild
   * every level that has any changed cell. Depths are assigned from a
   * level-wide painter sort, so a single cell edit must refresh the whole
   * level's merged meshes — still cheap (one buffer per tileset).
   */
  private rebuildDirtyChunks(next: MapFile) {
    const prev = this.prevMap;
    if (!prev) {
      this.rebuildAll();
      return;
    }

    const dirtyLevels = new Set<number>();
    const allZ = new Set<number>();
    for (const zk of Object.keys(prev.levels)) allZ.add(Number(zk));
    for (const zk of Object.keys(next.levels)) allZ.add(Number(zk));

    for (const z of allZ) {
      const prevLevel = prev.levels[levelKey(z)];
      const nextLevel = next.levels[levelKey(z)];
      if (prevLevel === nextLevel) continue;

      const keys = new Set<string>();
      if (prevLevel) for (const k of Object.keys(prevLevel)) keys.add(k);
      if (nextLevel) for (const k of Object.keys(nextLevel)) keys.add(k);

      for (const ck of keys) {
        if (prevLevel?.[ck] !== nextLevel?.[ck]) {
          dirtyLevels.add(z);
          break;
        }
      }
    }

    if (dirtyLevels.size === 0) {
      this.prevMap = next;
      return;
    }

    for (const z of dirtyLevels) {
      this.removeLevel(z);
      this.buildLevel(next, z);
    }

    this.rebuildAnimatedIndex();
    this.prevMap = next;
    this.world.updateMatrixWorld(true);
    this.overlaySig = "";
  }

  private buildLevel(map: MapFile, z: number) {
    const coords = listCoords(map, z);
    if (coords.length === 0) return;

    type Item = Quad & {
      order: number;
      texture: THREE.Texture;
      anim?: {
        frames: Frame[];
        tileId: string;
        direction?: string;
        tileset: TilesetDef;
        animKey: string;
      };
    };

    const items: Item[] = [];

    for (const cell of coords) {
      let elev = 0;
      cell.stack.forEach((placed, stackIndex) => {
        const def = this.tilesById[placed.tileId];
        const order = drawOrder(cell.x, cell.y, stackIndex);

        if (!def) {
          const origin = baseCellWorldOrigin(cell.x, cell.y, z, elev);
          items.push({
            x: origin.x,
            y: origin.y,
            w: CELL_SIZE,
            h: CELL_SIZE,
            u0: 0,
            v0: 0,
            u1: 1,
            v1: 1,
            depth: 0,
            order,
            texture: this.magentaTex,
            lightX0: cell.x,
            lightY0: cell.y,
            lightX1: cell.x + 1,
            lightY1: cell.y + 1,
          });
          return;
        }

        const frames = getFrames(def, placed.direction);
        const first = frames?.[0];
        if (!first) return;

        const tileset = this.tilesetById.get(first.sprite.tilesetId);
        if (!tileset) return;

        const baseOrigin = baseCellWorldOrigin(cell.x, cell.y, z, elev);
        const origin = spriteWorldOrigin(baseOrigin, first.sprite.base);
        const { rect } = first.sprite;
        const w = rect.w * CELL_SIZE;
        const h = rect.h * CELL_SIZE;
        const u0 = (rect.x * CELL_SIZE) / tileset.width;
        const u1 = ((rect.x + rect.w) * CELL_SIZE) / tileset.width;
        const v1 = 1 - (rect.y * CELL_SIZE) / tileset.height;
        const v0 = 1 - ((rect.y + rect.h) * CELL_SIZE) / tileset.height;
        const texture = this.textures.get(tileset.id) ?? this.magentaTex;
        const isAnimated = (frames?.length ?? 0) > 1;
        const lightX0 = cell.x - first.sprite.base.x;
        const lightY0 = cell.y - first.sprite.base.y;
        const lightX1 = lightX0 + rect.w;
        const lightY1 = lightY0 + rect.h;

        items.push({
          x: origin.x,
          y: origin.y,
          w,
          h,
          u0,
          v0,
          u1,
          v1,
          depth: 0,
          order,
          texture,
          lightX0,
          lightY0,
          lightX1,
          lightY1,
          anim:
            isAnimated && frames
              ? {
                  frames,
                  tileId: def.id,
                  direction: placed.direction,
                  tileset,
                  animKey: `${def.id}:${placed.direction ?? "default"}`,
                }
              : undefined,
        });

        elev += def.height;
      });
    }

    if (items.length === 0) return;

    // Global painter sort, then sequential Z — float32-safe and identical
    // across tileset batches, so roof seams at old chunk boundaries sort correctly.
    items.sort((a, b) => a.order - b.order || a.x - b.x || a.y - b.y);
    const depthBase = (z + 8) * DEPTH_LEVEL_STRIDE;
    for (let i = 0; i < items.length; i++) {
      items[i]!.depth = depthBase + i * DEPTH_STEP;
    }

    const levelGroup = new THREE.Group();
    levelGroup.name = `level:${z}`;
    levelGroup.matrixAutoUpdate = false;
    levelGroup.updateMatrix();
    this.world.add(levelGroup);
    this.levelGroups.set(z, levelGroup);

    const staticByTex = new Map<THREE.Texture, Quad[]>();
    const animated: AnimatedInstance[] = [];

    for (const item of items) {
      if (item.anim) {
        const mesh = this.addQuadMesh(
          levelGroup,
          item.x,
          item.y,
          item.w,
          item.h,
          item.texture,
          item.u0,
          item.v0,
          item.u1,
          item.v1,
          item.depth,
          z,
          item.lightX0,
          item.lightY0,
          item.lightX1,
          item.lightY1,
        );
        animated.push({
          mesh,
          tileId: item.anim.tileId,
          direction: item.anim.direction,
          tilesetId: item.anim.tileset.id,
          frames: item.anim.frames,
          tileset: item.anim.tileset,
          animKey: item.anim.animKey,
        });
      } else {
        let list = staticByTex.get(item.texture);
        if (!list) {
          list = [];
          staticByTex.set(item.texture, list);
        }
        list.push(item);
      }
    }

    for (const [tex, quads] of staticByTex) {
      const geo = buildMergedQuadGeometry(quads);
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, this.materialFor(tex, z));
      // Editor views are small; avoid any first-frame bounds miss on the level RT.
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      levelGroup.add(mesh);
    }

    if (animated.length > 0) {
      this.animatedByLevel.set(z, animated);
    }
  }

  private addQuadMesh(
    parent: THREE.Object3D,
    x: number,
    y: number,
    w: number,
    h: number,
    texture: THREE.Texture,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    depth: number,
    z: number,
    lightX0: number,
    lightY0: number,
    lightX1: number,
    lightY1: number,
  ): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(w, h);
    const uvs = geo.attributes.uv!;
    // PlaneGeometry verts (Y-up local space):
    //   0=(-w/2,+h/2)  1=(+w/2,+h/2)  2=(-w/2,-h/2)  3=(+w/2,-h/2)
    // With our Y-down ortho (top < bottom), +h/2 is LOWER on screen and -h/2 is HIGHER.
    // So map top-of-sprite (v1) to verts 2/3 and bottom-of-sprite (v0) to verts 0/1.
    uvs.setXY(0, u0, v0);
    uvs.setXY(1, u1, v0);
    uvs.setXY(2, u0, v1);
    uvs.setXY(3, u1, v1);
    uvs.needsUpdate = true;

    const lightUvs = new Float32Array([
      lightX0,
      lightY1,
      lightX1,
      lightY1,
      lightX0,
      lightY0,
      lightX1,
      lightY0,
    ]);
    geo.setAttribute("aLightUv", new THREE.BufferAttribute(lightUvs, 2));

    // Cutout material — depth Z carries painter's order (no per-quad renderOrder).
    const mat = this.materialFor(texture, z);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x + w / 2, y + h / 2, depth);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    parent.add(mesh);
    return mesh;
  }

  /**
   * Advance animation clocks. Returns true if any frame index changed
   * (so UVs were rewritten and a re-render is needed).
   */
  private updateAnimations(dt: number): boolean {
    if (this.animatedByKey.size === 0) return false;

    this.animClock += dt;
    let changed = false;

    for (const [key, instances] of this.animatedByKey) {
      const sample = instances[0]!;
      let total = 0;
      for (const f of sample.frames) total += f.durationMs;
      if (total <= 0) continue;
      let t = this.animClock % total;
      let idx = 0;
      for (let i = 0; i < sample.frames.length; i++) {
        if (t < sample.frames[i]!.durationMs) {
          idx = i;
          break;
        }
        t -= sample.frames[i]!.durationMs;
      }
      const prev = this.frameIndices.get(key);
      if (prev === idx) continue;
      this.frameIndices.set(key, idx);
      changed = true;

      const frame = sample.frames[idx]!;
      const { rect } = frame.sprite;
      const u0 = (rect.x * CELL_SIZE) / sample.tileset.width;
      const u1 = ((rect.x + rect.w) * CELL_SIZE) / sample.tileset.width;
      const v1 = 1 - (rect.y * CELL_SIZE) / sample.tileset.height;
      const v0 = 1 - ((rect.y + rect.h) * CELL_SIZE) / sample.tileset.height;
      for (const inst of instances) {
        const uvs = inst.mesh.geometry.attributes.uv!;
        uvs.setXY(0, u0, v0);
        uvs.setXY(1, u1, v0);
        uvs.setXY(2, u0, v1);
        uvs.setXY(3, u1, v1);
        uvs.needsUpdate = true;
      }
    }

    return changed;
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);

    const now = performance.now();
    const dt = Math.min(100, now - this.lastAnimTime);
    this.lastAnimTime = now;

    // Always tick animations so frame-index changes are detected even while
    // the canvas is otherwise idle. Only dirty the frame when an index flips.
    if (this.updateAnimations(dt)) {
      this.overlaySig = "";
      this.drawOverlays(useEditorStore.getState());
      this.requestRender();
    }

    if (!this.needsRender) return;
    this.needsRender = false;

    const frameStart = performance.now();
    const s = useEditorStore.getState();
    this.applyCamera(s.camera.x, s.camera.y, s.zoom);
    this.renderFrame(s);
    this.lastFrameMs = performance.now() - frameStart;

    if (import.meta.env.DEV && this.statsEl) {
      const frameMs = this.lastFrameMs;
      this.statsAccum += frameMs;
      this.statsFrames++;
      if (now - this.statsLastReport >= 500) {
        const avg = this.statsAccum / Math.max(1, this.statsFrames);
        const info = this.renderer.info.render;
        this.statsEl.textContent =
          `${avg.toFixed(1)} ms\n` +
          `${info.calls} calls · ${info.triangles} tris\n` +
          `${this.levelGroups.size} levels · ${this.animated.length} anim`;
        this.statsAccum = 0;
        this.statsFrames = 0;
        this.statsLastReport = now;
      }
    }
  };

  private levelRenderTarget(): THREE.WebGLRenderTarget {
    const { x: w, y: h } = this.renderer.getDrawingBufferSize(
      this.drawBufferSize,
    );
    if (
      this.levelTarget &&
      (!this.levelTarget.depthBuffer ||
        this.levelTarget.texture.type !== THREE.UnsignedByteType)
    ) {
      this.levelTarget.dispose();
      this.levelTarget = null;
    }
    if (!this.levelTarget) {
      // Unsigned byte + depth: predictable alpha coverage for the composite pass.
      // (Half-float is nicer for colour but some paths leave A unusable for fading.)
      this.levelTarget = new THREE.WebGLRenderTarget(w, h, {
        depthBuffer: true,
        stencilBuffer: false,
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        magFilter: THREE.NearestFilter,
        minFilter: THREE.NearestFilter,
        generateMipmaps: false,
      });
      this.levelTarget.texture.colorSpace = THREE.SRGBColorSpace;
    } else if (this.levelTarget.width !== w || this.levelTarget.height !== h) {
      this.levelTarget.setSize(w, h);
    }
    return this.levelTarget;
  }

  /**
   * Levels at full opacity are drawn straight to the canvas. A dimmed level is
   * drawn opaque into an offscreen target first, then composited as one flat
   * image so the whole level fades together rather than tile by tile.
   */
  private renderFrame(s: ReturnType<typeof useEditorStore.getState>) {
    const r = this.renderer;
    r.info.reset();
    r.setRenderTarget(null);
    r.setClearColor(BACKGROUND_COLOR, 1);
    r.clear(true, true, false);

    this.world.visible = false;
    this.grid.visible = false;
    this.overlays.visible = false;
    for (const group of this.levelGroups.values()) group.visible = false;

    const renderChrome = (group: THREE.Group) => {
      if (s.previewMode) return;
      group.visible = true;
      r.render(this.scene, this.camera);
      group.visible = false;
    };

    renderChrome(this.grid);

    this.world.visible = true;
    const levels = [...this.levelGroups.keys()].sort((a, b) => a - b);
    let batch: THREE.Group[] = [];
    const flush = () => {
      if (batch.length === 0) return;
      for (const g of batch) g.visible = true;
      r.setRenderTarget(null);
      r.setClearColor(BACKGROUND_COLOR, 1);
      r.render(this.scene, this.camera);
      for (const g of batch) g.visible = false;
      batch = [];
    };

    for (const z of levels) {
      const opacity = opacityForLevel(
        z,
        s.currentLevel,
        s.showOtherLevels,
        s.previewMode,
      );
      if (opacity === null) continue;
      const group = this.levelGroups.get(z)!;
      if (opacity >= 1) {
        batch.push(group);
        continue;
      }
      // Anything below this level must already be on the canvas.
      flush();

      const target = this.levelRenderTarget();
      group.visible = true;
      r.setRenderTarget(target);
      r.setClearColor(0x000000, 0);
      r.clear(true, true, false);
      r.render(this.scene, this.camera);
      group.visible = false;

      r.setRenderTarget(null);
      r.setClearColor(BACKGROUND_COLOR, 1);
      this.compositeMaterial.uniforms.tLevel!.value = target.texture;
      this.compositeMaterial.uniforms.uOpacity!.value = opacity;
      r.render(this.compositeScene, this.compositeCamera);
    }
    flush();
    this.world.visible = false;

    renderChrome(this.overlays);
  }

  private pointerToCoord(e: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const s = useEditorStore.getState();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    return screenToCoord(
      screenX,
      screenY,
      s.zoom,
      s.camera.x,
      s.camera.y,
      s.currentLevel,
    );
  }

  private bindEvents() {
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointerleave", this.onPointerUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code === "Space") {
      this.spaceDown = true;
      e.preventDefault();
    }
    const store = useEditorStore.getState();
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }
    const toolMap: Record<string, ToolId> = {
      KeyV: "select",
      KeyE: "erase",
      KeyB: "pencil",
      KeyR: "rect",
      KeyC: "circle",
    };
    if (toolMap[e.code]) {
      store.setTool(toolMap[e.code]!);
    }
    if (e.code === "KeyP") {
      store.togglePreviewMode();
    }
    if (e.key === ",") {
      store.setLevel(Math.max(MIN_LEVEL, store.currentLevel - 1));
    }
    if (e.key === ".") {
      store.setLevel(Math.min(MAX_LEVEL, store.currentLevel + 1));
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code === "Space") this.spaceDown = false;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const store = useEditorStore.getState();
    const zooms = [2, 3, 4, 5, 6, 7, 8];
    const idx = zooms.indexOf(store.zoom);
    const next =
      e.deltaY > 0
        ? zooms[Math.max(0, (idx === -1 ? 2 : idx) - 1)]!
        : zooms[Math.min(zooms.length - 1, (idx === -1 ? 2 : idx) + 1)]!;
    store.setZoom(next);
  };

  private onPointerDown = (e: PointerEvent) => {
    const store = useEditorStore.getState();
    if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
      this.panning = true;
      this.panLast = { x: e.clientX, y: e.clientY };
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;

    const coord = this.pointerToCoord(e);
    const tool = store.tool;

    if (tool === "select") {
      store.selectCoord(coord.x, coord.y);
      return;
    }

    if (tool === "erase") {
      this.painting = true;
      this.lastPaintKey = `${coord.x},${coord.y}`;
      store.beginStroke();
      store.eraseAt(coord.x, coord.y);
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }

    if (tool === "pencil") {
      if (!store.selected) {
        useEditorStore.setState({ lastToast: "No source selected" });
        return;
      }
      this.painting = true;
      this.lastPaintKey = `${coord.x},${coord.y}`;
      store.beginStroke();
      const r = store.stampAt(coord.x, coord.y);
      if (r.skipped && r.reason) {
        useEditorStore.setState({ lastToast: r.reason });
      }
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }

    if (tool === "rect" || tool === "circle") {
      if (!store.selected) {
        useEditorStore.setState({ lastToast: "No source selected" });
        return;
      }
      this.shapeAnchor = coord;
      store.setShapePreview({
        kind: tool,
        x0: coord.x,
        y0: coord.y,
        x1: coord.x,
        y1: coord.y,
      });
      this.canvas.setPointerCapture(e.pointerId);
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    const store = useEditorStore.getState();

    if (this.panning) {
      const dx = (e.clientX - this.panLast.x) / store.zoom;
      const dy = (e.clientY - this.panLast.y) / store.zoom;
      this.panLast = { x: e.clientX, y: e.clientY };
      // Dragging right moves camera left (content follows pointer)
      store.setCamera({
        x: store.camera.x - dx,
        y: store.camera.y - dy,
      });
      return;
    }

    const coord = this.pointerToCoord(e);
    store.setHover(coord);

    if (this.painting) {
      const key = `${coord.x},${coord.y}`;
      if (key === this.lastPaintKey) return;
      this.lastPaintKey = key;
      if (store.tool === "erase") store.eraseAt(coord.x, coord.y);
      if (store.tool === "pencil") {
        const r = store.stampAt(coord.x, coord.y);
        if (r.skipped && r.reason) {
          useEditorStore.setState({ lastToast: r.reason });
        }
      }
      return;
    }

    if (this.shapeAnchor && store.shapePreview) {
      store.setShapePreview({
        ...store.shapePreview,
        x1: coord.x,
        y1: coord.y,
      });
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    const store = useEditorStore.getState();
    if (this.panning) {
      this.panning = false;
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      return;
    }

    if (this.painting) {
      this.painting = false;
      store.endStroke();
    }

    if (this.shapeAnchor && store.shapePreview) {
      const { kind, x0, y0, x1, y1 } = store.shapePreview;
      const coords =
        kind === "rect"
          ? this.rectList(x0, y0, x1, y1)
          : this.circleList(x0, y0, x1, y1);
      const result = store.stampMany(coords);
      if (result.skipped > 0) {
        useEditorStore.setState({
          lastToast: `Skipped ${result.skipped} cell(s)${
            result.reason ? `: ${result.reason}` : ""
          }`,
        });
      }
      store.setShapePreview(null);
      this.shapeAnchor = null;
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
  };
}
