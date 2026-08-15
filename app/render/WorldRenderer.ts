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
import {
  changedCellsOnLevel,
  getStack,
  listCoords,
  stackHeight,
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
  coordKey,
  levelKey,
  parseCoordKey,
  physicalHeight,
  resolveLightPassing,
  tileCanEmitLight,
  tileEmissionPhase,
  tileLightVaries,
} from "../lib/types";
import { isMobileTile } from "../lib/interactions";
import { getFrames } from "../lib/tileResolve";
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
import {
  disposeGroupChildren,
  makeSpriteOutline,
  OUTLINE_ALPHA_UNIFORM,
  pulseAlphaAt,
} from "./overlayMeshes";
import { type SpriteQuadAssets, spriteQuadFor } from "./spriteQuad";

type AnimatedInstance = {
  mesh: THREE.Mesh;
  /** Instance key, so a cell's animated meshes can be dropped without a sweep. */
  key: string;
  frames: Frame[];
  tileset: TilesetDef;
  animKey: string;
};

/** One quad the builder will emit, plus what decides how it is drawn. */
type BuildItem = Quad & {
  texture: THREE.Texture;
  /** Set when this tile gets its own mesh rather than joining a merged batch. */
  tileKey?: string;
  anim?: {
    frames: Frame[];
    tileset: TilesetDef;
    animKey: string;
  };
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
  /**
   * World-pixel offset to draw the outline at, matching the sprite's own lerp.
   *
   * An outline is cut from the art at the tile's *committed* cell, and a walk
   * only commits when it lands — so without this the silhouette sits at the cell
   * a creature is leaving and snaps a whole cell forward when the step
   * completes. It read as the outline chasing the thing it was supposed to be
   * around, permanently a step behind.
   *
   * Taken from the same {@link TileMotion} that offsets the sprite rather than
   * recomputed here, so the two cannot drift apart by a frame or a pixel.
   */
  ox?: number;
  oy?: number;
  /**
   * Breathe rather than sit still, for an outline that marks a decision the
   * player made rather than something the pointer happens to be over.
   *
   * A property of the outline and not of what it is around, because the same
   * body is outlined both ways within a second of each other — hovered, then
   * chosen — and the difference between those two readings is exactly this.
   */
  pulse?: boolean;
};

export type OverlaySpec = ObjectOutlineOverlay;

function overlaySpecKey(spec: OverlaySpec): string {
  // The offset is part of the identity: while a tile is walking it changes every
  // frame, and that is exactly when the outline has to be rebuilt to keep up.
  const at = spec.ox || spec.oy ? `@${Math.round(spec.ox ?? 0)},${Math.round(spec.oy ?? 0)}` : "";
  // The pulse is in the key but the *phase* deliberately is not: a breathing
  // outline is one mesh whose uniform is written per frame, so keying on how lit
  // it is right now would rebuild the whole chrome layer sixty times a second.
  return `o:${spec.x},${spec.y},${spec.z},${spec.stackIndex}:${spec.color}${spec.pulse ? "~" : ""}${at}`;
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

/**
 * Tiles the static bake leaves out, painted per frame by the overlay instead.
 *
 * Derived from the tile set rather than named, so a second character — or a
 * hundred — is omitted automatically. A hardcoded `{player}` was correct only
 * for as long as exactly one thing moved.
 *
 * Both conditions are load-bearing. **Mobile** is why it is worth omitting: a
 * tile that changes cell would otherwise dirty the chunks around it on every
 * step. **Light-passing** is what makes omitting it *sound*: the overlay is
 * add-only, so it can paint a light the bake left out but cannot carve a shadow
 * the bake never knew about. Omitting an occluder would light straight through
 * it. A mobile tile that blocks light therefore stays baked and pays for its
 * movement — see the note in AGENTS.md before changing that.
 */
function dynamicLightTileIds(
  tilesById: Record<string, TileDef>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const def of Object.values(tilesById)) {
    if (isMobileTile(def) && resolveLightPassing(def)) ids.add(def.id);
  }
  return ids;
}

/**
 * Slack cells around the camera's reach, for sprite overhang the strict cell
 * rect misses. Deliberately small: the apron that makes edge light *correct* is
 * applied inside the bake, and chunk alignment already keeps a nudging camera
 * from refilling, so widening this only bakes cells nobody looks at.
 */
const LIGHT_WINDOW_MARGIN = 4;

