import type { WeatherArea } from "../lib/weatherAreas";
import * as THREE from "three";
import { HumanTextures } from "../render/humanTextures";
import { tilesetUrl } from "../lib/api";
import {
  absoluteElevation,
  baseCellWorldOrigin,
  depthBox,
  depthOriginAt,
  depthStackBias,
  drawOrder,
  screenToCoord,
  spriteWorldOrigin,
} from "../lib/geometry";
import { type PackedLightGrid, VOID_BACKGROUND } from "../lib/lighting";
import {
  ChunkedLighting,
  LIGHT_CHUNK_SIZE,
  LIGHT_WINDOW_MARGIN,
  type LightWindow,
  type WorldRect,
} from "../lib/lightingChunks";
import { sampleIllumination } from "../lib/clock";
import {
  changedCellsOnLevel,
  chunkKeyAt,
  footElevation,
  getChunk,
  getStack,
  setStacks,
  stackHeight,
  terrainHeight,
} from "../lib/mapData";
import { type LevelRange, lightLevels } from "../lib/view";
import type { ChunkCells, Frame, MapFile, PlacedTile, TileDef, TilesetDef } from "../lib/types";
import {
  CELL_SIZE,
  CHUNK_SIZE,
  MAX_LEVEL,
  MIN_LEVEL,
  frameIndexAtTime,
  isDirectional,
  levelKey,
  parseCoordKey,
  tileCanEmitLight,
} from "../lib/types";
import {
  buildQueuedNearestFirst,
  chunkAddressKey,
  MESH_BUILD_NOW_MARGIN,
  type MeshWindow,
  parseChunkAddress,
  visibleChunkKeys,
} from "../render/meshWindow";
import { LevelLights } from "../render/levelLights";
import { clumpExtents } from "../render/depthClump";
import { resolveTileSprite } from "../lib/tileResolve";
import { cellPhaseMs, footprintOf, spriteRect } from "../lib/types";
import { isSpanPart } from "../lib/footprint";
import { AnimationTable, NO_ANIMATION } from "../render/animTable";
import { canPlace, canReplaceStack } from "../lib/validation";
import { useEditorStore, type ToolId, type ZoomLevel } from "./store";
import { drawnLevelRange, levelVisibility } from "./levelBand";
import { cameraAnchoredAtZoom, panCameraByWheel, pinchZoomSteps, steppedZoom } from "./camera";
import type { EditorPerfMeasure, EditorPerfSnapshot } from "./perf";
import { floodCoords, stacksEqual } from "./tools";
import { activeConfig, planProcedural } from "./procedural";
import {
  type LevelAnimUniforms,
  depthOriginUniforms,
  noAnimUniforms,
  noCutUniforms,
  type Quad,
  setDepthOrigin,
  WORLD_SHADER_CACHE_KEY,
  buildMergedQuadGeometry,
  buildSingleQuadGeometry,
  concatQuadGeometries,
  injectWorldShader,
} from "../render/worldQuads";
import { noTintUniforms } from "../render/spriteTint";
import { SINGLE_PASS_DOUBLE_SIDE } from "../render/doubleSided";
import { createLevelFadeCompositeMaterial, PalettePass } from "../render/palettePass";
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
  animationKey,
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
  frameIdx: number;
};

/**
 * A chunk is built on its own, as in the play renderer, but is not drawn on
 * its own: `merged` is never uploaded, and each level draws one concatenation
 * of its chunks' batches per texture, so the draw calls stay a function of
 * the levels and textures in view rather than of the chunks.
 */
type EditorChunk = {
  z: number;
  merged: Map<THREE.Texture, THREE.BufferGeometry>;
  separates: THREE.Group | null;
  animated: AnimatedInstance[];
  quads: number;
};

const BACKGROUND_COLOR = 0xb8b09e;

const GHOST_OPACITY = 0.55;

const WEATHER_AREA_SELECTED = 0xffcc00;
const WEATHER_AREA_COLORS = { both: 0xaffcdb, rain: 0x4d9be6, fog: 0x9babb2, neither: 0xfb6b1d };

function weatherAreaColor(area: WeatherArea): number {
  if (area.rain && area.fog) return WEATHER_AREA_COLORS.both;
  if (area.rain) return WEATHER_AREA_COLORS.rain;
  return area.fog ? WEATHER_AREA_COLORS.fog : WEATHER_AREA_COLORS.neither;
}
const MAX_GHOST_CELLS = 256;
const MAX_GENERATOR_GHOST_CELLS = 1200;

const LIGHTING_DEBOUNCE_MS = 50;

const WHEEL_PINCH_STEP = 0.25;

const OTHER_LEVELS_OPACITY = 0.35;

type PinchGesture = {
  mid: { x: number; y: number };
  spreadAtZoom: number;
};

function overlaps(a: MeshWindow | null, b: MeshWindow): boolean {
  return a !== null && a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
}

function sameWindow(a: MeshWindow | null, b: MeshWindow): boolean {
  return (
    a !== null &&
    a.x0 === b.x0 &&
    a.y0 === b.y0 &&
    a.x1 === b.x1 &&
    a.y1 === b.y1 &&
    a.levels.z0 === b.levels.z0 &&
    a.levels.z1 === b.levels.z1
  );
}

/**
 * Safari's own pinch-zoom gesture events, cancelled on the canvas only. The
 * page allows pinch-zoom everywhere else, but a two-finger drag on the map is
 * meant to pan it, and Safari zooming the whole page instead leaves the
 * editor cropped off screen with no way back to the canvas.
 */
