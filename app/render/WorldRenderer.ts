import * as THREE from "three";
import {
  absoluteElevation,
  baseCellWorldOrigin,
  type DepthBox,
  depthBox,
  depthStackBias,
  spriteWorldOrigin,
} from "../lib/geometry";
import {
  overlayEmitterOverridesPacked,
  type EmitterOverride,
  type PackedLevelLight,
  type PackedLightGrid,
} from "../lib/lighting";
import { sampleIllumination } from "../lib/clock";
import { getStack, listCoords, stackHeight } from "../lib/mapData";
import type { Frame, MapFile, TileDef, TilesetDef } from "../lib/types";
import {
  CELL_SIZE,
  MAX_LEVEL,
  MIN_LEVEL,
  levelKey,
  physicalHeight,
  tileCanEmitLight,
} from "../lib/types";
import { getFrames } from "../lib/tileResolve";
import { PLAYER_TILE_ID } from "../game/constants";
import { ChunkedLighting, type WorldRect } from "../lib/lightingChunks";
import type { FramePhase, FrameProfiler } from "./frameProfile";
import { GpuLighting } from "./gpuLighting";
import { PalettePass } from "./palettePass";
import {
  type LevelLightUniforms,
  type Quad,
  WORLD_SHADER_CACHE_KEY,
  buildMergedQuadGeometry,
  buildSingleQuadGeometry,
  injectWorldShader,
  writeBoxAttr,
} from "./worldQuads";
import { disposeGroupChildren, makeSpriteOutline } from "./overlayMeshes";
import { type SpriteQuadAssets, spriteQuadFor } from "./spriteQuad";

type AnimatedInstance = {
  mesh: THREE.Mesh;
  frames: Frame[];
  tileset: TilesetDef;
  animKey: string;
};

const DEFAULT_BACKGROUND = sampleIllumination(12 * 60).background;
const LIGHT_MAP_CELL_OFFSET = 0.5;

/** Map cell + stack slot identifying a placed tile instance. */
export type TileInstanceKey = {
  x: number;
  y: number;
  z: number;
  stackIndex: number;
};

/**
 * Where a moving tile's solid volume is right now, in fractional cells and
 * absolute height units. A tile mid-step straddles two cells, so its box has
 * to travel with the sprite rather than snap between the cells it occupies.
 */
export type MotionBox = {
  x: number;
  y: number;
  foot: number;
  top: number;
  /** Separates the mover from whatever floor plane its feet are resting on. */
  stackBias: number;
};

/**
 * Per-frame motion for a placed tile (walk/fall lerp, push, etc.).
 * Not player-specific — any tile can move.
 */
export type TileMotion = TileInstanceKey & {
  ox: number;
  oy: number;
  box: MotionBox;
  /**
   * Also draw under this level while moving. Used when descending so the
   * mover stays visible after roof-cut hides the origin level group.
   */
  alsoDrawAtZ?: number;
};

export type WorldView = {
  map: MapFile;
  tilesById: Record<string, TileDef>;
  camera: { x: number; y: number };
  zoom: number;
  /** Minutes past midnight — drives ambient + clear colour. */
  minutesOfDay: number;
  /** Active lerps; each carries the depth box its sprite currently occupies. */
  tileMotions?: TileMotion[];
  /**
   * Fractional cell-space emit positions for tiles mid-walk/fall so cast
   * light tracks sprite motion. Logical `x,y,z` must match the map cell.
   */
  emitterOverrides?: EmitterOverride[];
  /**
   * When set, hide every level group with z strictly above this value
   * (player roof-cut). Omit to show all levels (editor / preview).
   */
  hideLevelsAbove?: number;
};

/** Silhouette outline around one placed tile, drawn over the finished frame. */
export type ObjectOutlineOverlay = TileInstanceKey & {
  kind: "objectOutline";
  color: number;
};

export type OverlaySpec = ObjectOutlineOverlay;

