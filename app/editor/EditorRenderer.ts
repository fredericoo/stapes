/**
 * Map editor renderer (grid, tools, overlays, store sync).
 * Play mode uses the shared world draw in `app/render/WorldRenderer.ts`.
 */
import * as THREE from "three";
import { tilesetUrl } from "../lib/api";
import {
  absoluteElevation,
  baseCellWorldOrigin,
  depthBox,
  depthStackBias,
  drawOrder,
  screenToCoord,
  spriteWorldOrigin,
} from "../lib/geometry";
import {
  computeLighting,
  type LevelLightMap,
  type LightGrid,
} from "../lib/lighting";
import { sampleIllumination } from "../lib/clock";
import {
  getStack,
  listCoords,
  stackHeight,
  terrainHeight,
} from "../lib/mapData";
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
  frameIndexAtTime,
  isDirectional,
  levelKey,
  tileCanEmitLight,
} from "../lib/types";
import { getFrames, tileLightSignature } from "../lib/tileResolve";
import { canPlace, canReplaceStack } from "../lib/validation";
import { useEditorStore, type ToolId } from "./store";
import { panCameraByWheel } from "./camera";
import type { EditorPerfMeasure, EditorPerfSnapshot } from "./perf";
import { floodCoords, stacksEqual } from "./tools";
import {
  type LevelLightUniforms,
  type Quad,
  WORLD_SHADER_CACHE_KEY,
  buildMergedQuadGeometry,
  buildSingleQuadGeometry,
  injectWorldShader,
} from "../render/worldQuads";
import { noTintUniforms } from "../render/spriteTint";
import {
  createLevelFadeCompositeMaterial,
  PalettePass,
} from "../render/palettePass";
import {
  OVERLAY_RENDER_ORDER,
  type SpriteMeshOptions,
  disposeGroupChildren,
  makeRectOutline,
  makeSpriteMesh,
  makeSpriteOutline,
  OutlineMaterials,
} from "../render/overlayMeshes";
import {
  type SpriteQuad,
  type SpriteQuadAssets,
  spriteQuadFor,
} from "../render/spriteQuad";

type AnimatedInstance = {
  mesh: THREE.Mesh;
  tileId: string;
  direction?: string;
  tilesetId: string;
  frames: Frame[];
  tileset: TilesetDef;
  animKey: string;
  /** Index into {@link frames} the mesh's UVs currently show. @see WorldRenderer */
  frameIdx: number;
};

/** A textured rectangle in world pixels, ready to be turned into a mesh. */
const BACKGROUND_COLOR = 0xb8b09e;

const GHOST_OPACITY = 0.55;
/** Big shapes fall back to outlines only — one mesh per sprite gets costly. */
const MAX_GHOST_CELLS = 256;

/** Debounce lighting recompute while painting. */
const LIGHTING_DEBOUNCE_MS = 50;
/**
 * Shift the sampled light map half a cell up-left so glow sits nearer the
 * visual middle of a tile (cabinet projection), not the base corner.
 */
const LIGHT_MAP_CELL_OFFSET = 0.5;

/** Fade of the fused "other levels" image over the floor being edited. */
const OTHER_LEVELS_OPACITY = 0.35;

type LevelVisibility = "hidden" | "solid" | "ghost";

/**
 * How a level is drawn relative to the one being edited.
 *
 * Underground the surface is a lid, and it is a lid in both modes: from -1 down,
 * nothing at 0 or above is drawn at all. The world over a cave is a whole town,
 * and neither previewing a tunnel nor painting one is helped by having it
 * overhead — which is also why the roof-cut exists in play.
 *
 * Under that lid, preview is the game: every remaining floor, solid, because it
 * is there to be looked at rather than painted into.
 *
 * Authoring keeps the same shape and only decides what to do with the floors
 * you are standing *over*. Everything at or below the current level is solid,
 * always, so a floor is edited in the context it will be played in. Everything
 * above is either gone or one fused ghost.
 */