/**
 * Changed cells past which the incremental path stops being worth it.
 *
 * Each one costs two {@link cellItems} rebuilds for the comparison, plus nine
 * more for its autotile ring. A step touches two cells; a paint stroke or a
 * level load touches hundreds, and for those the wholesale rebuild is both
 * simpler and faster. Set well above what gameplay produces and well below
 * what an edit does.
 */
const MAX_INCREMENTAL_CELLS = 16;

/** The cells themselves plus their 8 neighbours — an autotile's whole input. */
function withNeighbourRing(cells: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const key of cells) {
    const { x, y } = parseCoordKey(key);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) out.add(coordKey(x + dx, y + dy));
    }
  }
  return out;
}

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
  /**
   * Materials of the outlines that breathe, and the clock they breathe on.
   *
   * The clock is the renderer's rather than each mesh's, so a target replaced
   * mid-cycle — a walking one is rebuilt on every frame it moves — picks the new
   * outline up at the phase the old one was leaving, instead of snapping back to
   * a full stop.
   */
  private pulsingOutlines: THREE.ShaderMaterial[] = [];
  private pulseElapsedMs = 0;
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
  private lighting = new ChunkedLighting({}, dynamicLightTileIds({}));
  /** Tile defs the light cache was built against; new defs void every chunk. */
  private lightingTilesById: Record<string, TileDef> | null = null;
  /**
   * Painted-not-baked emitters whose light changes as they animate — a torch
   * carried by something that walks. Empty in every map so far, and cheap to
   * keep that way: their phase joins the overlay's cache key, and an empty list
   * contributes nothing to it.
   */
  private flickeringDynamicDefs: TileDef[] = [];
  /** @see setLightingEnabled */
  private lightingEnabled = true;
  private prevMap: MapFile | null = null;
  private needsRender = true;
  private canvasW = 0;
  private canvasH = 0;
  private resizeObserver: ResizeObserver | null = null;
  /** Square buffer side in pixels, or null to track the element. */
  private fixedBufferPx: number | null = null;
  /**
   * Whether every tileset is on the GPU. Nothing is painted until it is —
   * @see renderOnce.
   */
  private assetsReady = false;
  /** Fired once, after the first frame that actually reached the canvas. */
  private onFirstFrame: (() => void) | null = null;
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
        if (this.lightingEnabled) this.updateLighting(this.view);
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

    // Before applyMap, which advances prevMap — the light cache needs to see
    // both versions to work out which chunks the edit reached.
    if (this.lightingEnabled) {
      this.time("sync", () => this.lighting.syncTo(this.prevMap, view.map));
    }

    this.time("map", () => {
      this.applyMap(view.map, false);
      this.applyLevelVisibility(view.hideLevelsAbove);
    });
    if (this.lightingEnabled) {
      this.time("light", () => this.updateLighting(view));
    }
    this.time("motion", () => this.applyTileMotions(view.tileMotions));
    this.needsRender = true;
  }

  /**
   * Draw the world unlit, and stop computing light at all.
   *
   * Not a shader switch with the bake still running behind it: while this is
   * off nothing is baked, stitched, uploaded or diffed for invalidation — the
   * two most expensive phases of a frame (`sync` and `light`) are skipped
   * outright, which is the point of the toggle.
   *
   * Skipping `syncTo` means the cache stops hearing about edits, so every
   * chunk it holds is suspect the moment light comes back on: turning it on
   * throws the cache away rather than trusting a diff that has a hole in it.
   */
  setLightingEnabled(enabled: boolean) {
    if (enabled === this.lightingEnabled) return;
    this.lightingEnabled = enabled;
    for (const u of this.lightUniformsByZ.values()) {
      u.uLightingEnabled.value = enabled ? 1 : 0;
    }
    if (enabled) {
      this.lighting.invalidateAll();
      // Left for the next frame's setView rather than baked here: that one
      // arrives with the emitter overrides this frame's view no longer has,
      // so baking now would only pay for a grid missing every dynamic light.
      this.staticLightGrid = null;
      this.lightingKey = "";
    }
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
    this.pulsingOutlines = [];
    for (const spec of specs) this.addOverlay(spec);
    // At the phase the clock is already at, so a rebuild is invisible rather
    // than a flash back to full brightness.
    this.applyPulse();
    // Scene has matrixWorldAutoUpdate=false — without this the meshes keep an
    // identity matrixWorld and all draw at the world origin.
    this.overlays.updateMatrixWorld(true);
    this.needsRender = true;
  }

  /** Write this instant's brightness into every breathing outline. */
  private applyPulse() {
    if (this.pulsingOutlines.length === 0) return;
    const alpha = pulseAlphaAt(this.pulseElapsedMs);
    for (const material of this.pulsingOutlines) {
      material.uniforms[OUTLINE_ALPHA_UNIFORM]!.value = alpha;
    }
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
    if (!quad) return;
    // Moved rather than rebuilt at a different cell: the silhouette is cut from
    // the art where the map says the tile is, and the offset carries it to where
    // the sprite has actually been drawn this frame.
    quad.x += spec.ox ?? 0;
    quad.y += spec.oy ?? 0;
    const outline = makeSpriteOutline(quad, spec.color);
    if (spec.pulse) {
      this.pulsingOutlines.push(outline.material as THREE.ShaderMaterial);
    }
    this.overlays.add(outline);
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
    // Before the early return: a breathing outline is the one thing on screen
    // that moves while the world is perfectly still, which is exactly the case
    // `updateAnimations` says there is nothing to do in.
    if (this.pulsingOutlines.length > 0) {
      this.pulseElapsedMs += dt;
      this.applyPulse();
      this.needsRender = true;
    }
    // Kept outside `updateAnimations`, which has nothing to do — and used to
    // return before advancing this — when no animated sprite is on screen. The
    // light bake reads the same clock, and an emitter can sit outside the built
    // geometry while its light still reaches inside the window.
    this.animClock += dt;
    if (!this.updateAnimations()) return;
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

  /**
   * Called the first time a frame reaches the canvas, so whoever owns the page
   * can take its loading screen down against the world appearing rather than
   * against a guess at when it will.
   */
  setOnFirstFrame(cb: (() => void) | null) {
    this.onFirstFrame = cb;
  }

  renderOnce() {
    if (this.disposed) return;
    // Not one pixel until every tileset is on the GPU. A material whose texture
    // has not arrived draws `magentaTex`, so painting early means a frame or
    // more of magenta over the whole world — the placeholder is there to make a
    // *missing* tileset obvious, and a tileset that is merely still in flight is
    // not missing. `setAssets` flips this and asks for a frame.
    if (!this.assetsReady) return;
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

    // After the draw, never before: the callback's whole job is to say that
    // there is something on the canvas now.
    const first = this.onFirstFrame;
    this.onFirstFrame = null;
    first?.();
  }

  isReady(): boolean {
    return !this.disposed && this.assetsReady && this.prevMap !== null;
  }

  dispose() {
    this.disposed = true;
    this.stop();
    this.resizeObserver?.disconnect();
    this.palettePass.dispose();
    disposeGroupChildren(this.overlays);
    // Dropped with the meshes they belong to: a disposed material written to on
    // a stray tick is a use-after-free as far as WebGL is concerned.
    this.pulsingOutlines = [];
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

  /**
   * Draw into a square buffer of `px`, ignoring the element's CSS box.
   *
   * Play mode fixes the buffer so the world renders at a whole number of pixels
   * per world pixel and the element is then stretched over its pane — see
   * `./viewport`. Left unset, the buffer tracks the element, which is what the
   * editor wants: there the pane *is* the view.
   */
  setBufferSize(px: number) {
    this.fixedBufferPx = Math.max(1, Math.floor(px));
    this.updateCanvasSize();
  }

  private updateCanvasSize() {
    const fixed = this.fixedBufferPx;
    const w = fixed ?? Math.max(1, this.canvas.clientWidth);
    const h = fixed ?? Math.max(1, this.canvas.clientHeight);
    if (w === this.canvasW && h === this.canvasH) return;
    this.canvasW = w;
    this.canvasH = h;
    // `false`: the CSS box is the layout's business, and under a fixed buffer
    // it is deliberately not the buffer's size.
    this.renderer.setSize(w, h, false);
  }

  /**
   * Every tileset onto the GPU, and a failure is one tileset's problem.
   *
   * Each load is caught on its own because the frame loop now waits on this
   * whole pass finishing (@see renderOnce). Left to reject, a single 404 would
   * mean `assetsReady` never flips and the world is never drawn at all —
   * trading a magenta wall, which is the placeholder doing its job, for a black
   * screen, which is the game not starting.
   */
  private async preloadTextures() {
    await Promise.all(
      this.tilesets.map(async (ts) => {
        if (this.textures.has(ts.id)) return;
        const loader = new THREE.TextureLoader();
        try {
          const tex = await loader.loadAsync(`/tilesets/${ts.file}`);
          tex.magFilter = THREE.NearestFilter;
          tex.minFilter = THREE.NearestFilter;
          tex.generateMipmaps = false;
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.flipY = true;
          tex.needsUpdate = true;
          this.textures.set(ts.id, tex);
        } catch (err) {
          console.warn(`tileset failed to load: ${ts.file}`, err);
        }
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
      const dynamicIds = dynamicLightTileIds(view.tilesById);
      this.lighting = new ChunkedLighting(view.tilesById, dynamicIds);
      this.flickeringDynamicDefs = [...dynamicIds]
        .map((id) => view.tilesById[id])
        .filter((def): def is TileDef => def != null && tileLightVaries(def));
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
    //
    // The animation clock is a bake input: a torch that flickers emits what its
    // live frame says it does, not what frame 0 said. Chunks no flicker reaches
    // are unaffected by it, so the clock alone never causes a bake.
    const base = this.lighting.packedGridFor(
      view.map,
      this.lightWindow(view),
      this.animClock,
    );

    // The dynamic emitters' own phase belongs in the key as well as the static
    // one. Their light is painted, not baked, so nothing about the grid or the
    // override positions would change as their frames tick over.
    const overridesKey = [
      emitterOverridesKey(view.emitterOverrides),
      ...this.flickeringDynamicDefs.map((def) =>
        tileEmissionPhase(def, this.animClock),
      ),
    ].join("|");
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
      overlayEmitterOverridesPacked(
        base,
        view.map,
        view.tilesById,
        overrides,
        this.animClock,
      ),
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

    // A level can change identity without any cell differing — a chunk record
    // rewritten to the same contents. Nothing to push to the GPU for those.
    let meshesChanged = false;
    for (const z of dirtyLevels) {
      const outcome = this.rebuildLevelIncrementally(prev, next, z);
      if (outcome === "unchanged") continue;
      if (outcome === "rebuilt") {
        meshesChanged = true;
        continue;
      }
      this.removeLevel(z);
      this.buildLevel(next, z);
      meshesChanged = true;
    }
    if (meshesChanged) {
      this.rebuildAnimatedIndex();
      this.world.updateMatrixWorld(true);
    }
    this.prevMap = next;
  }

  /**
   * Rebuild only what changed on a level, or report that it cannot.
   *
   * Merged geometry is one batch per (level, texture), so any change to it
   * means rebuilding the floor — 4565 cells on level 0, ~8.7ms, for a step that
   * moved one sprite. But a mobile tile is never in that batch, so a step
   * changes only its own mesh, and the batch is byte-identical across the edit.
   * This detects that case and takes the cheap path.
   *
   * Detection is by rebuilding the affected cells' quads and comparing the
   * merged ones — the same {@link cellItems} the full build uses, so the two
   * cannot disagree about what a cell should look like.
   *
   * Ordering inside the level group is not a concern: depth comes from the box
   * attribute each quad carries, resolved per fragment, so a mesh appended late
   * still sorts where it belongs.
   */
  private rebuildLevelIncrementally(
    prev: MapFile,
    next: MapFile,
    z: number,
  ): "unchanged" | "rebuilt" | "needs-full-rebuild" {
    const changed = changedCellsOnLevel(prev, next, z);
    if (changed.size === 0) return "unchanged";
    // Bail rather than diff half a floor: past a handful of cells the
    // comparison costs more than the rebuild it is trying to avoid.
    if (changed.size > MAX_INCREMENTAL_CELLS) return "needs-full-rebuild";

    // An autotile reads its 8 neighbours, so a changed cell can restyle the
    // ring around it without those cells changing themselves.
    const affected = withNeighbourRing(changed);
    for (const key of affected) {
      const { x, y } = parseCoordKey(key);
      if (
        this.mergedSignatureAt(prev, z, x, y) !==
        this.mergedSignatureAt(next, z, x, y)
      ) {
        return "needs-full-rebuild";
      }
    }

    // No group yet means this level had no geometry at all — there is nothing
    // to patch into, so let the full build create it.
    const group = this.levelGroups.get(z);
    if (!group) return "needs-full-rebuild";

    for (const key of changed) {
      const { x, y } = parseCoordKey(key);
      this.removeSeparatesAt(z, x, y);
    }

    const animated = this.animatedByLevel.get(z) ?? [];
    for (const key of changed) {
      const { x, y } = parseCoordKey(key);
      for (const item of this.cellItems(next, z, x, y, getStack(next, x, y, z))) {
        if (!item.anim && !item.tileKey) continue;
        this.installSeparate(group, item, z, animated);
      }
    }
    if (animated.length > 0) this.animatedByLevel.set(z, animated);
    else this.animatedByLevel.delete(z);

    return "rebuilt";
  }

  /** The merged-batch contribution of one cell, as a comparable string. */
  private mergedSignatureAt(
    map: MapFile,
    z: number,
    x: number,
    y: number,
  ): string {
    let sig = "";
    for (const item of this.cellItems(map, z, x, y, getStack(map, x, y, z))) {
      if (item.anim || item.tileKey) continue;
      const b = item.box;
      sig += `${item.x},${item.y},${item.w},${item.h}|${item.u0},${item.v0},${item.u1},${item.v1}|${b.eastPx},${b.southPx},${b.foot},${b.top}|${item.stackBias}|${item.unlit ? 1 : 0}|${item.texture.uuid}~`;
    }
    return sig;
  }

  /** Drop every own-mesh tile at a cell, so the cell can be rebuilt from scratch. */
  private removeSeparatesAt(z: number, x: number, y: number) {
    const prefix = `${z}:${x},${y}:`;
    for (const key of [...this.movableMeshes.keys()]) {
      if (!key.startsWith(prefix)) continue;
      const mesh = this.movableMeshes.get(key)!;
      mesh.parent?.remove(mesh);
      mesh.geometry.dispose();
      this.movableMeshes.delete(key);
      this.movableBasePos.delete(key);
      this.movableBaseBox.delete(key);
      this.disposeMotionGhost(key);
    }
    const animated = this.animatedByLevel.get(z);
    if (!animated) return;
    const kept = animated.filter((inst) => !inst.key.startsWith(prefix));
    if (kept.length === animated.length) return;
    if (kept.length > 0) this.animatedByLevel.set(z, kept);
    else this.animatedByLevel.delete(z);
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

  /**
   * Quads for one cell's stack.
   *
   * The single place a placed tile becomes geometry. Both the full level build
   * and the incremental one go through it, so the cheap path cannot silently
   * disagree with the expensive one about what a cell should look like — which
   * is the failure mode that makes incremental rendering hard to trust.
   */
  private cellItems(
    map: MapFile,
    z: number,
    x: number,
    y: number,
    stack: PlacedTile[],
  ): BuildItem[] {
    const items: BuildItem[] = [];
    let elev = 0;

    stack.forEach((placed, stackIndex) => {
      const def = this.tilesById[placed.tileId];
      if (!def) return;

      const frames = getFrames(def, {
        direction: placed.direction,
        map,
        x,
        y,
        z,
      });
      const first = frames?.[0];
      if (!first) return;

      const tileset = this.tilesetById.get(first.sprite.tilesetId);
      if (!tileset) return;

      const foot = absoluteElevation(z, elev);
      const box = depthBox(x, y, foot, foot + def.height);
      const baseOrigin = baseCellWorldOrigin(x, y, z, elev);
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
      const instanceKey = this.tileKey({ x, y, z, stackIndex });
      // Own mesh when animated, or when the tile can move at all — not merely
      // when it happens to be moving right now. Keying this on the live motion
      // set meant a tile changed batch membership the instant it started and
      // stopped, and changing membership rebuilt the merged geometry for the
      // whole floor: a full rebuild per step, for a sprite that only needed a
      // new position.
      const separate = isAnimated || isMobileTile(def);
      const animKey =
        def.type === "autotile"
          ? `${def.id}:${x},${y},${z}`
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
        lightX0: x,
        lightY0: y,
        lightX1: x + 1,
        lightY1: y + 1,
        unlit: tileCanEmitLight(def),
        tileKey: separate ? instanceKey : undefined,
        anim: isAnimated && frames ? { frames, tileset, animKey } : undefined,
      });

      elev += physicalHeight(def);
    });

    return items;
  }

  /** Give an item its own mesh and register it in whichever indexes claim it. */
  private installSeparate(
    parent: THREE.Object3D,
    item: BuildItem,
    z: number,
    animated: AnimatedInstance[],
  ) {
    const mesh = this.addQuadMesh(parent, item, item.texture, z);
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
        key: item.tileKey ?? "",
        frames: item.anim.frames,
        tileset: item.anim.tileset,
        animKey: item.anim.animKey,
      });
    }
  }

  private buildLevel(map: MapFile, z: number) {
    const coords = listCoords(map, z);
    if (coords.length === 0) return;

    const items: BuildItem[] = [];
    for (const cell of coords) {
      for (const item of this.cellItems(map, z, cell.x, cell.y, cell.stack)) {
        items.push(item);
      }
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
        this.installSeparate(levelGroup, item, z, animated);
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

  private updateAnimations(): boolean {
    if (this.animatedByKey.size === 0) return false;
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