function overlaySpecKey(spec: OverlaySpec): string {
  return `o:${spec.x},${spec.y},${spec.z},${spec.stackIndex}:${spec.color}`;
}

/** Stable cache key for fractional emitter overrides (~0.01 cell). */
function emitterOverridesKey(
  overrides: EmitterOverride[] | undefined,
): string {
  if (!overrides?.length) return "";
  return overrides
    .map(
      (o) =>
        `${o.x},${o.y},${o.z}:${o.fx.toFixed(2)},${o.fy.toFixed(2)},${o.fz.toFixed(2)}`,
    )
    .join("|");
}

const DYNAMIC_LIGHT_TILE_IDS = new Set([PLAYER_TILE_ID]);

/**
 * Slack cells around the camera's reach, for sprite overhang the strict cell
 * rect misses. Deliberately small: the apron that makes edge light *correct* is
 * applied inside the bake, and chunk alignment already keeps a nudging camera
 * from refilling, so widening this only bakes cells nobody looks at.
 */
const LIGHT_WINDOW_MARGIN = 4;

function disposeObject3D(obj: THREE.Object3D) {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
    }
  });
}

/**
 * Shared map world draw — preview-style (all levels opaque, no editor chrome).
 * Driven imperatively; no editor store.
 */
export class WorldRenderer {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private world: THREE.Group;
  private overlayScene: THREE.Scene;
  private overlays: THREE.Group;
  /** null forces a rebuild; "" is the valid signature of an empty overlay set. */
  private overlaySig: string | null = null;
  private textures = new Map<string, THREE.Texture>();
  private materials = new Map<string, THREE.MeshBasicMaterial>();
  private tilesets: TilesetDef[] = [];
  private tilesetById = new Map<string, TilesetDef>();
  private tilesById: Record<string, TileDef> = {};
  private levelGroups = new Map<number, THREE.Group>();
  private animatedByLevel = new Map<number, AnimatedInstance[]>();
  private animated: AnimatedInstance[] = [];
  private animatedByKey = new Map<string, AnimatedInstance[]>();
  /** Separate meshes that can receive {@link TileMotion} offsets (anim or in-motion). */
  private movableMeshes = new Map<string, THREE.Mesh>();
  private movableBasePos = new Map<string, { x: number; y: number }>();
  private movableBaseBox = new Map<
    string,
    { box: DepthBox; stackBias: number }
  >();
  /**
   * Extra draw of a descending mover under {@link TileMotion.alsoDrawAtZ}.
   * Geometry is cloned (not shared) so level dispose cannot free the source.
   */
  private motionGhosts = new Map<string, THREE.Mesh>();
  /** Instance keys that must stay unmerged this build (active motions). */
  private motionKeys = new Set<string>();
  /** Last roof-cut ceiling — empty level groups created mid-frame need it. */
  private hideLevelsAbove: number | undefined;
  private animClock = 0;
  private lastAnimTime = 0;
  private frameIndices = new Map<string, number>();
  private disposed = false;
  private magentaTex: THREE.DataTexture;
  private whiteTex: THREE.DataTexture;
  private lightTextures = new Map<number, THREE.DataTexture>();
  private lightUniformsByZ = new Map<number, LevelLightUniforms>();
  private lightingKey = "";
  private staticLightGrid: PackedLightGrid | null = null;
  /** Latest tint, so a level whose uniforms appear later still gets it. */
  private pendingAmbient: [number, number, number] | null = null;
  private gpuLighting = new GpuLighting();
  private lighting = new ChunkedLighting({}, DYNAMIC_LIGHT_TILE_IDS);
  /** Tile defs the light cache was built against; new defs void every chunk. */
  private lightingTilesById: Record<string, TileDef> | null = null;
  private prevMap: MapFile | null = null;
  private needsRender = true;
  private canvasW = 0;
  private canvasH = 0;
  private resizeObserver: ResizeObserver | null = null;
  private assetsReady = false;
  private view: WorldView | null = null;
  private looping = false;
  private raf = 0;
  private palettePass = new PalettePass();
  private profiler: FrameProfiler | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
    });
    this.renderer.setClearColor(DEFAULT_BACKGROUND, 1);
    this.renderer.setPixelRatio(1);
    this.renderer.autoClear = true;

    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = false;
    this.camera = new THREE.OrthographicCamera(0, 1, 0, 1, -10, 50);
    this.camera.position.z = 25;

    this.world = new THREE.Group();
    this.scene.add(this.world);

    // Chrome lives in its own scene so it can be drawn after the palette
    // quantise, keeping outline colours exact instead of snapped to the ramp.
    this.overlayScene = new THREE.Scene();
    this.overlayScene.matrixWorldAutoUpdate = false;
    this.overlays = new THREE.Group();
    this.overlayScene.add(this.overlays);

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

    this.bindResize();
  }

  setAssets(tilesets: TilesetDef[], tilesById?: Record<string, TileDef>) {
    this.tilesets = tilesets;
    this.tilesetById = new Map(tilesets.map((t) => [t.id, t]));
    if (tilesById) this.tilesById = tilesById;
    this.assetsReady = false;
    void this.preloadTextures().then(() => {
      if (this.disposed) return;
      this.prevMap = null;
      // Force light re-upload after rebuild — materials may be new, and
      // the first setView can race textures still loading.
      this.lightingKey = "";
      this.staticLightGrid = null;
      if (this.view) {
        this.applyMap(this.view.map, true);
        this.updateLighting(this.view);
      }
      this.assetsReady = true;
      this.needsRender = true;
    });
  }

  /** Attach a profiler to break {@link setView} down by phase. Null to stop. */
  setProfiler(profiler: FrameProfiler | null) {
    this.profiler = profiler;
  }

  private time<T>(phase: FramePhase, fn: () => T): T {
    return this.profiler ? this.profiler.measure(phase, fn) : fn();
  }

  setView(view: WorldView) {
    this.view = view;
    this.tilesById = view.tilesById;
    this.applyCamera(view.camera.x, view.camera.y, view.zoom);

    const nextMotionKeys = new Set(
      (view.tileMotions ?? []).map((m) => this.tileKey(m)),
    );
    // Non-animated tiles only get a separate mesh while moving — rebuild when
    // the motion set changes so they can be peeled out of / merged back into batches.
    const motionSetChanged =
      nextMotionKeys.size !== this.motionKeys.size ||
      [...nextMotionKeys].some((k) => !this.motionKeys.has(k));
    this.motionKeys = nextMotionKeys;

    // Before applyMap, which advances prevMap — the light cache needs to see
    // both versions to work out which chunks the edit reached.
    this.time("sync", () => this.lighting.syncTo(this.prevMap, view.map));

    this.time("map", () => {
      this.applyMap(view.map, motionSetChanged);
      this.applyLevelVisibility(view.hideLevelsAbove);
    });
    this.time("light", () => this.updateLighting(view));
    this.time("motion", () => this.applyTileMotions(view.tileMotions));
    this.needsRender = true;
  }

  /** Asset handles the shared sprite-quad builder needs. */
  quadAssets(): SpriteQuadAssets {
    return {
      tilesetById: this.tilesetById,
      textures: this.textures,
      fallbackTexture: this.magentaTex,
      frameIndices: this.frameIndices,
    };
  }

  /**
   * Replace the chrome layer. Rebuilding allocates throwaway meshes, so a
   * signature gates it — this is called every frame from the play loop.
   */
  setOverlays(specs: OverlaySpec[]) {
    const sig = specs.map(overlaySpecKey).join("|");
    if (sig === this.overlaySig) return;
    this.overlaySig = sig;

    disposeGroupChildren(this.overlays);
    for (const spec of specs) this.addOverlay(spec);
    // Scene has matrixWorldAutoUpdate=false — without this the meshes keep an
    // identity matrixWorld and all draw at the world origin.
    this.overlays.updateMatrixWorld(true);
    this.needsRender = true;
  }

  /** The placed tile an overlay refers to, plus the elevation it is drawn at. */
  private overlaySubject(key: TileInstanceKey) {
    const map = this.view?.map;
    if (!map) return null;
    const stack = getStack(map, key.x, key.y, key.z);
    const placed = stack[key.stackIndex];
    const def = placed && this.tilesById[placed.tileId];
    if (!placed || !def) return null;
    return {
      map,
      placed,
      def,
      elevation: stackHeight(stack.slice(0, key.stackIndex), this.tilesById),
    };
  }

  private addOverlay(spec: OverlaySpec) {
    const subject = this.overlaySubject(spec);
    if (!subject) return;
    const quad = spriteQuadFor(
      this.quadAssets(),
      subject.map,
      { x: spec.x, y: spec.y, z: spec.z, elevation: subject.elevation },
      subject.placed,
      subject.def,
    );
    if (quad) this.overlays.add(makeSpriteOutline(quad, spec.color));
  }

  /** Toggle whole level groups; no mesh rebuild. */
  private applyLevelVisibility(hideLevelsAbove?: number) {
    this.hideLevelsAbove = hideLevelsAbove;
    for (const [z, group] of this.levelGroups) {
      group.visible =
        hideLevelsAbove === undefined || z <= hideLevelsAbove;
    }
  }

  /** Advance sprite animations; call from the host rAF loop. */
  tick(dt: number) {
    if (!this.updateAnimations(dt)) return;
    this.needsRender = true;
    // Outline quads are cut from the frame on screen, so a frame flip has to
    // rebuild them even though the overlay spec itself has not changed.
    this.overlaySig = null;
  }

  start() {
    if (this.looping || this.disposed) return;
    this.looping = true;
    this.lastAnimTime = performance.now();
    const loop = () => {
      if (!this.looping || this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(100, now - this.lastAnimTime);
      this.lastAnimTime = now;
      this.tick(dt);
      if (!this.needsRender) return;
      this.needsRender = false;
      this.renderOnce();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.looping = false;
    cancelAnimationFrame(this.raf);
  }

  renderOnce() {
    if (this.disposed) return;
    this.updateCanvasSize();
    if (this.view) {
      this.applyCamera(this.view.camera.x, this.view.camera.y, this.view.zoom);
    }
    const bg = sampleIllumination(this.view?.minutesOfDay ?? 12 * 60).background;
    const r = this.renderer;

    // PROTOTYPE — always palettise play frames.
    const target = this.palettePass.sceneTarget(r);
    r.setRenderTarget(target);
    r.setClearColor(bg, 1);
    r.clear();
    r.render(this.scene, this.camera);
    this.palettePass.blitToCanvas(r);

    // Quantise before chrome so hover outlines and target squares keep their
    // exact colour instead of snapping to the nearest palette entry.
    if (this.overlays.children.length > 0) {
      r.autoClear = false;
      r.render(this.overlayScene, this.camera);
      r.autoClear = true;
    }
  }

  isReady(): boolean {
    return !this.disposed && this.assetsReady && this.prevMap !== null;
  }

  getCameraSize(): { canvasW: number; canvasH: number } {
    // Measured here rather than trusted from the last frame — pointer picking
    // asks for this between frames, and before the first one.
    this.updateCanvasSize();
    return { canvasW: this.canvasW, canvasH: this.canvasH };
  }

  dispose() {
    this.disposed = true;
    this.stop();
    this.resizeObserver?.disconnect();
    this.palettePass.dispose();
    disposeGroupChildren(this.overlays);
    this.renderer.dispose();
    for (const tex of this.textures.values()) tex.dispose();
    for (const mat of this.materials.values()) mat.dispose();
    for (const tex of this.lightTextures.values()) tex.dispose();
    this.magentaTex.dispose();
    this.whiteTex.dispose();
  }

  private tileKey(k: TileInstanceKey): string {
    return `${k.z}:${k.x},${k.y}:${k.stackIndex}`;
  }

  private applyTileMotions(motions: TileMotion[] | undefined) {
    const byKey = new Map<string, TileMotion>();
    for (const m of motions ?? []) byKey.set(this.tileKey(m), m);

    const activeGhosts = new Set<string>();

    for (const [key, mesh] of this.movableMeshes) {
      const base = this.movableBasePos.get(key);
      const baseBox = this.movableBaseBox.get(key);
      if (!base || !baseBox) continue;

      // Sprite offset and depth box come from the same motion, so what is drawn
      // and where it sorts can never disagree for a frame.
      const motion = byKey.get(key);
      mesh.position.x = base.x + (motion?.ox ?? 0);
      mesh.position.y = base.y + (motion?.oy ?? 0);
      writeBoxAttr(
        mesh.geometry,
        motion
          ? depthBox(motion.box.x, motion.box.y, motion.box.foot, motion.box.top)
          : baseBox.box,
        motion ? motion.box.stackBias : baseBox.stackBias,
      );
      // Scene has matrixWorldAutoUpdate=false — must push local → world or the
      // mesh never moves on screen despite position changing.
      mesh.updateMatrix();
      mesh.updateMatrixWorld(true);

      // Descending movers: also draw under the destination level so roof-cut can
      // hide the origin group without the sprite vanishing mid-lerp. Hide the
      // origin mesh while the dest copy is up so we never double-draw.
      if (motion?.alsoDrawAtZ != null) {
        activeGhosts.add(key);
        const ghost = this.ensureMotionGhost(key, mesh, motion.alsoDrawAtZ);
        this.syncMotionGhost(ghost, mesh);
        ghost.visible = true;
        mesh.visible = false;
      } else {
        mesh.visible = true;
      }
    }

    for (const key of [...this.motionGhosts.keys()]) {
      if (!activeGhosts.has(key)) this.disposeMotionGhost(key);
    }
  }

  /** Level group for z, creating an empty one when the dest floor has no tiles yet. */
  private ensureLevelGroup(z: number): THREE.Group {
    let group = this.levelGroups.get(z);
    if (group) return group;
    group = new THREE.Group();
    group.name = `level:${z}`;
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    group.visible =
      this.hideLevelsAbove === undefined || z <= this.hideLevelsAbove;
    this.world.add(group);
    this.levelGroups.set(z, group);
    return group;
  }

  private ensureMotionGhost(
    key: string,
    source: THREE.Mesh,
    z: number,
  ): THREE.Mesh {
    const existing = this.motionGhosts.get(key);
    if (existing && existing.userData.drawOnZ === z) return existing;
    this.disposeMotionGhost(key);

    const mat = source.material as THREE.MeshBasicMaterial;
    const texture = mat.map ?? this.magentaTex;
    const ghost = new THREE.Mesh(
      source.geometry.clone(),
      this.materialFor(texture, z),
    );
    ghost.frustumCulled = false;
    ghost.matrixAutoUpdate = false;
    ghost.userData.drawOnZ = z;
    this.ensureLevelGroup(z).add(ghost);
    this.motionGhosts.set(key, ghost);
    return ghost;
  }

  private syncMotionGhost(ghost: THREE.Mesh, source: THREE.Mesh) {
    ghost.position.copy(source.position);
    const srcAttrs = source.geometry.attributes;
    const dstAttrs = ghost.geometry.attributes;
    for (const name of Object.keys(srcAttrs)) {
      const src = srcAttrs[name];
      const dst = dstAttrs[name];
      if (!src?.array || !dst?.array) continue;
      (dst.array as Float32Array).set(src.array as Float32Array);
      dst.needsUpdate = true;
    }
    ghost.updateMatrix();
    ghost.updateMatrixWorld(true);
  }

  private disposeMotionGhost(key: string) {
    const ghost = this.motionGhosts.get(key);
    if (!ghost) return;
    ghost.parent?.remove(ghost);
    ghost.geometry.dispose();
    this.motionGhosts.delete(key);
  }

  private clearMotionGhosts() {
    for (const key of [...this.motionGhosts.keys()]) {
      this.disposeMotionGhost(key);
    }
  }

  private applyMap(map: MapFile, force: boolean) {
    if (!force && map === this.prevMap) return;
    // Stacks moved under the chrome — whatever it was anchored to may be gone.
    this.overlaySig = null;
    if (!force && this.prevMap) {
      this.rebuildDirty(map);
    } else {
      this.rebuildAll(map);
    }
  }

  private bindResize() {
    this.resizeObserver = new ResizeObserver(() => {
      this.updateCanvasSize();
      this.needsRender = true;
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

  private applyCamera(camX: number, camY: number, zoom: number) {
    this.updateCanvasSize();
    const viewW = this.canvasW / zoom;
    const viewH = this.canvasH / zoom;
    this.camera.left = camX;
    this.camera.right = camX + viewW;
    this.camera.top = camY;
    this.camera.bottom = camY + viewH;
    this.camera.scale.set(1, 1, 1);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
  }

  private ensureLightUniforms(z: number): LevelLightUniforms {
    let u = this.lightUniformsByZ.get(z);
    if (!u) {
      u = {
        uLightMap: { value: this.whiteTex },
        uLightOrigin: { value: new THREE.Vector2(0, 0) },
        uLightSize: { value: new THREE.Vector2(1, 1) },
        uLightingEnabled: { value: 1 },
        uAmbient: { value: new THREE.Vector3(0, 0, 0) },
      };
      this.lightUniformsByZ.set(z, u);
    }
    return u;
  }

  private materialFor(texture: THREE.Texture, z: number): THREE.MeshBasicMaterial {
    const key = `${texture.uuid}:${z}`;
    let mat = this.materials.get(key);
    if (!mat) {
      const lightUniforms = this.ensureLightUniforms(z);
      mat = new THREE.MeshBasicMaterial({
        map: texture,
        side: THREE.DoubleSide,
      });
      mat.onBeforeCompile = (shader) => {
        injectWorldShader(shader, lightUniforms);
      };
      mat.customProgramCacheKey = () => WORLD_SHADER_CACHE_KEY;
      this.materials.set(key, mat);
    }
    mat.alphaTest = 0.5;
    mat.transparent = true;
    mat.opacity = 1;
    mat.depthTest = true;
    mat.depthWrite = true;
    mat.needsUpdate = true;
    return mat;
  }

  /**
   * Cells the camera can reach at any level.
   *
   * The projection is axis-aligned in world pixels — level `z` shifts a cell by
   * `CELL_SIZE * z` (see {@link screenToCoord}) — so the visible region is a
   * plain rect per level, and the union across levels is the same rect grown by
   * the level span. Cheap enough to redo every frame.
   */
  private lightWindow(view: WorldView): WorldRect {
    const viewW = this.canvasW / view.zoom;
    const viewH = this.canvasH / view.zoom;
    const cell = (px: number, z: number) =>
      Math.floor((px + CELL_SIZE * z) / CELL_SIZE);
    return {
      x0: cell(view.camera.x, MIN_LEVEL) - LIGHT_WINDOW_MARGIN,
      y0: cell(view.camera.y, MIN_LEVEL) - LIGHT_WINDOW_MARGIN,
      x1: cell(view.camera.x + viewW, MAX_LEVEL) + LIGHT_WINDOW_MARGIN,
      y1: cell(view.camera.y + viewH, MAX_LEVEL) + LIGHT_WINDOW_MARGIN,
    };
  }

  private updateLighting(view: WorldView) {
    if (view.tilesById !== this.lightingTilesById) {
      this.lighting = new ChunkedLighting(view.tilesById, DYNAMIC_LIGHT_TILE_IDS);
      this.lightingTilesById = view.tilesById;
      this.staticLightGrid = null;
    }

    // Ambient is a uniform, not a bake input. Moving the clock now costs one
    // vector write per level — no re-tint, no re-upload, nothing invalidated.
    const ambient = sampleIllumination(view.minutesOfDay).ambient;
    for (const u of this.lightUniformsByZ.values()) {
      u.uAmbient.value.set(ambient[0], ambient[1], ambient[2]);
    }
    this.pendingAmbient = ambient;

    // Bakes only the chunks in view that are missing, and hands back the same
    // grid object while nothing has changed — so identity, not a content hash,
    // is what decides whether the textures need rewriting. This is what
    // replaced hashing every cell in the map on every frame.
    const base = this.lighting.packedGridFor(view.map, this.lightWindow(view));

    const overridesKey = emitterOverridesKey(view.emitterOverrides);
    if (base === this.staticLightGrid && overridesKey === this.lightingKey) {
      return;
    }
    this.staticLightGrid = base;
    this.lightingKey = overridesKey;

    const overrides = view.emitterOverrides;
    if (!overrides?.length) {
      this.uploadPackedGrid(base);
      return;
    }

    this.uploadPackedGrid(
      overlayEmitterOverridesPacked(base, view.map, view.tilesById, overrides),
    );
  }

  private uploadPackedGrid(grid: PackedLightGrid) {
    const seen = new Set<number>();
    for (const [z, level] of grid.levels) {
      seen.add(z);
      this.uploadPackedLevel(z, level);
    }
    for (const z of this.lightUniformsByZ.keys()) {
      if (seen.has(z)) continue;
      this.uploadDarkLevel(z);
    }
  }

  /**
   * No grid for this level, so it draws unlit. Alpha 0 as well as RGB 0 — with
   * ambient applied in the shader, a leftover alpha would tint this to the sky
   * colour instead of leaving it dark.
   */
  private uploadDarkLevel(z: number) {
    const u = this.ensureLightUniforms(z);
    u.uLightingEnabled.value = 1;
    const data = new Uint8Array([0, 0, 0, 0]);
    let tex = this.lightTextures.get(z);
    if (!tex || tex.image.width !== 1) {
      tex?.dispose();
      tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.colorSpace = THREE.NoColorSpace;
      tex.needsUpdate = true;
      this.lightTextures.set(z, tex);
    } else {
      (tex.image.data as Uint8Array).set(data);
      tex.needsUpdate = true;
    }
    u.uLightMap.value = tex;
    u.uLightOrigin.value.set(0, 0);
    u.uLightSize.value.set(1, 1);
  }

  /** Hand the packed plane straight to the GPU — it is already in texture layout. */
  private uploadPackedLevel(z: number, level: PackedLevelLight) {
    const u = this.ensureLightUniforms(z);
    u.uLightingEnabled.value = 1;
    if (this.pendingAmbient) {
      const a = this.pendingAmbient;
      u.uAmbient.value.set(a[0], a[1], a[2]);
    }
    u.uLightOrigin.value.set(
      level.x0 - LIGHT_MAP_CELL_OFFSET,
      level.y0 - LIGHT_MAP_CELL_OFFSET,
    );
    u.uLightSize.value.set(level.w, level.h);

    let tex = this.lightTextures.get(z);
    if (!tex || tex.image.width !== level.w || tex.image.height !== level.h) {
      tex?.dispose();
      tex = new THREE.DataTexture(level.rgba, level.w, level.h, THREE.RGBAFormat);
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.flipY = false;
      tex.colorSpace = THREE.NoColorSpace;
      tex.needsUpdate = true;
      this.lightTextures.set(z, tex);
    } else {
      (tex.image as { data: Uint8Array }).data.set(level.rgba);
      tex.needsUpdate = true;
    }
    u.uLightMap.value = tex;
  }


  private rebuildAll(map: MapFile) {
    this.clearMotionGhosts();
    while (this.world.children.length) {
      const g = this.world.children.pop()!;
      disposeObject3D(g);
    }
    this.levelGroups.clear();
    this.animatedByLevel.clear();
    this.animated = [];
    this.animatedByKey.clear();
    this.movableMeshes.clear();
    this.movableBasePos.clear();
    this.movableBaseBox.clear();

    for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
      this.buildLevel(map, z);
    }
    this.rebuildAnimatedIndex();
    this.prevMap = map;
    this.world.updateMatrixWorld(true);
  }

  private rebuildDirty(next: MapFile) {
    const prev = this.prevMap;
    if (!prev) {
      this.rebuildAll(next);
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
      dirtyLevels.add(z);
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
  }

  private removeLevel(z: number) {
    for (const [key, ghost] of this.motionGhosts) {
      if (ghost.userData.drawOnZ === z) this.disposeMotionGhost(key);
    }
    const group = this.levelGroups.get(z);
    if (group) {
      group.parent?.remove(group);
      disposeObject3D(group);
      this.levelGroups.delete(z);
    }
    this.animatedByLevel.delete(z);
    for (const key of [...this.movableMeshes.keys()]) {
      if (key.startsWith(`${z}:`)) {
        this.movableMeshes.delete(key);
        this.movableBasePos.delete(key);
        this.movableBaseBox.delete(key);
        this.disposeMotionGhost(key);
      }
    }
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

  private buildLevel(map: MapFile, z: number) {
    const coords = listCoords(map, z);
    if (coords.length === 0) return;

    type Item = Quad & {
      texture: THREE.Texture;
      tileKey?: string;
      anim?: {
        frames: Frame[];
        tileset: TilesetDef;
        animKey: string;
      };
    };

    const items: Item[] = [];

    for (const cell of coords) {
      let elev = 0;
      cell.stack.forEach((placed, stackIndex) => {
        const def = this.tilesById[placed.tileId];
        if (!def) {
          elev += 0;
          return;
        }

        const frames = getFrames(def, {
          direction: placed.direction,
          map,
          x: cell.x,
          y: cell.y,
          z,
        });
        const first = frames?.[0];
        if (!first) return;

        const tileset = this.tilesetById.get(first.sprite.tilesetId);
        if (!tileset) return;

        const foot = absoluteElevation(z, elev);
        const box = depthBox(cell.x, cell.y, foot, foot + def.height);
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
        const instanceKey = this.tileKey({
          x: cell.x,
          y: cell.y,
          z,
          stackIndex,
        });
        // Separate mesh when animated or currently lerping (so we can offset it).
        const separate = isAnimated || this.motionKeys.has(instanceKey);
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
          box,
          stackBias: depthStackBias(z, stackIndex),
          texture,
          lightX0: cell.x,
          lightY0: cell.y,
          lightX1: cell.x + 1,
          lightY1: cell.y + 1,
          unlit: tileCanEmitLight(def),
          tileKey: separate ? instanceKey : undefined,
          anim:
            isAnimated && frames
              ? {
                  frames,
                  tileset,
                  animKey,
                }
              : undefined,
        });

        elev += physicalHeight(def);
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
      if (item.anim || item.tileKey) {
        const mesh = this.addQuadMesh(levelGroup, item, item.texture, z);
        if (item.tileKey) {
          this.movableMeshes.set(item.tileKey, mesh);
          this.movableBasePos.set(item.tileKey, {
            x: mesh.position.x,
            y: mesh.position.y,
          });
          this.movableBaseBox.set(item.tileKey, {
            box: item.box,
            stackBias: item.stackBias,
          });
        }
        if (item.anim) {
          animated.push({
            mesh,
            frames: item.anim.frames,
            tileset: item.anim.tileset,
            animKey: item.anim.animKey,
          });
        }
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
      if (this.frameIndices.get(key) === idx) continue;
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
}