const SAFARI_GESTURE_EVENTS = ["gesturestart", "gesturechange", "gestureend"] as const;

function preventDefault(e: Event) {
  e.preventDefault();
}

function midpointOf(
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function spreadOf(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function disposeObject3D(obj: THREE.Object3D) {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
  });
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx]!;
}

export class EditorRenderer {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private grid: THREE.Group;
  private overlays: THREE.Group;
  private outlineMaterials = new OutlineMaterials();
  private world: THREE.Group;
  private textures = new Map<string, THREE.Texture>();
  private materials = new Map<string, THREE.MeshBasicMaterial>();
  private tilesets: TilesetDef[] = [];
  private tilesetById = new Map<string, TilesetDef>();
  private tilesById: Record<string, TileDef> = {};
  private humans = new HumanTextures((tileset, texture) => {
    this.tilesetById.set(tileset.id, tileset);
    this.textures.set(tileset.id, texture);
    if (!this.assetsReady || this.disposed) return;
    this.discardGeometry();
    this.syncMeshes(useEditorStore.getState());
    this.requestRender();
  });
  private levelGroups = new Map<number, THREE.Group>();
  private levelMeshes = new Map<number, THREE.Mesh[]>();
  private chunkGeometry = new Map<string, EditorChunk>();
  private chunksByLevel = new Map<number, Set<string>>();
  private chunksToBuild = new Set<string>();
  private levelsToMerge = new Set<number>();
  /** A chunk that drew nothing is not built again until an edit gives it a new identity. */
  private emptyChunks = new WeakSet<ChunkCells>();
  private meshedWindow: MeshWindow | null = null;
  private levelTarget: THREE.WebGLRenderTarget | null = null;
  private compositeScene: THREE.Scene;
  private compositeCamera: THREE.Camera;
  private compositeMaterial: THREE.ShaderMaterial;
  private palettePass: PalettePass;
  private drawBufferSize = new THREE.Vector2();
  private animated: AnimatedInstance[] = [];
  private animatedByKey = new Map<string, AnimatedInstance[]>();
  private animClock = 0;
  private animUniformsByZ = new Map<number, LevelAnimUniforms>();
  private animTablesByZ = new Map<number, AnimationTable>();
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
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: PinchGesture | null = null;
  private zoomDebt = 0;
  private disposed = false;
  private magentaTex: THREE.DataTexture;
  private whiteTex: THREE.DataTexture;
  private lights: LevelLights;
  private lighting = new ChunkedLighting({});
  private lightingTilesById: Record<string, TileDef> | null = null;
  private lightedMap: MapFile | null = null;
  private shownLightGrid: PackedLightGrid | null = null;
  private readonly depthUniforms = depthOriginUniforms();
  private lightingKey = "";
  private lightingTimer: ReturnType<typeof setTimeout> | null = null;
  private lightingEnabled = true;
  private rebuildKey = "";
  private gridLevel = Number.NaN;
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
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = false;
    this.camera = new THREE.OrthographicCamera(0, 1, 0, 1, -10, 50);
    this.camera.position.z = 25;

    this.world = new THREE.Group();
    this.grid = new THREE.Group();
    this.overlays = new THREE.Group();
    this.scene.add(this.world);
    this.scene.add(this.grid);
    this.scene.add(this.overlays);