function levelVisibility(
  z: number,
  current: number,
  showOther: boolean,
  preview: boolean,
): LevelVisibility {
  if (z < MIN_LEVEL || z > MAX_LEVEL) return "hidden";
  if (current < 0 && z >= 0) return "hidden";
  if (preview) return "solid";
  if (z <= current) return "solid";
  if (!showOther) return "hidden";
  return "ghost";
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
  /**
   * The outline materials, kept across rebuilds — see
   * {@link OutlineMaterials}.
   * The editor is the harder case of the two: the hover cell is in the overlay
   * signature, so the chrome is rebuilt on every mouse move across the grid.
   */
  private outlineMaterials = new OutlineMaterials();
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
  private palettePass: PalettePass;
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
  /** Last `lighting.enabled` pushed to the uniforms; drives the transition. */
  private lightingEnabled = true;
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
    // Tile quads all sit at z = 0 and write their own fragment depth, so the
    // frustum only has to contain that plane; chrome overlays skip depth test.
    this.camera = new THREE.OrthographicCamera(0, 1, 0, 1, -10, 50);
    this.camera.position.z = 25;

    this.world = new THREE.Group();
    this.grid = new THREE.Group();
    this.overlays = new THREE.Group();
    this.scene.add(this.world);
    this.scene.add(this.grid);
    this.scene.add(this.overlays);

    this.compositeMaterial = createLevelFadeCompositeMaterial();
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this.compositeMaterial,
    );
    quad.frustumCulled = false;
    this.compositeScene = new THREE.Scene();
    this.compositeScene.add(quad);
    this.compositeCamera = new THREE.Camera();

    this.palettePass = new PalettePass();

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
      for (const chunk of Object.values(level)) {
        for (const stack of Object.values(chunk)) n += stack.length;
      }
    }
    return n;
  }

  dispose() {
    this.disposed = true;
    // Finalize any open paint stroke so history isn't left stuck (e.g. HMR).
    useEditorStore.getState().endStroke();
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
    disposeGroupChildren(this.overlays, this.outlineMaterials);
    this.outlineMaterials.dispose();
    this.palettePass.dispose();
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
    el.textContent = "…";
    const parent = this.canvas.parentElement;
    const slot = parent?.querySelector("[data-editor-stats]");
    if (slot) {
      slot.replaceChildren(el);
      this.statsEl = el;
      return;
    }
    // Fallback when the React chrome slot isn't mounted yet.
    el.style.cssText =
      "position:absolute;top:4px;right:4px;z-index:50;font:11px/1.3 ui-monospace,monospace;" +
      "background:rgba(244,240,230,0.9);color:#2d6a4f;padding:4px 6px;pointer-events:none;" +
      "border:2px solid #1a1a1a;box-shadow:2px 2px 0 0 #1a1a1a;white-space:pre;";
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
        const tex = await loader.loadAsync(tilesetUrl(ts.file));
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
        // A level whose materials appear while the toggle is off must arrive
        // unlit too, or it would be the one floor still shaded.
        uLightingEnabled: { value: this.lightingEnabled ? 1 : 0 },
        uAmbient: { value: new THREE.Vector3(0, 0, 0) },
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
        // No tint in the map editor: a status is a thing that happens in a
        // running world, and there is no running world here. The inert uniforms
        // keep one shader program shared with play rather than compiling a
        // second one that differs only by a branch nothing takes.
        injectWorldShader(shader, lightUniforms, noTintUniforms());
      };
      mat.customProgramCacheKey = () => WORLD_SHADER_CACHE_KEY;
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
    // The last word on whether a bake happens, wherever the call came from.
    if (!s.lighting.enabled) return;
    const key = this.lightingFingerprint(s);
    if (!force && key === this.lightingKey) return;
    this.lightingKey = key;

    const ambient = sampleIllumination(s.lighting.minutesOfDay).ambient;
    const grid = computeLighting(s.map, s.tilesById, ambient);
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
    // Levels with no contribution stay black (sky/torch fill comes from computeLighting).
    for (const z of this.lightUniformsByZ.keys()) {
      if (seen.has(z)) continue;
      const u = this.ensureLightUniforms(z);
      u.uLightOrigin.value.set(0, 0);
      u.uLightSize.value.set(1, 1);
      const data = new Uint8Array([0, 0, 0, 255]);
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
    u.uLightOrigin.value.set(
      level.x0 - LIGHT_MAP_CELL_OFFSET,
      level.y0 - LIGHT_MAP_CELL_OFFSET,
    );
    u.uLightSize.value.set(level.w, level.h);

    const rgba = new Uint8Array(level.w * level.h * 4);
    for (let i = 0, p = 0; i < level.rgb.length; i += 3, p += 4) {
      rgba[p] = level.rgb[i]!;
      rgba[p + 1] = level.rgb[i + 1]!;
      rgba[p + 2] = level.rgb[i + 2]!;
      // Alpha 0: this grid is already tinted, so the shader must not add a
      // second helping of ambient on top.
      rgba[p + 3] = 0;
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
    this.applyLightingEnabled(s.lighting.enabled);
    if (s.lighting.enabled) this.maybeScheduleLighting();
    this.requestRender();
  }

  /**
   * Draw the map unlit, and stop computing light at all.
   *
   * The bake here is unchunked — a whole-map flood every time the fingerprint
   * moves — so turning it off has to mean *skipped*, not "computed and then
   * ignored by the shader". Any pending recompute is dropped with it: a stroke
   * that armed the debounce a moment ago would otherwise still land.
   *
   * Coming back on, the held fingerprint is cleared rather than compared: the
   * map may have been painted all over while nothing was being recomputed, so
   * an unchanged key would leave the stale grid on screen.
   */
  private applyLightingEnabled(enabled: boolean) {
    if (enabled === this.lightingEnabled) return;
    this.lightingEnabled = enabled;
    for (const u of this.lightUniformsByZ.values()) {
      u.uLightingEnabled.value = enabled ? 1 : 0;
    }
    if (!enabled && this.lightingTimer) {
      clearTimeout(this.lightingTimer);
      this.lightingTimer = null;
    }
    if (enabled) this.lightingKey = "";
  }

  private lightingFingerprint(s: ReturnType<typeof useEditorStore.getState>) {
    let lightDefsSig = 0;
    for (const t of s.tiles) {
      const sig = tileLightSignature(t);
      if (sig) {
        let h = 0;
        for (let i = 0; i < sig.length; i++) h = (h * 31 + sig.charCodeAt(i)) | 0;
        lightDefsSig = (lightDefsSig * 31 + h) | 0;
      }
      if (t.lightPassing) lightDefsSig = (lightDefsSig * 17 + 3) | 0;
      if (t.blocksLight != null) {
        lightDefsSig = (lightDefsSig * 17 + (t.blocksLight ? 3 : 5)) | 0;
      }
    }
    const { minutesOfDay } = s.lighting;
    return `${Math.floor(minutesOfDay)}|${s.mapVersion}|${lightDefsSig}|${Object.keys(s.tilesById).length}`;
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
      s.armedTileId ?? "",
      sp ? `${sp.kind}:${sp.x0},${sp.y0},${sp.x1},${sp.y1}` : "",
      frames,
    ].join("|");
  }

  private drawOverlays(s: ReturnType<typeof useEditorStore.getState>) {
    const sig = this.overlaySignature(s);
    if (sig === this.overlaySig) return;
    this.overlaySig = sig;

    disposeGroupChildren(this.overlays, this.outlineMaterials);

    const addRectOutline = (
      originX: number,
      originY: number,
      w: number,
      h: number,
      color: number,
      heavy = false,
    ) => {
      for (const line of makeRectOutline(originX, originY, w, h, color, heavy)) {
        this.overlays.add(line);
      }
    };

    const addSprite = (q: SpriteQuad, opts: SpriteMeshOptions) => {
      this.overlays.add(makeSpriteMesh(q, opts));
    };

    const addSpriteOutline = (q: SpriteQuad, color: number) => {
      this.overlays.add(makeSpriteOutline(q, color, this.outlineMaterials));
    };

    const z = s.currentLevel;
    // Selected cell → stamp that stack; otherwise ghost the armed tile (append).
    const appendMode = !s.selected;
    let brush: PlacedTile[] = [];
    if (s.selected) {
      brush = getStack(s.map, s.selected.x, s.selected.y, z);
    } else if (s.armedTileId) {
      const def = s.tilesById[s.armedTileId];
      if (def) {
        brush =
          isDirectional(def)
            ? [{ tileId: def.id, direction: "s" }]
            : [{ tileId: def.id }];
      }
    }

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
        const quad = def
          ? this.spriteQuad(placed, def, x, y, z, elev, s.map)
          : null;

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

        // Unlit redraw covers the lit map tile, then a tiny additive lift.
        addSprite(quad, {
          color: 0xffffff,
          opacity: 1,
          blending: THREE.NormalBlending,
          renderOrder: OVERLAY_RENDER_ORDER.spriteFill,
          alphaTest: 0.5,
        });
        addSprite(quad, {
          color: 0xffffff,
          opacity: 0.08,
          blending: THREE.AdditiveBlending,
          renderOrder: OVERLAY_RENDER_ORDER.spriteLift,
        });

        if (stackIndex === brush.length - 1) {
          addSpriteOutline(quad, 0xffcc00);
        }

        elev += terrainHeight(placed, s.tilesById);
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

      if (appendMode) {
        const def = s.tilesById[brush[0]!.tileId];
        if (!def) continue;
        if (!canPlace(s.map, c.x, c.y, z, def, s.tilesById).ok) {
          const origin = baseCellWorldOrigin(c.x, c.y, z, 0);
          addRectOutline(origin.x, origin.y, CELL_SIZE, CELL_SIZE, 0xff4d4d, true);
          continue;
        }
        const elev = stackHeight(getStack(s.map, c.x, c.y, z), s.tilesById);
        const placed = brush[0]!;
        const quad = this.spriteQuad(placed, def, c.x, c.y, z, elev, s.map);
        if (quad) {
          addSprite(quad, {
            color: 0xffffff,
            opacity: GHOST_OPACITY,
            blending: THREE.NormalBlending,
            renderOrder: drawOrder(
              c.x,
              c.y,
              absoluteElevation(z, elev),
              getStack(s.map, c.x, c.y, z).length,
            ),
          });
        }
        continue;
      }

      if (!canReplaceStack(s.map, c.x, c.y, z, brush, s.tilesById).ok) {
        const origin = baseCellWorldOrigin(c.x, c.y, z, 0);
        addRectOutline(origin.x, origin.y, CELL_SIZE, CELL_SIZE, 0xff4d4d, true);
        continue;
      }

      let elev = 0;
      brush.forEach((placed, stackIndex) => {
        const def = s.tilesById[placed.tileId];
        if (!def) return;
        const quad = this.spriteQuad(placed, def, c.x, c.y, z, elev, s.map);
        if (quad) {
          addSprite(quad, {
            color: 0xffffff,
            opacity: GHOST_OPACITY,
            blending: THREE.NormalBlending,
            renderOrder: drawOrder(
              c.x,
              c.y,
              absoluteElevation(z, elev),
              stackIndex,
            ),
          });
        }
        elev += terrainHeight(placed, s.tilesById);
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
      s.tool === "pencil" ||
      s.tool === "rect" ||
      s.tool === "circle" ||
      s.tool === "bucket";
    if (paints && s.hover) return [s.hover];
    return [];
  }

  /** Asset handles the shared sprite-quad builder needs. */
  private quadAssets(): SpriteQuadAssets {
    return {
      tilesetById: this.tilesetById,
      textures: this.textures,
      fallbackTexture: this.magentaTex,
      frameIndices: this.frameIndices,
    };
  }

  private spriteQuad(
    placed: PlacedTile,
    def: TileDef,
    x: number,
    y: number,
    z: number,
    elevation: number,
    map: MapFile,
  ): SpriteQuad | null {
    return spriteQuadFor(
      this.quadAssets(),
      map,
      { x, y, z, elevation },
      placed,
      def,
    );
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
   * every level that has any changed cell. Quads are merged per tileset on
   * the level, so a single cell edit must refresh the whole level's meshes —
   * still cheap (one buffer per tileset).
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
      texture: THREE.Texture;
      anim?: {
        frames: Frame[];
        tileId: string;
        direction?: string;
        tileset: TilesetDef;
        animKey: string;
        frameIdx: number;
      };
    };

    const items: Item[] = [];

    for (const cell of coords) {
      let elev = 0;
      cell.stack.forEach((placed, stackIndex) => {
        const def = this.tilesById[placed.tileId];
        const foot = absoluteElevation(z, elev);

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
            box: depthBox(cell.x, cell.y, foot, foot),
            stackBias: depthStackBias(z, stackIndex),
            texture: this.magentaTex,
            lightX0: cell.x,
            lightY0: cell.y,
            lightX1: cell.x + 1,
            lightY1: cell.y + 1,
            unlit: false,
          });
          return;
        }

        const frames = getFrames(def, {
          direction: placed.direction,
          map,
          x: cell.x,
          y: cell.y,
          z,
        });
        // The frame the shared clock is on, not frame 0 — a rebuilt mesh that
        // started at 0 would sit there until the clock crossed into the next
        // index. @see WorldRenderer.updateAnimations
        const frameIdx = frames ? frameIndexAtTime(frames, this.animClock) : 0;
        const first = frames?.[frameIdx];
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
        const lightX0 = cell.x;
        const lightY0 = cell.y;
        const lightX1 = cell.x + 1;
        const lightY1 = cell.y + 1;
        const unlit = tileCanEmitLight(def);
        const animKey =
          def.type === "autotile"
            ? `${def.id}:${cell.x},${cell.y},${z}`
            : `${def.id}:${placed.direction ?? "default"}`;

        items.push({
          x: origin.x,
          y: origin.y,
          w,
          h,
          u0,
          v0,
          u1,
          v1,
          box: depthBox(cell.x, cell.y, foot, foot + def.height),
          stackBias: depthStackBias(z, stackIndex),
          texture,
          lightX0,
          lightY0,
          lightX1,
          lightY1,
          unlit,
          anim:
            isAnimated && frames
              ? {
                  frames,
                  tileId: def.id,
                  direction: placed.direction,
                  tileset,
                  animKey,
                  frameIdx,
                }
              : undefined,
        });

        elev += terrainHeight(placed, this.tilesById);
      });
    }

    if (items.length === 0) return;

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
        const mesh = this.addQuadMesh(levelGroup, item, item.texture, z);
        animated.push({
          mesh,
          tileId: item.anim.tileId,
          direction: item.anim.direction,
          tilesetId: item.anim.tileset.id,
          frames: item.anim.frames,
          tileset: item.anim.tileset,
          animKey: item.anim.animKey,
          frameIdx: item.anim.frameIdx,
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
    quad: Quad,
    texture: THREE.Texture,
    z: number,
  ): THREE.Mesh {
    // Cutout material — the shader writes per-fragment depth for painter order.
    const geo = buildSingleQuadGeometry(quad);
    const mesh = new THREE.Mesh(geo, this.materialFor(texture, z));
    mesh.position.set(quad.x + quad.w / 2, quad.y + quad.h / 2, 0);
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
      const idx = frameIndexAtTime(sample.frames, this.animClock);
      this.frameIndices.set(key, idx);

      const frame = sample.frames[idx];
      if (!frame) continue;
      const { rect } = frame.sprite;
      const u0 = (rect.x * CELL_SIZE) / sample.tileset.width;
      const u1 = ((rect.x + rect.w) * CELL_SIZE) / sample.tileset.width;
      const v1 = 1 - (rect.y * CELL_SIZE) / sample.tileset.height;
      const v0 = 1 - ((rect.y + rect.h) * CELL_SIZE) / sample.tileset.height;
      // Per instance, not per key: a mesh rebuilt by an edit can be showing a
      // different frame from the one the shared index last ticked to.
      for (const inst of instances) {
        if (inst.frameIdx === idx) continue;
        inst.frameIdx = idx;
        changed = true;
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
   * The clear colour behind the world.
   *
   * Preview is meant to be play, and play's sky moves with the hour, so it
   * takes the same colour. Authoring keeps the flat paper colour — as does
   * preview with lighting off, where the hour has stopped meaning anything and
   * a midnight sky behind fully lit tiles is just confusing.
   */
  private backgroundFor(
    s: ReturnType<typeof useEditorStore.getState>,
  ): number {
    if (!s.previewMode || !s.lighting.enabled) return BACKGROUND_COLOR;
    return sampleIllumination(s.lighting.minutesOfDay).background;
  }

  /**
   * Solid levels go down in one pass, exactly as play draws them: every quad
   * writes its own depth, so a single render interleaves the floors correctly
   * and nothing here has to sort them. The levels above — the ghosts — are
   * drawn into an offscreen target together and faded in as one image.
   *
   * The fade lands *after* the palette quantise, and that ordering is the whole
   * point of it: a ghost blended into the scene target would be quantised too,
   * and quantising a translucent pixel does not give you a translucent pixel —
   * it gives you whichever solid palette entry happens to sit nearest the
   * blend. Composited onto the finished frame instead, a ghost is actually
   * see-through, and is the one thing on screen deliberately off-palette.
   */
  private renderFrame(s: ReturnType<typeof useEditorStore.getState>) {
    const r = this.renderer;
    r.info.reset();

    const background = this.backgroundFor(s);
    const output = this.palettePass.sceneTarget(r);

    r.setRenderTarget(output);
    r.setClearColor(background, 1);
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
    const solid: THREE.Group[] = [];
    const ghosts: THREE.Group[] = [];
    for (const [z, group] of this.levelGroups) {
      const visibility = levelVisibility(
        z,
        s.currentLevel,
        s.showOtherLevels,
        s.previewMode,
      );
      if (visibility === "hidden") continue;
      (visibility === "solid" ? solid : ghosts).push(group);
    }

    if (solid.length > 0) {
      for (const g of solid) g.visible = true;
      r.setRenderTarget(output);
      r.render(this.scene, this.camera);
      for (const g of solid) g.visible = false;
    }

    const ghostImage =
      ghosts.length > 0 ? this.renderGhostImage(ghosts) : null;
    this.world.visible = false;

    // Quantise before the ghosts and the chrome: outlines keep their exact
    // colour, and a faded floor keeps its fade.
    this.palettePass.blitToCanvas(r);

    if (ghostImage) this.fadeOntoCanvas(ghostImage);

    renderChrome(this.overlays);
  }

  /**
   * Draw every level above the current one into one offscreen image.
   *
   * Fusing them is the point. Composited a floor at a time, each ghost blends
   * over the one below it, so a stack of rooms reads as every interior wall in
   * the building at once and the fade compounds with depth. Drawn together into
   * one depth-sorted target, only the surfaces you would actually see looking
   * down survive into the picture that gets faded.
   */
  private renderGhostImage(groups: THREE.Group[]): THREE.Texture {
    const r = this.renderer;
    const target = this.levelRenderTarget();

    for (const g of groups) g.visible = true;
    r.setRenderTarget(target);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    r.render(this.scene, this.camera);
    for (const g of groups) g.visible = false;

    return target.texture;
  }

  /** Blend the ghost image over the finished frame, at real alpha. */
  private fadeOntoCanvas(image: THREE.Texture) {
    const r = this.renderer;
    r.setRenderTarget(null);
    this.compositeMaterial.uniforms.tLevel!.value = image;
    this.compositeMaterial.uniforms.uOpacity!.value = OTHER_LEVELS_OPACITY;
    r.render(this.compositeScene, this.compositeCamera);
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

  private updateCursor() {
    if (this.panning) {
      this.canvas.style.cursor = "grabbing";
    } else if (this.spaceDown) {
      this.canvas.style.cursor = "grab";
    } else {
      this.canvas.style.cursor = "";
    }
  }

  private onKeyDown = (e: KeyboardEvent) => {
    const target = e.target;
    const inField =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable);
    const inChrome =
      target instanceof Element &&
      Boolean(target.closest("button, a, [role='button'], select"));

    if (e.code === "Space") {
      if (inField || inChrome) return;
      this.spaceDown = true;
      this.updateCursor();
      e.preventDefault();
      return;
    }
    if (inField) return;

    const store = useEditorStore.getState();
    if (e.code === "Escape") {
      if (!store.selected) return;
      e.preventDefault();
      store.setSelected(null);
      return;
    }
    if (e.code === "Backspace" || e.code === "Delete") {
      if (!store.selected) return;
      const stack = getStack(
        store.map,
        store.selected.x,
        store.selected.y,
        store.currentLevel,
      );
      if (stack.length === 0) return;
      e.preventDefault();
      store.removeFromStack(stack.length - 1);
      return;
    }
    const toolMap: Record<string, ToolId> = {
      KeyV: "select",
      KeyE: "erase",
      KeyB: "pencil",
      KeyR: "rect",
      KeyC: "circle",
      KeyG: "bucket",
    };
    if (toolMap[e.code]) {
      store.setTool(toolMap[e.code]!);
    }
    if (e.code === "KeyW") {
      store.togglePreviewMode();
    }
    // Live while previewing, where it simply has nothing to do: preview draws
    // every level regardless. A key that refuses is worse than one that lands
    // silently — you set the state you want and see it the moment you leave.
    if (e.code === "KeyL") {
      store.toggleShowOtherLevels();
    }
    // `[` / `]` are what the buttons say; `,` / `.` were the binding before
    // them and still work, for the hands that already know it.
    if (e.key === "[" || e.key === ",") {
      store.setLevel(Math.max(MIN_LEVEL, store.currentLevel - 1));
    }
    if (e.key === "]" || e.key === ".") {
      store.setLevel(Math.min(MAX_LEVEL, store.currentLevel + 1));
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code === "Space") {
      this.spaceDown = false;
      this.updateCursor();
    }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    panCameraByWheel(e, { width: this.canvasW, height: this.canvasH });
  };

  private onPointerDown = (e: PointerEvent) => {
    const store = useEditorStore.getState();
    if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
      this.panning = true;
      this.panLast = { x: e.clientX, y: e.clientY };
      this.updateCursor();
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
      if (!store.selected && !store.armedTileId) {
        useEditorStore.setState({ lastToast: "No tile armed" });
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
      if (!store.selected && !store.armedTileId) {
        useEditorStore.setState({ lastToast: "No tile armed" });
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

    if (tool === "bucket") {
      if (!store.selected && !store.armedTileId) {
        useEditorStore.setState({ lastToast: "No tile armed" });
        return;
      }
      const target = getStack(
        store.map,
        coord.x,
        coord.y,
        store.currentLevel,
      );
      if (target.length === 0) return;
      if (store.selected) {
        const source = getStack(
          store.map,
          store.selected.x,
          store.selected.y,
          store.currentLevel,
        );
        if (stacksEqual(source, target)) return;
      }
      const coords = floodCoords(
        store.map,
        coord.x,
        coord.y,
        store.currentLevel,
      );
      if (coords.length === 0) return;
      const result = store.stampMany(coords);
      if (result.skipped > 0) {
        useEditorStore.setState({
          lastToast: `Skipped ${result.skipped} cell(s)${
            result.reason ? `: ${result.reason}` : ""
          }`,
        });
      }
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
      this.updateCursor();
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