    this.compositeMaterial = createLevelFadeCompositeMaterial();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMaterial);
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
    this.lights = new LevelLights(this.whiteTex);

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
    for (const { tileset } of this.humans.ready()) this.tilesetById.set(tileset.id, tileset);
    if (tilesById) this.tilesById = this.humans.dress(tilesById);
    this.assetsReady = false;
    void this.preloadTextures()
      .then(() => {
        if (this.disposed) return;
        this.tilesById = this.humans.dress(useEditorStore.getState().tilesById);
        this.discardGeometry();
        this.syncMeshes(useEditorStore.getState());
        this.assetsReady = true;
        this.requestRender();
      })
      .catch((err) => {
        console.error("Failed to load tileset textures", err);
      });
  }

  isReady(): boolean {
    return (
      !this.disposed && this.assetsReady && this.prevMap !== null && this.chunksToBuild.size === 0
    );
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
      meshedQuads: this.countMeshedQuads(),
      meshedChunks: this.chunkGeometry.size,
      showOtherLevels: s.showOtherLevels,
      currentLevel: s.currentLevel,
      previewMode: s.previewMode,
    };
  }

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
      meshedQuads: this.countMeshedQuads(),
      meshedChunks: this.chunkGeometry.size,
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

  private countMeshedQuads(): number {
    let n = 0;
    for (const entry of this.chunkGeometry.values()) n += entry.quads;
    return n;
  }

  dispose() {
    this.disposed = true;
    useEditorStore.getState().endStroke();
    cancelAnimationFrame(this.raf);
    this.unsub?.();
    this.resizeObserver?.disconnect();
    this.statsEl?.remove();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("pointerleave", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    for (const type of SAFARI_GESTURE_EVENTS) {
      this.canvas.removeEventListener(type, preventDefault);
    }
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.levelTarget?.dispose();
    disposeGroupChildren(this.overlays, this.outlineMaterials);
    this.outlineMaterials.dispose();
    this.palettePass.dispose();
    this.compositeMaterial.dispose();
    this.renderer.dispose();
    this.humans.dispose();
    for (const tex of this.textures.values()) tex.dispose();
    for (const mat of this.materials.values()) mat.dispose();
    this.lights.dispose();
    for (const entry of this.chunkGeometry.values()) {
      for (const geo of entry.merged.values()) geo.dispose();
    }
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

  getViewportSize(): { width: number; height: number } {
    this.updateCanvasSize();
    return { width: this.canvasW, height: this.canvasH };
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
        const tex = await loader.loadAsync(tilesetUrl(ts));
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

  private ensureLightUniforms(z: number) {
    return this.lights.uniformsFor(z);
  }

  /**
   * Held by reference rather than replaced: a material binds this object once
   * at shader compile time, so a rebuild has to mutate the texture inside it
   * rather than hand out a new object nothing is looking at.
   */
  private ensureAnimUniforms(z: number): LevelAnimUniforms {
    let u = this.animUniformsByZ.get(z);
    if (!u) {
      u = noAnimUniforms(this.whiteTex);
      this.animUniformsByZ.set(z, u);
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
        ...SINGLE_PASS_DOUBLE_SIDE,
      });
      mat.onBeforeCompile = (shader) => {
        injectWorldShader(
          shader,
          lightUniforms,
          noTintUniforms(),
          noCutUniforms(this.whiteTex),
          this.ensureAnimUniforms(z),
          this.depthUniforms,
        );
      };
      mat.customProgramCacheKey = () => WORLD_SHADER_CACHE_KEY;
      mat.userData.lightUniforms = lightUniforms;
      mat.alphaTest = 0.5;
      mat.transparent = true;
      mat.opacity = 1;
      mat.depthTest = true;
      mat.depthWrite = true;
      this.materials.set(key, mat);
    }
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
   * Bakes only the light chunks the window over the camera reaches, through
   * the play renderer's cache, so a pan bakes the chunks it uncovers and an
   * edit rebakes the chunks it can light or shade.
   */
  private updateLighting(force = false) {
    if (this.disposed) return;
    const s = useEditorStore.getState();
    if (!s.lighting.enabled) return;
    const key = this.lightingFingerprint(s);
    if (!force && key === this.lightingKey) return;
    this.lightingKey = key;

    if (s.tilesById !== this.lightingTilesById) {
      this.lighting = new ChunkedLighting(s.tilesById);
      this.lightingTilesById = s.tilesById;
      this.lightedMap = null;
    }
    this.lighting.syncTo(this.lightedMap, s.map);
    this.lightedMap = s.map;

    const grid = this.lighting.packedGridFor(s.map, this.lightWindow(s));
    if (grid !== this.shownLightGrid) {
      this.shownLightGrid = grid;
      this.lights.upload(grid);
    }
    this.requestRender();
  }

  /** The sun and the sky are uniforms over the baked spans, so the clock never rebakes. */
  private applyIllumination(s: ReturnType<typeof useEditorStore.getState>) {
    const { ambient, sun, sunArc } = sampleIllumination(s.lighting.minutesOfDay);
    this.lights.setIllumination(ambient, { color: sun, arc: sunArc });
  }

  private syncFromStore(forceRebuild = false) {
    if (this.disposed) return;
    const s = useEditorStore.getState();
    this.tilesById = this.humans.dress(s.tilesById);
    this.applyCamera(s.camera.x, s.camera.y, s.zoom);
    if (this.gridLevel !== s.currentLevel) {
      this.drawGrid(s.currentLevel);
      this.gridLevel = s.currentLevel;
    }
    this.drawOverlays(s);
    const key = `${Object.keys(s.tilesById).length}`;
    if (forceRebuild || key !== this.rebuildKey) {
      this.rebuildKey = key;
      this.discardGeometry();
    }
    this.syncMeshes(s);
    this.applyLightingEnabled(s.lighting.enabled);
    if (s.lighting.enabled) {
      this.applyIllumination(s);
      this.maybeScheduleLighting();
    }
    this.requestRender();
  }

  private applyLightingEnabled(enabled: boolean) {
    if (enabled === this.lightingEnabled) return;
    this.lightingEnabled = enabled;
    this.lights.setEnabled(enabled);
    if (!enabled && this.lightingTimer) {
      clearTimeout(this.lightingTimer);
      this.lightingTimer = null;
    }
    if (enabled) this.lightingKey = "";
  }

  private lightingFingerprint(s: ReturnType<typeof useEditorStore.getState>) {
    const w = this.lightWindow(s);
    const span = [w.x0, w.y0, w.x1, w.y1].map((v) => Math.floor(v / LIGHT_CHUNK_SIZE)).join(",");
    return `${s.mapVersion}|${span}|${w.levels.z0},${w.levels.z1}`;
  }

  private maybeScheduleLighting() {
    const s = useEditorStore.getState();
    if (
      this.lightingFingerprint(s) === this.lightingKey &&
      s.tilesById === this.lightingTilesById
    ) {
      return;
    }
    this.scheduleLightingUpdate();
  }

  private cameraRect(s: ReturnType<typeof useEditorStore.getState>): WorldRect {
    const w = this.canvasW / s.zoom;
    const h = this.canvasH / s.zoom;
    return {
      x0: Math.floor(s.camera.x / CELL_SIZE),
      y0: Math.floor(s.camera.y / CELL_SIZE),
      x1: Math.floor((s.camera.x + w) / CELL_SIZE),
      y1: Math.floor((s.camera.y + h) / CELL_SIZE),
    };
  }

  private meshWindow(s: ReturnType<typeof useEditorStore.getState>): MeshWindow {
    return {
      ...this.cameraRect(s),
      levels: drawnLevelRange(s.currentLevel, s.showOtherLevels, s.previewMode),
    };
  }

  /** The union of the drawn levels' own rects, lit across {@link lightLevels}. */
  private lightWindow(s: ReturnType<typeof useEditorStore.getState>): LightWindow {
    const base = this.cameraRect(s);
    const drawn = drawnLevelRange(s.currentLevel, s.showOtherLevels, s.previewMode);
    return {
      x0: base.x0 + drawn.z0 - LIGHT_WINDOW_MARGIN,
      y0: base.y0 + drawn.z0 - LIGHT_WINDOW_MARGIN,
      x1: base.x1 + drawn.z1 + LIGHT_WINDOW_MARGIN,
      y1: base.y1 + drawn.z1 + LIGHT_WINDOW_MARGIN,
      levels: lightLevels(s.currentLevel),
    };
  }

  private applyCamera(camX: number, camY: number, zoom: number) {
    this.updateCanvasSize();
    const viewW = this.canvasW / zoom;
    const viewH = this.canvasH / zoom;
    const level = useEditorStore.getState().currentLevel;
    setDepthOrigin(this.depthUniforms, depthOriginAt(camX + viewW / 2, camY + viewH / 2, level));
    this.camera.left = camX;
    this.camera.right = camX + viewW;
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
    geo.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
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

  private overlaySignature(s: ReturnType<typeof useEditorStore.getState>): string {
    const h = s.hover;
    const sel = s.selected;
    const sp = s.shapePreview;
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
      s.proceduralSettingsVersion,
      s.weatherAreasVersion,
      s.selectedWeatherArea ?? "",
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
    const appendMode = !s.selected;
    let brush: PlacedTile[] = [];
    if (s.selected) {
      brush = getStack(s.map, s.selected.x, s.selected.y, z);
    } else if (s.armedTileId) {
      const def = s.tilesById[s.armedTileId];
      if (def) {
        brush = isDirectional(def) ? [{ tileId: def.id, direction: "s" }] : [{ tileId: def.id }];
      }
    }

    if (s.hover && !(s.selected && s.hover.x === s.selected.x && s.hover.y === s.selected.y)) {
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
        elev = footElevation(elev, placed);
        const def = s.tilesById[placed.tileId];
        const quad = def ? this.spriteQuad(placed, def, x, y, z, elev, s.map) : null;

        if (!def || !quad) {
          const origin = baseCellWorldOrigin(x, y, z, elev);
          addRectOutline(origin.x, origin.y, CELL_SIZE, CELL_SIZE, 0xff66ff, true);
          return;
        }

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

    if (s.tool === "weather") {
      const outlineCells = (
        rect: { x0: number; y0: number; x1: number; y1: number },
        color: number,
        heavy: boolean,
      ) => {
        const origin = baseCellWorldOrigin(
          Math.min(rect.x0, rect.x1),
          Math.min(rect.y0, rect.y1),
          z,
          0,
        );
        addRectOutline(
          origin.x,
          origin.y,
          (Math.abs(rect.x1 - rect.x0) + 1) * CELL_SIZE,
          (Math.abs(rect.y1 - rect.y0) + 1) * CELL_SIZE,
          color,
          heavy,
        );
      };
      s.weatherAreas.forEach((area, index) => {
        const selected = index === s.selectedWeatherArea;
        outlineCells(area, selected ? WEATHER_AREA_SELECTED : weatherAreaColor(area), selected);
      });
      if (s.shapePreview?.kind === "weather")
        outlineCells(s.shapePreview, WEATHER_AREA_SELECTED, true);
    }

    if (s.shapePreview?.kind === "procedural") {
      const { x0, y0, x1, y1 } = s.shapePreview;
      const plan = planProcedural(
        s.map,
        s.tilesById,
        { x0, y0, x1, y1 },
        z,
        activeConfig(s.proceduralSettings),
      );
      const minX = Math.min(x0, x1);
      const minY = Math.min(y0, y1);
      const origin = baseCellWorldOrigin(minX, minY, z, 0);
      addRectOutline(
        origin.x,
        origin.y,
        (Math.abs(x1 - x0) + 1) * CELL_SIZE,
        (Math.abs(y1 - y0) + 1) * CELL_SIZE,
        plan.ok ? 0x2d6a4f : 0xff4d4d,
        true,
      );

      if (plan.ok && plan.edits.length <= MAX_GENERATOR_GHOST_CELLS) {
        const built = setStacks(s.map, plan.edits);
        for (const edit of plan.edits) {
          const already = getStack(s.map, edit.x, edit.y, edit.z).length;
          let elev = 0;
          edit.stack.forEach((placed, stackIndex) => {
            elev = footElevation(elev, placed);
            const def = s.tilesById[placed.tileId];
            if (!def) return;
            if (stackIndex >= already) {
              const quad = this.spriteQuad(placed, def, edit.x, edit.y, edit.z, elev, built);
              if (quad) {
                addSprite(quad, {
                  color: 0xffffff,
                  opacity: GHOST_OPACITY,
                  blending: THREE.NormalBlending,
                  renderOrder: drawOrder(
                    edit.x,
                    edit.y,
                    absoluteElevation(edit.z, elev),
                    stackIndex,
                  ),
                });
              }
            }
            elev += terrainHeight(placed, s.tilesById);
          });
        }
      }
    }

    const targets = this.brushTargets(s);
    const showGhosts = brush.length > 0 && targets.length <= MAX_GHOST_CELLS;
    for (const c of targets) {
      if (s.shapePreview) {
        const origin = baseCellWorldOrigin(c.x, c.y, z, 0);
        addRectOutline(origin.x, origin.y, CELL_SIZE, CELL_SIZE, 0x2d6a4f);
      }
      if (s.selected && c.x === s.selected.x && c.y === s.selected.y) continue;
      if (!showGhosts) continue;

      if (appendMode) {
        const def = s.tilesById[brush[0]!.tileId];
        if (!def) continue;
        if (!canPlace(s.map, c.x, c.y, z, def, s.tilesById, brush[0]!.direction).ok) {
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
        elev = footElevation(elev, placed);
        const def = s.tilesById[placed.tileId];
        if (!def) return;
        const quad = this.spriteQuad(placed, def, c.x, c.y, z, elev, s.map);
        if (quad) {
          addSprite(quad, {
            color: 0xffffff,
            opacity: GHOST_OPACITY,
            blending: THREE.NormalBlending,
            renderOrder: drawOrder(c.x, c.y, absoluteElevation(z, elev), stackIndex),
          });
        }
        elev += terrainHeight(placed, s.tilesById);
      });
    }

    this.overlays.updateMatrixWorld(true);
  }

  private brushTargets(
    s: ReturnType<typeof useEditorStore.getState>,
  ): Array<{ x: number; y: number }> {
    if (s.shapePreview) {
      const { kind, x0, y0, x1, y1 } = s.shapePreview;
      if (kind === "procedural" || kind === "weather") return [];
      return kind === "rect" ? this.rectList(x0, y0, x1, y1) : this.circleList(x0, y0, x1, y1);
    }
    const paints =
      s.tool === "pencil" || s.tool === "rect" || s.tool === "circle" || s.tool === "bucket";
    if (paints && s.hover) return [s.hover];
    return [];
  }

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
    return spriteQuadFor(this.quadAssets(), map, { x, y, z, elevation }, placed, def);
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
    for (const entry of this.chunkGeometry.values()) {
      for (const inst of entry.animated) this.animated.push(inst);
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

  private ensureLevelGroup(z: number): THREE.Group {
    let group = this.levelGroups.get(z);
    if (!group) {
      group = new THREE.Group();
      group.name = `level:${z}`;
      group.matrixAutoUpdate = false;
      group.updateMatrix();
      this.world.add(group);
      this.levelGroups.set(z, group);
    }
    return group;
  }

  private ensureAnimTable(z: number): AnimationTable {
    let table = this.animTablesByZ.get(z);
    if (!table) {
      table = new AnimationTable();
      this.animTablesByZ.set(z, table);
    }
    return table;
  }

  /**
   * A level's table only grows while its chunks come and go, so a row a
   * merged quad was built against stays where it was.
   */
  private publishAnimTable(z: number) {
    const table = this.animTablesByZ.get(z);
    const u = this.ensureAnimUniforms(z);
    if (!table || table.empty) {
      u.uAnimEnabled.value = 0;
      return;
    }
    u.uAnimTable.value = table.bake();
    u.uAnimSize.value.set(table.width, table.height);
    u.uAnimClockMs.value = this.animClock;
    u.uAnimEnabled.value = 1;
  }

  private discardGeometry() {
    while (this.world.children.length) {
      const g = this.world.children.pop()!;
      disposeObject3D(g);
    }
    for (const entry of this.chunkGeometry.values()) {
      for (const geo of entry.merged.values()) geo.dispose();
    }
    this.levelGroups.clear();
    this.levelMeshes.clear();
    this.chunkGeometry.clear();
    this.chunksByLevel.clear();
    this.chunksToBuild.clear();
    this.levelsToMerge.clear();
    this.emptyChunks = new WeakSet();
    for (const table of this.animTablesByZ.values()) table.dispose();
    this.animTablesByZ.clear();
    for (const u of this.animUniformsByZ.values()) u.uAnimEnabled.value = 0;
    this.animated = [];
    this.animatedByKey.clear();
    this.meshedWindow = null;
    this.prevMap = null;
  }

  private syncMeshes(s: ReturnType<typeof useEditorStore.getState>) {
    const window = this.meshWindow(s);
    if (s.map === this.prevMap && sameWindow(this.meshedWindow, window)) return;
    this.syncChunks(s.map, window);
  }

  private syncChunks(next: MapFile, window: MeshWindow) {
    const prev = this.prevMap;
    const wanted = visibleChunkKeys(next, window);
    /**
     * The queue spreads a pan's margin over frames that are already showing
     * the view. After a load or a jump nothing in the view is built yet, so
     * every frame spent queueing is a frame of empty canvas.
     */
    const needed =
      this.chunkGeometry.size > 0 && overlaps(this.meshedWindow, window)
        ? visibleChunkKeys(next, window, MESH_BUILD_NOW_MARGIN)
        : wanted;
    const dirty = prev ? this.dirtyChunks(prev, next, wanted, window.levels) : new Set<string>();

    for (const key of [...this.chunkGeometry.keys()]) {
      if (!wanted.has(key)) this.dropChunk(key);
    }
    for (const key of this.chunksToBuild) if (!wanted.has(key)) this.chunksToBuild.delete(key);

    for (const key of wanted) {
      const { z, chunk } = parseChunkAddress(key);
      if (this.chunkGeometry.has(key)) {
        if (!dirty.has(key)) continue;
        this.dropChunk(key);
        this.buildChunk(next, z, chunk);
        continue;
      }
      const cells = getChunk(next, z, chunk);
      if (cells && this.emptyChunks.has(cells)) continue;
      if (!needed.has(key)) {
        this.chunksToBuild.add(key);
        continue;
      }
      this.chunksToBuild.delete(key);
      this.buildChunk(next, z, chunk);
    }

    this.prevMap = next;
    this.meshedWindow = window;
    this.finishMeshChanges();
  }

  private buildQueuedChunks(s: ReturnType<typeof useEditorStore.getState>) {
    const map = this.prevMap;
    if (this.chunksToBuild.size === 0 || !map) return;
    buildQueuedNearestFirst(this.chunksToBuild, this.cameraRect(s), (key, z, chunk) => {
      if (!this.chunkGeometry.has(key)) this.buildChunk(map, z, chunk);
    });
    this.finishMeshChanges();
  }

  private finishMeshChanges() {
    if (this.levelsToMerge.size === 0) return;
    for (const z of this.levelsToMerge) this.mergeLevel(z);
    this.levelsToMerge.clear();
    this.rebuildAnimatedIndex();
    this.world.updateMatrixWorld(true);
    this.overlaySig = "";
    this.requestRender();
  }

  /**
   * An edit can restyle the eight cells around it, which may be in the chunk
   * next door, so a changed cell marks every chunk its ring reaches.
   */
  private dirtyChunks(
    prev: MapFile,
    next: MapFile,
    wanted: ReadonlySet<string>,
    levels: LevelRange,
  ): Set<string> {
    const dirty = new Set<string>();
    if (prev === next) return dirty;
    for (let z = levels.z0; z <= levels.z1; z++) {
      if (prev.levels[levelKey(z)] === next.levels[levelKey(z)]) continue;
      for (const cell of changedCellsOnLevel(prev, next, z)) {
        const { x, y } = parseCoordKey(cell);
        const cx0 = Math.floor((x - 1) / CHUNK_SIZE);
        const cx1 = Math.floor((x + 1) / CHUNK_SIZE);
        const cy0 = Math.floor((y - 1) / CHUNK_SIZE);
        const cy1 = Math.floor((y + 1) / CHUNK_SIZE);
        for (let cx = cx0; cx <= cx1; cx++) {
          for (let cy = cy0; cy <= cy1; cy++) {
            const key = chunkAddressKey(z, chunkKeyAt(cx, cy));
            if (wanted.has(key)) dirty.add(key);
          }
        }
      }
    }
    return dirty;
  }

  private dropChunk(key: string) {
    const entry = this.chunkGeometry.get(key);
    if (!entry) return;
    for (const geo of entry.merged.values()) geo.dispose();
    if (entry.separates) {
      entry.separates.parent?.remove(entry.separates);
      disposeObject3D(entry.separates);
    }
    this.chunkGeometry.delete(key);
    this.chunksByLevel.get(entry.z)?.delete(key);
    this.levelsToMerge.add(entry.z);
  }

  private mergeLevel(z: number) {
    const group = this.levelGroups.get(z);
    for (const mesh of this.levelMeshes.get(z) ?? []) {
      mesh.parent?.remove(mesh);
      mesh.geometry.dispose();
    }
    this.levelMeshes.delete(z);

    const chunks = this.chunksByLevel.get(z);
    if (!chunks || chunks.size === 0) {
      this.chunksByLevel.delete(z);
      if (group) {
        group.parent?.remove(group);
        disposeObject3D(group);
        this.levelGroups.delete(z);
      }
      return;
    }

    const byTex = new Map<THREE.Texture, THREE.BufferGeometry[]>();
    for (const key of chunks) {
      for (const [tex, geo] of this.chunkGeometry.get(key)!.merged) {
        const list = byTex.get(tex);
        if (list) list.push(geo);
        else byTex.set(tex, [geo]);
      }
    }
    const levelGroup = this.ensureLevelGroup(z);
    const meshes: THREE.Mesh[] = [];
    for (const [tex, geos] of byTex) {
      const mesh = new THREE.Mesh(concatQuadGeometries(geos), this.materialFor(tex, z));
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      levelGroup.add(mesh);
      meshes.push(mesh);
    }
    this.levelMeshes.set(z, meshes);
  }

  private buildChunk(map: MapFile, z: number, chunk: string) {
    const cells = getChunk(map, z, chunk);
    if (!cells) return;

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
    const animTable = this.ensureAnimTable(z);

    for (const cellKey in cells) {
      const cell = { ...parseCoordKey(cellKey), stack: cells[cellKey]! };
      let elev = 0;
      const extents = clumpExtents(cell.stack, this.tilesById);
      cell.stack.forEach((placed, stackIndex) => {
        elev = footElevation(elev, placed);
        const def = this.tilesById[placed.tileId];
        const foot = absoluteElevation(z, elev);

        if (def && isSpanPart(placed)) {
          elev += terrainHeight(placed, this.tilesById);
          return;
        }

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

        const sprite = resolveTileSprite(def, {
          direction: placed.direction,
          variant: placed.variant,
          map,
          x: cell.x,
          y: cell.y,
          z,
        });
        const frames = sprite?.frames;
        const frameIdx = frames ? frameIndexAtTime(frames, this.animClock) : 0;
        if (!frames?.length) return;

        const tileset = this.tilesetById.get(def.anchor.tilesetId);
        if (!tileset) return;

        /**
         * A quad the table accepts is built at frame 0 and moved by the
         * shader; one it refuses is built at the live frame and moved by
         * `updateAnimations`. The two must not be mixed: the table's offsets
         * are measured from frame 0, so a quad built anywhere else would be
         * shifted by however far the clock had run when the level was built.
         */
        const animRow = animTable.add(frames, tileset);
        const merged = animRow !== NO_ANIMATION;
        const first = merged ? frames[0]! : frames[frameIdx]!;

        const baseOrigin = baseCellWorldOrigin(cell.x, cell.y, z, elev);
        const origin = spriteWorldOrigin(baseOrigin, first.sprite.base);
        const rect = spriteRect(def.anchor, first.sprite);
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
        const animKey = animationKey(def, placed, cell.x, cell.y, z);

        items.push({
          x: origin.x,
          y: origin.y,
          w,
          h,
          u0,
          v0,
          u1,
          v1,
          box: depthBox(
            cell.x,
            cell.y,
            absoluteElevation(z, extents[stackIndex]?.foot ?? elev),
            absoluteElevation(z, extents[stackIndex]?.top ?? elev),
            footprintOf(def, placed.direction),
          ),
          stackBias: depthStackBias(z, stackIndex),
          texture,
          lightX0,
          lightY0,
          lightX1,
          lightY1,
          unlit,
          animRow: merged ? animRow : undefined,
          animPhaseMs: merged && sprite ? cellPhaseMs(sprite, cell.x, cell.y) : undefined,
          anim:
            isAnimated && frames && !merged
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

    if (items.length === 0) {
      this.emptyChunks.add(cells);
      return;
    }

    const entry: EditorChunk = { z, merged: new Map(), separates: null, animated: [], quads: 0 };
    const staticByTex = new Map<THREE.Texture, Quad[]>();

    for (const item of items) {
      if (item.anim) {
        entry.separates ??= new THREE.Group();
        const mesh = this.addQuadMesh(entry.separates, item, item.texture, z);
        entry.animated.push({
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
    for (const [tex, quads] of staticByTex) entry.merged.set(tex, buildMergedQuadGeometry(quads));
    entry.quads = items.length;

    const key = chunkAddressKey(z, chunk);
    this.chunkGeometry.set(key, entry);
    let onLevel = this.chunksByLevel.get(z);
    if (!onLevel) {
      onLevel = new Set();
      this.chunksByLevel.set(z, onLevel);
    }
    onLevel.add(key);
    if (entry.separates) {
      entry.separates.matrixAutoUpdate = false;
      this.ensureLevelGroup(z).add(entry.separates);
    }
    this.levelsToMerge.add(z);
    this.publishAnimTable(z);
  }

  private addQuadMesh(
    parent: THREE.Object3D,
    quad: Quad,
    texture: THREE.Texture,
    z: number,
  ): THREE.Mesh {
    const geo = buildSingleQuadGeometry(quad);
    const mesh = new THREE.Mesh(geo, this.materialFor(texture, z));
    mesh.position.set(quad.x + quad.w / 2, quad.y + quad.h / 2, 0);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    parent.add(mesh);
    return mesh;
  }

  private updateAnimations(dt: number): boolean {
    if (this.animatedByKey.size === 0) return false;

    this.animClock += dt;
    let changed = false;

    for (const [z, u] of this.animUniformsByZ) {
      if (u.uAnimEnabled.value === 0) continue;
      const table = this.animTablesByZ.get(z);
      if (table && table.crossedFrame(u.uAnimClockMs.value, this.animClock)) {
        changed = true;
      }
      u.uAnimClockMs.value = this.animClock;
    }

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

    const state = useEditorStore.getState();
    this.syncMeshes(state);
    this.buildQueuedChunks(state);

    if (this.updateAnimations(dt)) {
      this.overlaySig = "";
      this.drawOverlays(state);
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
    const { x: w, y: h } = this.renderer.getDrawingBufferSize(this.drawBufferSize);
    if (
      this.levelTarget &&
      (!this.levelTarget.depthBuffer || this.levelTarget.texture.type !== THREE.UnsignedByteType)
    ) {
      this.levelTarget.dispose();
      this.levelTarget = null;
    }
    if (!this.levelTarget) {
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

  private backgroundFor(s: ReturnType<typeof useEditorStore.getState>): number {
    if (!s.previewMode || !s.lighting.enabled) return BACKGROUND_COLOR;
    return VOID_BACKGROUND;
  }

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
      const visibility = levelVisibility(z, s.currentLevel, s.showOtherLevels, s.previewMode);
      if (visibility === "hidden") continue;
      (visibility === "solid" ? solid : ghosts).push(group);
    }

    if (solid.length > 0) {
      for (const g of solid) g.visible = true;
      r.setRenderTarget(output);
      r.render(this.scene, this.camera);
      for (const g of solid) g.visible = false;
    }

    const ghostImage = ghosts.length > 0 ? this.renderGhostImage(ghosts) : null;
    this.world.visible = false;

    this.palettePass.blitToCanvas(r);

    if (ghostImage) this.fadeOntoCanvas(ghostImage);

    renderChrome(this.overlays);
  }

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
    return screenToCoord(screenX, screenY, s.zoom, s.camera.x, s.camera.y, s.currentLevel);
  }

  private bindEvents() {
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("pointerleave", this.onPointerUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    for (const type of SAFARI_GESTURE_EVENTS) {
      this.canvas.addEventListener(type, preventDefault, { passive: false });
    }
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
      target instanceof Element && Boolean(target.closest("button, a, [role='button'], select"));

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
      const stack = getStack(store.map, store.selected.x, store.selected.y, store.currentLevel);
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
      KeyA: "weather",
    };
    if (toolMap[e.code]) {
      store.setTool(toolMap[e.code]!);
    }
    if (e.code === "KeyW") {
      store.togglePreviewMode();
    }
    if (e.code === "KeyL") {
      store.toggleLightingEnabled();
    }
    if (e.code === "KeyI") {
      store.toggleShowOtherLevels();
    }
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
    if (e.ctrlKey) {
      this.zoomBy(-Math.sign(e.deltaY) * WHEEL_PINCH_STEP, {
        x: e.clientX,
        y: e.clientY,
      });
      return;
    }
    panCameraByWheel(e, { width: this.canvasW, height: this.canvasH });
  };

  private toLocal(point: { x: number; y: number }): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: point.x - rect.left, y: point.y - rect.top };
  }

  private capturePointer(pointerId: number) {
    try {
      this.canvas.setPointerCapture(pointerId);
    } catch {}
  }

  private releasePointer(pointerId: number) {
    try {
      this.canvas.releasePointerCapture(pointerId);
    } catch {}
  }

  private zoomBy(steps: number, anchor: { x: number; y: number }): ZoomLevel {
    const store = useEditorStore.getState();
    this.zoomDebt += steps;
    const whole = Math.trunc(this.zoomDebt);
    if (whole === 0) return store.zoom;
    this.zoomDebt -= whole;

    const zoom = steppedZoom(store.zoom, whole);
    if (zoom === store.zoom) return zoom;
    store.setCamera(cameraAnchoredAtZoom(store.camera, this.toLocal(anchor), store.zoom, zoom));
    store.setZoom(zoom);
    return zoom;
  }

  private beginPinch() {
    const store = useEditorStore.getState();
    if (this.painting) {
      this.painting = false;
      store.endStroke();
    }
    if (this.shapeAnchor) {
      this.shapeAnchor = null;
      store.setShapePreview(null);
    }
    this.panning = false;
    this.updateCursor();
    store.setHover(null);

    for (const id of this.touches.keys()) this.capturePointer(id);
    this.zoomDebt = 0;
    this.rebasePinch();
  }

  private rebasePinch() {
    const [a, b] = [...this.touches.values()];
    if (!a || !b) {
      this.pinch = null;
      return;
    }
    this.pinch = { mid: midpointOf(a, b), spreadAtZoom: spreadOf(a, b) };
  }

  private applyPinch() {
    const pinch = this.pinch;
    const [a, b] = [...this.touches.values()];
    if (!pinch || !a || !b) return;

    const store = useEditorStore.getState();
    const mid = midpointOf(a, b);
    store.setCamera({
      x: store.camera.x - (mid.x - pinch.mid.x) / store.zoom,
      y: store.camera.y - (mid.y - pinch.mid.y) / store.zoom,
    });
    pinch.mid = mid;

    const spread = spreadOf(a, b);
    const steps = pinchZoomSteps(spread / pinch.spreadAtZoom);
    if (steps === 0) return;
    pinch.spreadAtZoom = spread;
    this.zoomBy(steps, mid);
  }

  private onPointerDown = (e: PointerEvent) => {
    const store = useEditorStore.getState();
    if (e.pointerType === "touch") {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size >= 2) {
        this.beginPinch();
        return;
      }
    }
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

    if (tool === "procedural" || tool === "weather") {
      this.shapeAnchor = coord;
      store.setShapePreview({
        kind: tool,
        x0: coord.x,
        y0: coord.y,
        x1: coord.x,
        y1: coord.y,
      });
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
      const target = getStack(store.map, coord.x, coord.y, store.currentLevel);
      if (store.selected) {
        const source = getStack(store.map, store.selected.x, store.selected.y, store.currentLevel);
        if (stacksEqual(source, target)) return;
      }
      const coords = floodCoords(store.map, coord.x, coord.y, store.currentLevel);
      if (coords.length === 0) {
        if (target.length === 0) {
          useEditorStore.setState({
            lastToast: "Open space — enclose it before filling",
          });
        }
        return;
      }
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

    if (e.pointerType === "touch" && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch) {
        this.applyPinch();
        return;
      }
    }

    if (this.panning) {
      const dx = (e.clientX - this.panLast.x) / store.zoom;
      const dy = (e.clientY - this.panLast.y) / store.zoom;
      this.panLast = { x: e.clientX, y: e.clientY };
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
    if (e.pointerType === "touch") {
      this.touches.delete(e.pointerId);
      this.releasePointer(e.pointerId);
      if (this.pinch) {
        this.rebasePinch();
        return;
      }
    }
    if (this.panning) {
      this.panning = false;
      this.updateCursor();
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {}
      return;
    }

    if (this.painting) {
      this.painting = false;
      store.endStroke();
    }

    if (this.shapeAnchor && store.shapePreview) {
      const { kind, x0, y0, x1, y1 } = store.shapePreview;
      if (kind === "weather") {
        const result = store.addWeatherArea({ x0, y0, x1, y1 });
        if (!result.ok && result.reason) {
          useEditorStore.setState({ lastToast: result.reason });
        }
      } else if (kind === "procedural") {
        const result = store.placeProcedural({ x0, y0, x1, y1 });
        if (!result.ok && result.reason) {
          useEditorStore.setState({ lastToast: result.reason });
        }
      } else {
        const coords =
          kind === "rect" ? this.rectList(x0, y0, x1, y1) : this.circleList(x0, y0, x1, y1);
        const result = store.stampMany(coords);
        if (result.skipped > 0) {
          useEditorStore.setState({
            lastToast: `Skipped ${result.skipped} cell(s)${
              result.reason ? `: ${result.reason}` : ""
            }`,
          });
        }
      }
      store.setShapePreview(null);
      this.shapeAnchor = null;
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {}
    }
  };
}
