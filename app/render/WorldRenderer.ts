import * as THREE from "three";
import { tilesetUrl } from "../lib/api";
import {
  absoluteElevation,
  baseCellWorldOrigin,
  CELL_CENTRE,
  type DepthBox,
  DEPTH_LEAST_BODY,
  depthBox,
  depthStackBias,
  spriteWorldOrigin,
  WADE_EDGE_PX,
  WADE_SINK_PX,
} from "../lib/geometry";
import {
  emitterCenter,
  isPitchBlack,
  overlayEmitterOverridesPacked,
  VOID_BACKGROUND,
  type EmitterOverride,
  type PackedLevelLight,
  type PackedLightGrid,
} from "../lib/lighting";
import { sampleIllumination } from "../lib/clock";
import {
  changedCellsInChunk,
  changedCellsOnLevel,
  chunkKeyFor,
  footElevation,
  getChunk,
  getStack,
  stackHeight,
  terrainHeight,
} from "../lib/mapData";
import {
  cellInMeshWindow,
  chunkAddressKey,
  parseChunkAddress,
  visibleChunkKeys,
} from "./meshWindow";
import {
  admitTransitions,
  placementIdentity,
  appendTransitionEmitters,
  fadingLightScale,
  isFinished,
  liveShown,
  pixelSnappedQuad,
  rejoinsBatch,
  resolveTransitionSlot,
  struckRemainsSlot,
  transitionAddress,
  transitionPose,
  noTransitionUniforms,
  transitionUniforms,
  writeTransitionUniforms,
  type LiveTransition,
  type TransitionPose,
  type TransitionUniforms,
} from "./tileTransitions";
import { transitionOf, type HeldTransition } from "../lib/tileTransition";
import { type RoofCut, cutHides, cutHidesWholeLevel } from "../lib/levelVisibility";
import { isCellVisible } from "./cameraSight";
import { countOf } from "../lib/piles";
import { cutMaskFor } from "./cutMask";
import type {
  Frame,
  MapFile,
  Octant,
  PlacedTile,
  SpriteAnchor,
  SpriteState,
  TileDef,
  TilesetDef,
} from "../lib/types";
import {
  CELL_SIZE,
  HEIGHT_PER_LEVEL,
  MAX_LEVEL,
  MIN_LEVEL,
  coordKey,
  cellPhaseMs,
  frameIndexAtTime,
  levelKey,
  parseCoordKey,
  resolveActor,
  resolveLightPassing,
  spriteRect,
  tileCanEmitLight,
  tileEmissionPhase,
  tileLightVaries,
} from "../lib/types";
import { hasSpriteStates, isMobileTile } from "../lib/interactions";
import { clumpExtents } from "./depthClump";
import { getFrames, resolveLight, resolveTileSprite } from "../lib/tileResolve";
import { ChunkedLighting, LIGHT_WINDOW_MARGIN, type WorldRect } from "../lib/lightingChunks";
import { canBakeOffThread, WorkerChunkBaker } from "../lib/lightBakerClient";
import type { FramePhase, FrameProfiler } from "./frameProfile";
import { wearsFlightTransition, type ProjectileView } from "./projectileMotion";
import { projectileEffect } from "../lib/projectile";
import { GpuLighting } from "./gpuLighting";
import { PalettePass } from "./palettePass";
import {
  type LevelCutUniforms,
  type LevelLightUniforms,
  type Quad,
  WORLD_SHADER_CACHE_KEY,
  buildMergedQuadGeometry,
  buildSingleQuadGeometry,
  injectWorldShader,
  type LevelAnimUniforms,
  noAnimUniforms,
  noCutUniforms,
  writeBoxAttr,
  writeLightUvAttr,
  writeWadeAttr,
} from "./worldQuads";
import { AnimationTable, tableCanHold } from "./animTable";
import {
  disposeGroupChildren,
  makeFollowingSpriteOutline,
  makeRectOutline,
  makeSpriteGhost,
  makeSpriteOutline,
  OutlineMaterials,
  OUTLINE_ALPHA_UNIFORM,
  pulseAlphaAt,
} from "./overlayMeshes";
import { DEBUG_COLORS } from "./debugColors";
import {
  boundsOfColumns,
  builtChunkColumns,
  chunkColumnRectPx,
  columnTouches,
  heldChunkColumns,
  rectPx,
  reachInCells,
  type PxRect,
} from "./debugView";
import { NO_PILE_OFFSET, pileDepthNudge, pileOffsets, pileRings } from "./pileLayout";
import { animationKey, type SpriteQuadAssets, spriteQuadFor } from "./spriteQuad";
import { noTintUniforms, tintCacheKey, tintUniforms } from "./spriteTint";
import type { StatusTint } from "../lib/statusVfx";
import { ParticleLayer } from "./particleLayer";
import type { ParticleEmitterSpec } from "./particles";
import {
  appendVisibleTileEmitters,
  type CellHidden,
  tileEmitterId,
  tileEmitterPrefix,
} from "./tileEmitters";
import { PLAYER_TILE_ID } from "../game/constants";

type AnimatedInstance = {
  mesh: THREE.Mesh;
  key: string;
  frames: Frame[];
  tileset: TilesetDef;
  animKey: string;
  def: TileDef;
  placed: PlacedTile;
  cell: { x: number; y: number; z: number };
  state: SpriteState;
  frameIdx: number;
};

const PROJECTILE_STACK_BIAS = 32;

const WADING_RENDER_ORDER = 0.5;

type ProjectileMesh = {
  mesh: THREE.Mesh;
  def: TileDef;
  frames: Frame[];
  direction: Octant;
  tileset: TilesetDef;
  texture: THREE.Texture;
  frameIdx: number;
  z: number;
  w: number;
  h: number;
  base: { x: number; y: number };
  uniforms: TransitionUniforms | null;
};

type BuildItem = Quad & {
  texture: THREE.Texture;
  stackIndex: number;
  transitionId?: string;
  pivotX: number;
  pivotY: number;
  tileKey?: string;
  moves?: boolean;
  anim?: Omit<AnimatedInstance, "mesh" | "key">;
  mergedAnim?: { frames: Frame[]; tileset: TilesetDef; phaseMs: number };
  emitter?: ParticleEmitterSpec;
};

type TransitionState = {
  live: LiveTransition;
  uniforms: TransitionUniforms | null;
  material: THREE.MeshBasicMaterial | null;
  meshes: TransitionMesh[];
  gridAtStart: PackedLightGrid | null;
  plumeId: string | null;
  plume: ParticleEmitterSpec | null;
  burst: ParticleEmitterSpec | null;
};

type TransitionMesh = {
  mesh: THREE.Mesh;
  texture: THREE.Texture;
  z: number;
  centreX: number;
  centreY: number;
  pivotX: number;
  pivotY: number;
  w: number;
  h: number;
  copy: boolean;
  box: DepthBox;
  stackBias: number;
  moves: boolean;
  tileKey?: string;
};

function poseTransitionMesh(
  held: TransitionMesh,
  pose: TransitionPose,
  dropping: boolean,
  motion: TileMotion | undefined,
) {
  const ox = motion?.ox ?? 0;
  const oy = motion?.oy ?? 0;
  const at = pixelSnappedQuad(
    {
      centreX: held.centreX + ox,
      centreY: held.centreY + oy,
      pivotX: held.pivotX + ox,
      pivotY: held.pivotY + oy,
      w: held.w,
      h: held.h,
    },
    pose,
  );
  held.mesh.scale.set(at.scaleX, at.scaleY, 1);
  held.mesh.position.set(at.x, at.y, 0);
  held.mesh.updateMatrix();
  held.mesh.updateMatrixWorld(true);
  if (dropping) {
    const up = at.dropLevels * HEIGHT_PER_LEVEL;
    const box = motion
      ? depthBox(motion.box.x, motion.box.y, motion.box.foot, motion.box.top)
      : held.box;
    writeBoxAttr(
      held.mesh.geometry,
      { ...box, foot: box.foot + up, top: box.top + up },
      motion ? motion.box.stackBias : held.stackBias,
    );
  }
}

const WHOLE_POSE: TransitionPose = { scale: 1, dropLevels: 0 };

function keepVisiblePlumes(
  specs: readonly ParticleEmitterSpec[],
  hidden: CellHidden,
  into: ParticleEmitterSpec[],
) {
  for (const spec of specs) {
    if (!hidden(Math.floor(spec.cx), Math.floor(spec.cy), spec.z)) into.push(spec);
  }
}

const EMPTY_TINTS: ReadonlyMap<string, StatusTint> = new Map();

const LIGHT_MAP_CELL_OFFSET = 0.5;

export type TileInstanceKey = {
  x: number;
  y: number;
  z: number;
  stackIndex: number;
};

export function tileInstanceKey(k: TileInstanceKey): string {
  return `${k.z}:${k.x},${k.y}:${k.stackIndex}`;
}

export function tileInstanceLevel(key: string): number {
  const z = Number.parseInt(key, 10);
  return Number.isNaN(z) ? 0 : z;
}

export type MotionBox = {
  x: number;
  y: number;
  foot: number;
  top: number;
  stackBias: number;
};

export type TileMotion = TileInstanceKey & {
  ox: number;
  oy: number;
  box: MotionBox;
  alsoDrawAtZ?: number;
};

export type WorldView = {
  map: MapFile;
  tilesById: Record<string, TileDef>;
  camera: { x: number; y: number };
  zoom: number;
  minutesOfDay: number;
  tileMotions?: TileMotion[];
  projectiles?: ProjectileView[];
  transitions?: readonly HeldTransition[];
  spriteStates?: ReadonlyMap<string, SpriteState>;
  emitterOverrides?: EmitterOverride[];
  roofCut?: RoofCut;
  viewerZ?: number;
  spriteTints?: ReadonlyMap<string, StatusTint>;
  wading?: ReadonlyMap<string, number>;
  particleEmitters?: readonly ParticleEmitterSpec[];
  playSquare?: { x: number; y: number; sizePx: number };
};

export type ObjectOutlineOverlay = TileInstanceKey & {
  kind: "objectOutline";
  color: number;
  pulse?: boolean;
};

export type TileGhostOverlay = {
  kind: "ghost";
  tileId: string;
  x: number;
  y: number;
  z: number;
  alpha: number;
};

export type OverlaySpec = ObjectOutlineOverlay | TileGhostOverlay;

function overlaySpecKey(spec: OverlaySpec): string {
  if (spec.kind === "ghost") {
    return `g:${spec.tileId}@${spec.x},${spec.y},${spec.z}:${spec.alpha}`;
  }
  return `o:${spec.x},${spec.y},${spec.z},${spec.stackIndex}:${spec.color}${spec.pulse ? "~" : ""}`;
}

function emitterOverridesKey(overrides: EmitterOverride[] | undefined): string {
  if (!overrides?.length) return "";
  return overrides
    .map((o) => {
      const at = `${o.x},${o.y},${o.z}:${o.fx.toFixed(2)},${o.fy.toFixed(2)},${o.fz.toFixed(2)}`;
      if (!o.lights) return at;
      const lit = o.lights.map((l) => `${l.radius},${l.intensity},${l.color}`).join(",");
      return `${at}*${lit}`;
    })
    .join("|");
}

export function dynamicLightTileIds(tilesById: Record<string, TileDef>): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const def of Object.values(tilesById)) {
    if (!resolveLightPassing(def)) continue;
    if (resolveActor(def) || def.id === PLAYER_TILE_ID) ids.add(def.id);
  }
  return ids;
}

const MAX_ANALYSED_CELLS = 64;

function withNeighbourRing(cells: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const key of cells) {
    const { x, y } = parseCoordKey(key);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) out.add(coordKey(x + dx, y + dy));
    }
  }
  return out;
}

function autotileVocabulary(tilesById: Record<string, TileDef>): Set<string> {
  const out = new Set<string>();
  for (const def of Object.values(tilesById)) {
    if (def.type !== "autotile") continue;
    out.add(def.id);
    for (const id of def.connectsTo ?? []) out.add(id);
  }
  return out;
}

function autotileInputOf(
  stack: readonly PlacedTile[] | undefined,
  vocabulary: ReadonlySet<string>,
): string {
  if (!stack || stack.length === 0) return "";
  let sig = "";
  for (const placed of stack) {
    if (vocabulary.has(placed.tileId)) sig += placed.tileId + "|";
  }
  return sig;
}

type ChunkGeometry = {
  group: THREE.Group;
  z: number;
  chunk: string;
  animated: AnimatedInstance[];
  emitters: ParticleEmitterSpec[];
  movableKeys: Set<string>;
};

export type DebugReading = {
  meshChunks: number;
  meshColumns: number;
  meshReachCells: number;
  lightChunks: number;
  lightStale: number;
  lightReachCells: number;
  heldColumns: number;
  heldReachCells: number | null;
  drawCalls: number;
  triangles: number;
};

const DEBUG_MESH_GRID_OPACITY = 0.6;
const DEBUG_HELD_GRID_OPACITY = 0.22;

const DEBUG_GRID_INSET = 1;

const DEBUG_PLAY_DEPTH = 4;

type DebugRectStyle = { heavy?: boolean; opacity?: number; depth?: number };

function inset(rect: PxRect, by: number): PxRect {
  return { x: rect.x + by, y: rect.y + by, w: rect.w - by * 2, h: rect.h - by * 2 };
}

const DEBUG_READ_INTERVAL_MS = 250;

function rectSignature(rect: WorldRect | null): string {
  return rect ? `${rect.x0},${rect.y0},${rect.x1},${rect.y1}` : "-";
}

function sameRect(a: WorldRect | null, b: WorldRect): boolean {
  return a !== null && a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
}

function disposeObject3D(obj: THREE.Object3D) {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
    }
  });
}

export class WorldRenderer {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private world: THREE.Group;
  private overlayScene: THREE.Scene;
  private overlays: THREE.Group;
  private overlaySig: string | null = null;
  private debugWindows: THREE.Group;
  private debugPlayRect: THREE.Group | null = null;
  private debugOn = false;
  private debugWindowKey: string | null = null;
  private debugHeldMap: MapFile | null = null;
  private debugHeldColumns: string[] = [];
  private debugReadAtMs = 0;
  private debugFrameCalls = 0;
  private debugFrameTriangles = 0;
  private pulsingOutlines: THREE.ShaderMaterial[] = [];
  private outlineMaterials = new OutlineMaterials();
  private followingOutlines: { outline: THREE.Mesh; source: THREE.Mesh }[] = [];
  private pulseElapsedMs = 0;
  private textures = new Map<string, THREE.Texture>();
  private materials = new Map<string, THREE.MeshBasicMaterial>();
  private tilesets: TilesetDef[] = [];
  private tilesetById = new Map<string, TilesetDef>();
  private tilesById: Record<string, TileDef> = {};
  private levelGroups = new Map<number, THREE.Group>();
  private chunkGeometry = new Map<string, ChunkGeometry>();
  private meshedWindow: WorldRect | null = null;
  private tileEmittersByLevel = new Map<number, ParticleEmitterSpec[]>();
  private tileEmittersStale = false;
  private readonly visibleEmitters: ParticleEmitterSpec[] = [];
  private animated: AnimatedInstance[] = [];
  private animatedByKey = new Map<string, AnimatedInstance[]>();
  private spriteStates: ReadonlyMap<string, SpriteState> | undefined;
  private movableMeshes = new Map<string, THREE.Mesh>();
  private liveTransitions = new Map<string, TransitionState>();
  private formingAt = new Map<string, string>();
  private formingByPlacement = new Map<string, string>();
  private transitioningMeshes = new Set<THREE.Mesh>();
  private currentMotions: ReadonlyMap<string, TileMotion> = new Map();
  private chunksToRebuild = new Set<string>();
  private transitionGroup: THREE.Group;
  private projectileMeshes = new Map<string, ProjectileMesh>();
  private projectileGroup: THREE.Group;
  private movableBasePos = new Map<string, { x: number; y: number }>();
  private movableBaseBox = new Map<string, { box: DepthBox; stackBias: number }>();
  private motionGhosts = new Map<string, THREE.Mesh>();
  private roofCut: RoofCut | undefined;
  private cutUniformsByZ = new Map<number, LevelCutUniforms>();
  private animUniformsByZ = new Map<number, LevelAnimUniforms>();
  private animTablesByZ = new Map<number, AnimationTable>();
  private cutTextures = new Map<number, THREE.DataTexture>();
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
  private shownLightGrid: PackedLightGrid | null = null;
  private pendingAmbient: [number, number, number] | null = null;
  private gpuLighting = new GpuLighting();
  private lighting = new ChunkedLighting({}, dynamicLightTileIds({}));
  private lightBaker: WorkerChunkBaker | null = null;
  private lightingTilesById: Record<string, TileDef> | null = null;
  private flickeringDynamicDefs: TileDef[] = [];
  private lightingEnabled = true;
  private autotileVocab: ReadonlySet<string> = new Set();
  private autotileVocabFor: Record<string, TileDef> | null = null;
  private prevMap: MapFile | null = null;
  private needsRender = true;
  private canvasW = 0;
  private canvasH = 0;
  private resizeObserver: ResizeObserver | null = null;
  private fixedBufferPx: number | null = null;
  private assetsReady = false;
  private onNextFrame: (() => void) | null = null;
  private view: WorldView | null = null;
  private looping = false;
  private raf = 0;
  private palettePass = new PalettePass();
  private profiler: FrameProfiler | null = null;
  private particles: ParticleLayer;
  private tintedMeshes = new Map<
    string,
    { mesh: THREE.Mesh; texture: THREE.Texture; z: number; tintKey: string }
  >();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
    });
    this.renderer.setClearColor(VOID_BACKGROUND, 1);
    this.renderer.setPixelRatio(1);
    this.renderer.autoClear = true;

    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = false;
    this.camera = new THREE.OrthographicCamera(0, 1, 0, 1, -10, 50);
    this.camera.position.z = 25;

    this.world = new THREE.Group();
    this.scene.add(this.world);

    this.overlayScene = new THREE.Scene();
    this.overlayScene.matrixWorldAutoUpdate = false;
    this.overlays = new THREE.Group();
    this.overlayScene.add(this.overlays);
    this.debugWindows = new THREE.Group();
    this.overlayScene.add(this.debugWindows);
    this.projectileGroup = new THREE.Group();
    this.projectileGroup.matrixAutoUpdate = false;
    this.projectileGroup.updateMatrix();
    this.world.add(this.projectileGroup);
    this.transitionGroup = new THREE.Group();
    this.transitionGroup.name = "tileTransitions";
    this.transitionGroup.matrixAutoUpdate = false;
    this.transitionGroup.updateMatrix();
    this.world.add(this.transitionGroup);

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

    this.particles = new ParticleLayer((z) => this.ensureLightUniforms(z));
    this.world.add(this.particles.mesh);
    this.particles.mesh.updateMatrixWorld(true);

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
      this.lightingKey = "";
      this.staticLightGrid = null;
      if (this.view) {
        this.applyMap(this.view.map, this.cameraWindow(this.view), true);
        if (this.lightingEnabled) this.updateLighting(this.view);
      }
      this.assetsReady = true;
      this.needsRender = true;
    });
  }

  setProfiler(profiler: FrameProfiler | null) {
    this.profiler = profiler;
  }

  private time<T>(phase: FramePhase, fn: () => T): T {
    return this.profiler ? this.profiler.measure(phase, fn) : fn();
  }

  setView(view: WorldView) {
    this.view = view;
    this.tilesById = view.tilesById;
    this.spriteStates = view.spriteStates;
    this.ingestTransitions(view);
    this.applyCamera(view.camera.x, view.camera.y, view.zoom);

    if (this.lightingEnabled) {
      this.time("sync", () => this.lighting.syncTo(this.prevMap, view.map));
    }

    this.time("map", () => {
      this.applyMap(view.map, this.cameraWindow(view), false);
      this.applyRoofCut(view.roofCut);
      this.flushChunkRebuilds();
    });
    if (this.lightingEnabled) {
      this.time("light", () => this.updateLighting(view));
    }
    this.time("state", () => {
      this.applySpriteStates(view.spriteStates);
      this.applySpriteTints(view.spriteTints);
    });
    this.time("motion", () => {
      this.applyTileMotions(view.tileMotions, view.wading);
      this.applyProjectiles(view.projectiles);
      this.particles.setEmitters(this.emittersFor(view));
    });
    if (this.debugOn) this.syncDebugOverlay(view);
    this.needsRender = true;
  }

  private emittersFor(view: WorldView): readonly ParticleEmitterSpec[] {
    if (this.tileEmittersStale) this.refreshTileEmitters();

    const out = this.visibleEmitters;
    out.length = 0;
    const hidden = this.plumeCellHidden;
    if (view.particleEmitters) keepVisiblePlumes(view.particleEmitters, hidden, out);
    if (this.tileEmittersByLevel.size === 0 && this.liveTransitions.size === 0) return out;

    appendVisibleTileEmitters(this.tileEmittersByLevel, this.cameraWindow(view), hidden, out);
    const board = out.length;
    appendTransitionEmitters(out, this.liveTransitions.values(), this.animClock);
    let kept = board;
    for (let i = board; i < out.length; i++) {
      const spec = out[i]!;
      if (!hidden(Math.floor(spec.cx), Math.floor(spec.cy), spec.z)) out[kept++] = spec;
    }
    out.length = kept;
    return out;
  }

  private readonly plumeCellHidden: CellHidden = (x, y, z) => {
    const view = this.view;
    if (!view || view.viewerZ === undefined) return cutHides(this.roofCut, x, y, z);
    return !isCellVisible(view.map, view.tilesById, { x, y, z }, view.viewerZ, this.roofCut);
  };

  setLightingEnabled(enabled: boolean) {
    if (enabled === this.lightingEnabled) return;
    this.lightingEnabled = enabled;
    this.shownLightGrid = null;
    for (const u of this.lightUniformsByZ.values()) {
      u.uLightingEnabled.value = enabled ? 1 : 0;
    }
    if (enabled) {
      this.lighting.invalidateAll();
      this.staticLightGrid = null;
      this.lightingKey = "";
    }
    this.needsRender = true;
  }

  isCellPitchBlack(x: number, y: number, z: number): boolean {
    if (!this.lightingEnabled || !this.shownLightGrid || !this.pendingAmbient) return false;
    return isPitchBlack(this.shownLightGrid, this.pendingAmbient, x, y, z);
  }

  quadAssets(): SpriteQuadAssets {
    return {
      tilesetById: this.tilesetById,
      textures: this.textures,
      fallbackTexture: this.magentaTex,
      frameIndices: this.frameIndices,
    };
  }

  setOverlays(specs: OverlaySpec[]) {
    const sig = specs.map((spec) => this.overlayKey(spec)).join("|");
    if (sig === this.overlaySig) return;
    this.overlaySig = sig;

    disposeGroupChildren(this.overlays, this.outlineMaterials);
    this.pulsingOutlines = [];
    this.followingOutlines = [];
    for (const spec of specs) this.addOverlay(spec);
    this.applyPulse();
    this.overlays.updateMatrixWorld(true);
    this.needsRender = true;
  }

  private syncFollowingOutlines() {
    for (const { outline, source } of this.followingOutlines) {
      outline.matrix.copy(source.matrixWorld);
      outline.matrixWorld.copy(source.matrixWorld);
    }
  }

  setDebugView(on: boolean) {
    if (on === this.debugOn) return;
    this.debugOn = on;
    this.renderer.info.autoReset = !on;
    if (!on) {
      disposeGroupChildren(this.debugWindows);
      if (this.debugPlayRect) {
        this.overlayScene.remove(this.debugPlayRect);
        disposeGroupChildren(this.debugPlayRect);
        this.debugPlayRect = null;
      }
      this.debugWindowKey = null;
      this.debugHeldMap = null;
      this.debugHeldColumns = [];
    }
    this.needsRender = true;
  }

  private syncDebugOverlay(view: WorldView) {
    const square = view.playSquare;
    if (!square) return;
    this.placeDebugPlayRect(square);

    const light = this.lightWindow(view);
    const key = `${rectSignature(this.meshedWindow)}|${rectSignature(light)}`;
    const nowMs = performance.now();
    const mapMoved = view.map !== this.debugHeldMap;
    const due = nowMs - this.debugReadAtMs >= DEBUG_READ_INTERVAL_MS;
    if (key === this.debugWindowKey && !(mapMoved && due)) return;
    if (mapMoved && due) {
      this.debugHeldMap = view.map;
      this.debugHeldColumns = heldChunkColumns(view.map);
      this.debugReadAtMs = nowMs;
    }
    this.debugWindowKey = key;

    disposeGroupChildren(this.debugWindows);
    const frame = this.drawnWindow(view);
    for (const column of this.debugHeldColumns) {
      if (!columnTouches(column, frame)) continue;
      this.addDebugRect(chunkColumnRectPx(column), DEBUG_COLORS.held, {
        opacity: DEBUG_HELD_GRID_OPACITY,
        depth: 0,
      });
    }
    const held = boundsOfColumns(this.debugHeldColumns);
    if (held) {
      this.addDebugRect(rectPx(held), DEBUG_COLORS.held, { heavy: true, depth: 1 });
    }
    this.addDebugRect(rectPx(light), DEBUG_COLORS.light, { depth: 2 });
    for (const column of builtChunkColumns(this.chunkGeometry.keys())) {
      if (!columnTouches(column, frame)) continue;
      this.addDebugRect(inset(chunkColumnRectPx(column), DEBUG_GRID_INSET), DEBUG_COLORS.mesh, {
        opacity: DEBUG_MESH_GRID_OPACITY,
        depth: 3,
      });
    }
    this.debugWindows.updateMatrixWorld(true);
    this.needsRender = true;
  }

  private addDebugRect(
    rect: PxRect,
    color: number,
    { heavy = false, opacity = 1, depth = 0 }: DebugRectStyle,
  ) {
    for (const line of makeRectOutline(rect.x, rect.y, rect.w, rect.h, color, heavy, opacity)) {
      line.renderOrder += depth;
      this.debugWindows.add(line);
    }
  }

  private placeDebugPlayRect(square: { x: number; y: number; sizePx: number }) {
    if (!this.debugPlayRect) {
      const group = new THREE.Group();
      group.matrixAutoUpdate = false;
      for (const line of makeRectOutline(
        0,
        0,
        square.sizePx,
        square.sizePx,
        DEBUG_COLORS.play,
        true,
      )) {
        line.renderOrder += DEBUG_PLAY_DEPTH;
        group.add(line);
      }
      this.overlayScene.add(group);
      this.debugPlayRect = group;
    }
    this.debugPlayRect.position.set(square.x, square.y, 0);
    this.debugPlayRect.updateMatrix();
    this.debugPlayRect.updateMatrixWorld(true);
  }

  debugReading(): DebugReading | null {
    if (!this.debugOn || !this.view?.playSquare) return null;
    const square = this.view.playSquare;
    const light = this.lightWindow(this.view);
    const held = boundsOfColumns(this.debugHeldColumns);
    const columns = builtChunkColumns(this.chunkGeometry.keys());
    const mesh = boundsOfColumns(columns);
    return {
      meshChunks: this.chunkGeometry.size,
      meshColumns: columns.length,
      meshReachCells: mesh ? reachInCells(mesh, square) : 0,
      lightChunks: this.lighting.cachedChunks,
      lightStale: this.lighting.staleChunks,
      lightReachCells: reachInCells(light, square),
      heldColumns: this.debugHeldColumns.length,
      heldReachCells: held ? reachInCells(held, square) : null,
      drawCalls: this.debugFrameCalls,
      triangles: this.debugFrameTriangles,
    };
  }

  private applyPulse() {
    if (this.pulsingOutlines.length === 0) return;
    const alpha = pulseAlphaAt(this.pulseElapsedMs);
    for (const material of this.pulsingOutlines) {
      material.uniforms[OUTLINE_ALPHA_UNIFORM]!.value = alpha;
    }
  }

  private overlayKey(spec: OverlaySpec): string {
    const key = overlaySpecKey(spec);
    if (spec.kind === "ghost") return key;
    const map = this.view?.map;
    const placed = map && getStack(map, spec.x, spec.y, spec.z)[spec.stackIndex];
    const count = placed ? countOf(placed) : 1;
    return count > 1 ? `${key}x${count}` : key;
  }

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
    if (spec.kind === "ghost") {
      this.addGhost(spec);
      return;
    }
    for (const outline of this.outlinesFor(spec)) {
      if (spec.pulse) {
        this.pulsingOutlines.push(outline.material as THREE.ShaderMaterial);
      }
      this.overlays.add(outline);
    }
  }

  private outlinesFor(spec: ObjectOutlineOverlay): THREE.Mesh[] {
    const key = this.tileKey(spec);
    const source = this.movableMeshes.get(key);
    if (source) {
      const outline = makeFollowingSpriteOutline(source, spec.color, this.outlineMaterials);
      if (!outline) return [];
      this.followingOutlines.push({ outline, source });
      return [outline];
    }

    const subject = this.overlaySubject(spec);
    if (!subject) return [];
    const quad = spriteQuadFor(
      this.quadAssets(),
      subject.map,
      { x: spec.x, y: spec.y, z: spec.z, elevation: subject.elevation },
      subject.placed,
      subject.def,
    );
    if (!quad) return [];
    return pileRings(countOf(subject.placed)).map(({ at, peers }) =>
      makeSpriteOutline(
        { ...quad, x: quad.x + at.dx, y: quad.y + at.dy },
        spec.color,
        this.outlineMaterials,
        peers,
      ),
    );
  }

  private addGhost(spec: TileGhostOverlay) {
    const map = this.view?.map;
    const def = this.tilesById[spec.tileId];
    if (!map || !def) return;

    const stack = getStack(map, spec.x, spec.y, spec.z);
    const quad = spriteQuadFor(
      this.quadAssets(),
      map,
      {
        x: spec.x,
        y: spec.y,
        z: spec.z,
        elevation: stackHeight(stack, this.tilesById),
      },
      { tileId: spec.tileId },
      def,
    );
    if (!quad) return;
    this.overlays.add(makeSpriteGhost(quad, spec.alpha));
  }

  private applyRoofCut(cut: RoofCut | undefined) {
    if (cut === this.roofCut) return;
    this.roofCut = cut;
    for (const [z, group] of this.levelGroups) {
      group.visible = !cutHidesWholeLevel(cut, z);
    }
    for (const z of this.cutUniformsByZ.keys()) this.writeCutMask(z);
  }

  private writeCutMask(z: number) {
    const u = this.cutUniformsByZ.get(z);
    if (!u) return;

    const cut = this.roofCut;
    const mask = cut && cut.cells !== null && z > cut.floor ? cutMaskFor(cut.cells.get(z)) : null;
    if (!mask) {
      u.uCutEnabled.value = 0;
      return;
    }

    const texture = new THREE.DataTexture(mask.data, mask.w, mask.h, THREE.RedFormat);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;

    this.cutTextures.get(z)?.dispose();
    this.cutTextures.set(z, texture);
    u.uCutMask.value = texture;
    u.uCutOrigin.value.set(mask.x0, mask.y0);
    u.uCutSize.value.set(mask.w, mask.h);
    u.uCutEnabled.value = 1;
  }

  get animTimeMs(): number {
    return this.animClock;
  }

  tick(dt: number) {
    if (this.pulsingOutlines.length > 0) {
      this.pulseElapsedMs += dt;
      this.applyPulse();
      this.needsRender = true;
    }
    this.animClock += dt;
    if (this.liveTransitions.size > 0) {
      this.advanceTransitions();
      this.needsRender = true;
    }
    if (this.particles.active) {
      this.particles.update(dt, this.plumeCellHidden);
      this.needsRender = true;
    }
    if (!this.updateAnimations()) return;
    this.needsRender = true;
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

  setOnNextFrame(cb: (() => void) | null) {
    this.onNextFrame = cb;
  }

  renderOnce() {
    if (this.disposed) return;
    if (!this.assetsReady) return;
    this.updateCanvasSize();
    if (this.view) {
      this.applyCamera(this.view.camera.x, this.view.camera.y, this.view.zoom);
    }
    const r = this.renderer;
    if (this.debugOn) r.info.reset();

    const target = this.palettePass.sceneTarget(r);
    r.setRenderTarget(target);
    r.setClearColor(VOID_BACKGROUND, 1);
    r.clear();
    r.render(this.scene, this.camera);
    this.palettePass.blitToCanvas(r);

    if (this.overlays.children.length > 0 || this.debugOn) {
      this.syncFollowingOutlines();
      r.autoClear = false;
      r.render(this.overlayScene, this.camera);
      r.autoClear = true;
    }

    if (this.debugOn) {
      this.debugFrameCalls = r.info.render.calls;
      this.debugFrameTriangles = r.info.render.triangles;
    }

    const painted = this.onNextFrame;
    this.onNextFrame = null;
    painted?.();
  }

  isReady(): boolean {
    return !this.disposed && this.assetsReady && this.prevMap !== null;
  }

  dispose() {
    this.disposed = true;
    this.stop();
    this.resizeObserver?.disconnect();
    this.palettePass.dispose();
    this.particles.dispose();
    this.tintedMeshes.clear();
    disposeGroupChildren(this.overlays, this.outlineMaterials);
    disposeGroupChildren(this.debugWindows);
    this.debugPlayRect = null;
    this.outlineMaterials.dispose();
    disposeGroupChildren(this.projectileGroup);
    this.projectileMeshes.clear();
    this.retireAllTransitions();
    /**
     * Dropped with the meshes they belong to: a disposed material written to
     * on a stray tick is a use-after-free as far as WebGL is concerned.
     */
    this.pulsingOutlines = [];
    this.followingOutlines = [];
    this.renderer.dispose();
    this.lightBaker?.dispose();
    this.lightBaker = null;
    for (const tex of this.textures.values()) tex.dispose();
    for (const mat of this.materials.values()) mat.dispose();
    for (const tex of this.lightTextures.values()) tex.dispose();
    for (const tex of this.cutTextures.values()) tex.dispose();
    for (const table of this.animTablesByZ.values()) table.dispose();
    this.magentaTex.dispose();
    this.whiteTex.dispose();
  }

  private tileKey(k: TileInstanceKey): string {
    return tileInstanceKey(k);
  }

  private applyTileMotions(
    motions: TileMotion[] | undefined,
    wading: ReadonlyMap<string, number> | undefined,
  ) {
    const byKey = new Map<string, TileMotion>();
    for (const m of motions ?? []) byKey.set(this.tileKey(m), m);
    this.currentMotions = byKey;

    const activeGhosts = new Set<string>();

    for (const [key, mesh] of this.movableMeshes) {
      const base = this.movableBasePos.get(key);
      const baseBox = this.movableBaseBox.get(key);
      if (!base || !baseBox) continue;

      const motion = byKey.get(key);
      const wade = wading?.get(key) ?? 0;
      const sinkPx = Math.round(wade * WADE_SINK_PX);
      const edgePx = Math.round(wade * WADE_EDGE_PX);
      mesh.position.x = base.x + (motion?.ox ?? 0) + sinkPx;
      mesh.position.y = base.y + (motion?.oy ?? 0) + sinkPx;
      writeWadeAttr(mesh.geometry, sinkPx, edgePx);
      mesh.renderOrder = edgePx > 0 ? WADING_RENDER_ORDER : 0;
      writeBoxAttr(
        mesh.geometry,
        motion
          ? depthBox(motion.box.x, motion.box.y, motion.box.foot, motion.box.top)
          : baseBox.box,
        motion ? motion.box.stackBias : baseBox.stackBias,
      );
      /**
       * The scene has matrixWorldAutoUpdate false, so world matrices are not
       * recomputed automatically: without this the mesh never moves on
       * screen despite its position changing.
       */
      mesh.updateMatrix();
      mesh.updateMatrixWorld(true);

      const ghostZ = this.transitioningMeshes.has(mesh) ? undefined : motion?.alsoDrawAtZ;
      if (ghostZ != null) {
        activeGhosts.add(key);
        const ghost = this.ensureMotionGhost(key, mesh, ghostZ);
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

  private applyProjectiles(views: ProjectileView[] | undefined) {
    if (views === undefined && this.projectileMeshes.size === 0) return;

    const live = new Set<string>();
    for (const view of views ?? []) {
      const entry = this.projectileMesh(view);
      if (!entry) continue;
      live.add(view.id);
      this.placeProjectile(entry, view);
    }

    for (const [id, entry] of this.projectileMeshes) {
      if (live.has(id)) continue;
      this.projectileGroup.remove(entry.mesh);
      disposeObject3D(entry.mesh);
      this.projectileMeshes.delete(id);
    }
  }

  private projectileMesh(view: ProjectileView): ProjectileMesh | null {
    const existing = this.projectileMeshes.get(view.id);
    if (existing) return existing;

    const def = this.tilesById[view.tileId];
    if (!def) return null;
    const frames = getFrames(def, { direction: view.direction });
    if (!frames?.length) return null;
    const tileset = this.tilesetById.get(def.anchor.tilesetId);
    if (!tileset) return null;

    const texture = this.textures.get(tileset.id) ?? this.magentaTex;
    const rect = spriteRect(def.anchor, frames[0]!.sprite);
    const uniforms = wearsFlightTransition(def) ? noTransitionUniforms() : null;
    const quad: Omit<Quad, "x" | "y"> = {
      w: rect.w * CELL_SIZE,
      h: rect.h * CELL_SIZE,
      ...frameUvs(def.anchor, frames[0]!, tileset),
      box: depthBox(view.x, view.y, view.elevAbs, view.elevAbs),
      stackBias: 0,
      lightX0: view.x,
      lightY0: view.y,
      lightX1: view.x + 1,
      lightY1: view.y + 1,
      unlit: tileCanEmitLight(def),
    };

    const mesh = new THREE.Mesh(
      buildSingleQuadGeometry(quad),
      uniforms
        ? this.transitionMaterial(texture, view.z, uniforms)
        : this.materialFor(texture, view.z),
    );
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    this.projectileGroup.add(mesh);

    const entry: ProjectileMesh = {
      mesh,
      def,
      frames,
      tileset,
      texture,
      frameIdx: -1,
      z: view.z,
      w: quad.w,
      h: quad.h,
      direction: view.direction,
      base: { ...frames[0]!.sprite.base },
      uniforms,
    };
    this.projectileMeshes.set(view.id, entry);
    return entry;
  }

  private placeProjectile(entry: ProjectileMesh, view: ProjectileView) {
    if (view.direction !== entry.direction) {
      const turned = getFrames(entry.def, { direction: view.direction });
      if (turned?.length) {
        entry.direction = view.direction;
        entry.frames = turned;
        entry.frameIdx = -1;
      }
    }
    const frameIdx = frameIndexAtTime(entry.frames, this.animClock);
    const frame = entry.frames[frameIdx]!;
    if (frameIdx !== entry.frameIdx) {
      entry.frameIdx = frameIdx;
      writeFrameUvs(entry.mesh, entry.def.anchor, frame, entry.tileset);
    }

    if (view.z !== entry.z) {
      entry.z = view.z;
      if (entry.uniforms) {
        (entry.mesh.material as THREE.Material).dispose();
        entry.mesh.material = this.transitionMaterial(entry.texture, view.z, entry.uniforms);
      } else {
        entry.mesh.material = this.materialFor(entry.texture, view.z);
      }
    }
    entry.mesh.visible = !cutHides(this.roofCut, view.x, view.y, view.z);

    const localElev = view.elevAbs - view.z * HEIGHT_PER_LEVEL;
    const baseOrigin = baseCellWorldOrigin(view.x, view.y, view.z, localElev);
    const origin = spriteWorldOrigin(baseOrigin, entry.base);
    const centreX = origin.x + entry.w / 2;
    const centreY = origin.y + entry.h / 2;
    entry.mesh.position.set(centreX, centreY, 0);
    if (entry.uniforms) this.wearFlightSide(entry, view, centreX, centreY);
    entry.mesh.updateMatrix();
    entry.mesh.updateMatrixWorld(true);

    writeBoxAttr(
      entry.mesh.geometry,
      depthBox(view.x, view.y, view.elevAbs, view.elevAbs + entry.def.height),
      depthStackBias(view.z, PROJECTILE_STACK_BIAS),
    );
    writeLightUvAttr(entry.mesh.geometry, view.x, view.y, view.x + 1, view.y + 1);
  }

  private wearFlightSide(
    entry: ProjectileMesh,
    view: ProjectileView,
    centreX: number,
    centreY: number,
  ) {
    const uniforms = entry.uniforms;
    if (!uniforms) return;
    const phase = view.phase;
    if (!phase) {
      writeTransitionUniforms(uniforms, null);
      entry.mesh.scale.set(1, 1, 1);
      return;
    }

    writeTransitionUniforms(
      uniforms,
      {
        note: {
          id: view.id,
          side: phase.side === "appear" ? "appear" : "disappear",
          tileId: view.tileId,
          x: view.x,
          y: view.y,
          z: view.z,
          stackIndex: 0,
        },
        transition: phase.transition,
        startMs: 0,
      },
      { centreX, centreY, w: entry.w, h: entry.h },
    );
    uniforms.uFxShown.value = phase.shown;
    const scale = phase.transition.scale ? phase.shown : 1;
    entry.mesh.scale.set(scale, scale, 1);
  }

  private ensureLevelGroup(z: number): THREE.Group {
    let group = this.levelGroups.get(z);
    if (group) return group;
    group = new THREE.Group();
    group.name = `level:${z}`;
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    group.visible = !cutHidesWholeLevel(this.roofCut, z);
    this.world.add(group);
    this.levelGroups.set(z, group);
    return group;
  }

  private ensureMotionGhost(key: string, source: THREE.Mesh, z: number): THREE.Mesh {
    const existing = this.motionGhosts.get(key);
    if (existing && existing.userData.drawOnZ === z) return existing;
    this.disposeMotionGhost(key);

    const mat = source.material as THREE.MeshBasicMaterial;
    const texture = mat.map ?? this.magentaTex;
    const ghost = new THREE.Mesh(source.geometry.clone(), this.materialFor(texture, z));
    ghost.frustumCulled = false;
    ghost.matrixAutoUpdate = false;
    ghost.userData.drawOnZ = z;
    this.ensureLevelGroup(z).add(ghost);
    this.motionGhosts.set(key, ghost);
    return ghost;
  }

  private syncMotionGhost(ghost: THREE.Mesh, source: THREE.Mesh) {
    ghost.position.copy(source.position);
    ghost.renderOrder = source.renderOrder;
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

  private applyMap(map: MapFile, window: WorldRect, force: boolean) {
    const mapMoved = force || map !== this.prevMap;
    if (!mapMoved && sameRect(this.meshedWindow, window)) return;
    if (mapMoved) this.overlaySig = null;
    if (force || !this.prevMap) this.discardGeometry();
    this.syncChunks(map, window);
  }

  private bindResize() {
    this.resizeObserver = new ResizeObserver(() => {
      this.updateCanvasSize();
      this.needsRender = true;
    });
    this.resizeObserver.observe(this.canvas);
    this.updateCanvasSize();
  }

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
    this.renderer.setSize(w, h, false);
  }

  private async preloadTextures() {
    await Promise.all(
      this.tilesets.map(async (ts) => {
        if (this.textures.has(ts.id)) return;
        const loader = new THREE.TextureLoader();
        try {
          const tex = await loader.loadAsync(tilesetUrl(ts.file));
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

  private ensureAnimUniforms(z: number): LevelAnimUniforms {
    let u = this.animUniformsByZ.get(z);
    if (!u) {
      u = noAnimUniforms(this.whiteTex);
      this.animUniformsByZ.set(z, u);
    }
    return u;
  }

  private ensureAnimTable(z: number): AnimationTable {
    let table = this.animTablesByZ.get(z);
    if (!table) {
      table = new AnimationTable();
      this.animTablesByZ.set(z, table);
    }
    return table;
  }

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

  private ensureCutUniforms(z: number): LevelCutUniforms {
    let u = this.cutUniformsByZ.get(z);
    if (!u) {
      u = noCutUniforms(this.whiteTex);
      this.cutUniformsByZ.set(z, u);
      this.writeCutMask(z);
    }
    return u;
  }

  private ensureLightUniforms(z: number): LevelLightUniforms {
    let u = this.lightUniformsByZ.get(z);
    if (!u) {
      u = {
        uLightMap: { value: this.whiteTex },
        uLightOrigin: { value: new THREE.Vector2(0, 0) },
        uLightSize: { value: new THREE.Vector2(1, 1) },
        uLightingEnabled: { value: this.lightingEnabled ? 1 : 0 },
        uAmbient: { value: new THREE.Vector3(0, 0, 0) },
      };
      this.lightUniformsByZ.set(z, u);
    }
    return u;
  }

  private materialFor(
    texture: THREE.Texture,
    z: number,
    tint: StatusTint | null = null,
  ): THREE.MeshBasicMaterial {
    const key = `${texture.uuid}:${z}:${tintCacheKey(tint)}`;
    let mat = this.materials.get(key);
    if (!mat) {
      const lightUniforms = this.ensureLightUniforms(z);
      const cutUniforms = this.ensureCutUniforms(z);
      const tintU = tint && tint.strength > 0 ? tintUniforms(tint) : noTintUniforms();
      mat = new THREE.MeshBasicMaterial({
        map: texture,
        side: THREE.DoubleSide,
      });
      mat.onBeforeCompile = (shader) => {
        injectWorldShader(shader, lightUniforms, tintU, cutUniforms, this.ensureAnimUniforms(z));
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

  private lightWindow(view: WorldView): WorldRect {
    const base = this.cameraWindow(view);
    return {
      x0: base.x0 + MIN_LEVEL - LIGHT_WINDOW_MARGIN,
      y0: base.y0 + MIN_LEVEL - LIGHT_WINDOW_MARGIN,
      x1: base.x1 + MAX_LEVEL + LIGHT_WINDOW_MARGIN,
      y1: base.y1 + MAX_LEVEL + LIGHT_WINDOW_MARGIN,
    };
  }

  private cameraWindow(view: WorldView): WorldRect {
    const square = view.playSquare;
    const x = square?.x ?? view.camera.x;
    const y = square?.y ?? view.camera.y;
    const w = square?.sizePx ?? this.canvasW / view.zoom;
    const h = square?.sizePx ?? this.canvasH / view.zoom;
    return {
      x0: Math.floor(x / CELL_SIZE),
      y0: Math.floor(y / CELL_SIZE),
      x1: Math.floor((x + w) / CELL_SIZE),
      y1: Math.floor((y + h) / CELL_SIZE),
    };
  }

  private drawnWindow(view: WorldView): WorldRect {
    const w = this.canvasW / view.zoom;
    const h = this.canvasH / view.zoom;
    return {
      x0: Math.floor(view.camera.x / CELL_SIZE),
      y0: Math.floor(view.camera.y / CELL_SIZE),
      x1: Math.floor((view.camera.x + w) / CELL_SIZE),
      y1: Math.floor((view.camera.y + h) / CELL_SIZE),
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
      this.lightBaker?.dispose();
      this.lightBaker = null;
      if (canBakeOffThread()) {
        this.lightBaker = new WorkerChunkBaker(Object.values(view.tilesById), dynamicIds, view.map);
        this.lighting.setBaker(this.lightBaker);
      }
    }

    this.lightBaker?.syncMap(view.map);

    const ambient = sampleIllumination(view.minutesOfDay).ambient;
    for (const u of this.lightUniformsByZ.values()) {
      u.uAmbient.value.set(ambient[0], ambient[1], ambient[2]);
    }
    this.pendingAmbient = ambient;

    const base = this.lighting.packedGridFor(view.map, this.lightWindow(view), this.animClock);

    const overrides = this.withFadingLights(view, base);
    const overridesKey = [
      emitterOverridesKey(overrides),
      ...this.flickeringDynamicDefs.map((def) => tileEmissionPhase(def, this.animClock)),
    ].join("|");
    if (base === this.staticLightGrid && overridesKey === this.lightingKey) {
      return;
    }
    this.staticLightGrid = base;
    this.lightingKey = overridesKey;

    if (!overrides?.length) {
      this.uploadPackedGrid(base);
      return;
    }

    this.uploadPackedGrid(
      overlayEmitterOverridesPacked(base, view.map, view.tilesById, overrides, this.animClock),
    );
  }

  private uploadPackedGrid(grid: PackedLightGrid) {
    this.shownLightGrid = grid;
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

  private uploadPackedLevel(z: number, level: PackedLevelLight) {
    const u = this.ensureLightUniforms(z);
    if (this.pendingAmbient) {
      const a = this.pendingAmbient;
      u.uAmbient.value.set(a[0], a[1], a[2]);
    }
    u.uLightOrigin.value.set(level.x0 - LIGHT_MAP_CELL_OFFSET, level.y0 - LIGHT_MAP_CELL_OFFSET);
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

  private discardGeometry() {
    this.clearMotionGhosts();
    this.retireAllTransitions();
    for (const child of [...this.world.children]) {
      if (
        child === this.projectileGroup ||
        child === this.transitionGroup ||
        child === this.particles.mesh
      ) {
        continue;
      }
      this.world.remove(child);
      disposeObject3D(child);
    }
    this.levelGroups.clear();
    this.chunkGeometry.clear();
    for (const table of this.animTablesByZ.values()) table.dispose();
    this.animTablesByZ.clear();
    for (const u of this.animUniformsByZ.values()) u.uAnimEnabled.value = 0;
    this.meshedWindow = null;
    this.tileEmittersByLevel.clear();
    this.tileEmittersStale = false;
    this.animated = [];
    this.animatedByKey.clear();
    this.movableMeshes.clear();
    this.movableBasePos.clear();
    this.movableBaseBox.clear();
  }

  private syncChunks(next: MapFile, window: WorldRect) {
    const prev = this.prevMap;
    const wanted = visibleChunkKeys(next, window);
    const dirty = prev ? this.dirtyChunks(prev, next, wanted) : wanted;

    for (const key of [...this.chunkGeometry.keys()]) {
      if (!wanted.has(key)) this.dropChunk(key);
    }

    let meshesChanged = false;
    for (const key of wanted) {
      const { z, chunk } = parseChunkAddress(key);
      const built = this.chunkGeometry.get(key);
      if (built && dirty.has(key)) {
        this.dropChunk(key);
        this.buildChunk(next, z, chunk);
        meshesChanged = true;
        continue;
      }
      if (!built) {
        this.buildChunk(next, z, chunk);
        meshesChanged = true;
        continue;
      }
      if (prev && getChunk(prev, z, chunk) === getChunk(next, z, chunk)) continue;
      this.patchChunkSeparates(prev!, next, built);
      meshesChanged = true;
    }

    this.rebuildAnimatedIndex();
    if (meshesChanged) this.world.updateMatrixWorld(true);
    this.prevMap = next;
    this.meshedWindow = window;
  }

  private dirtyChunks(prev: MapFile, next: MapFile, wanted: ReadonlySet<string>): Set<string> {
    const dirty = new Set<string>();
    if (prev === next) return dirty;

    for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
      if (prev.levels[levelKey(z)] === next.levels[levelKey(z)]) continue;
      const changed = changedCellsOnLevel(prev, next, z);
      if (changed.size === 0) continue;

      if (changed.size > MAX_ANALYSED_CELLS) {
        for (const key of withNeighbourRing(changed)) {
          const { x, y } = parseCoordKey(key);
          const addr = chunkAddressKey(z, chunkKeyFor(x, y));
          if (wanted.has(addr)) dirty.add(addr);
        }
        continue;
      }

      for (const key of this.restyled(prev, next, z, changed)) {
        const { x, y } = parseCoordKey(key);
        const addr = chunkAddressKey(z, chunkKeyFor(x, y));
        if (!wanted.has(addr) || dirty.has(addr)) continue;
        if (this.mergedSignatureAt(prev, z, x, y) !== this.mergedSignatureAt(next, z, x, y)) {
          dirty.add(addr);
        }
      }
    }
    return dirty;
  }

  private restyled(
    prev: MapFile,
    next: MapFile,
    z: number,
    changed: ReadonlySet<string>,
  ): Set<string> {
    if (this.autotileVocabFor !== this.tilesById) {
      this.autotileVocab = autotileVocabulary(this.tilesById);
      this.autotileVocabFor = this.tilesById;
    }
    const vocabulary = this.autotileVocab;
    if (vocabulary.size === 0) return new Set(changed);

    const out = new Set(changed);
    const restyling: string[] = [];
    for (const key of changed) {
      const { x, y } = parseCoordKey(key);
      const before = autotileInputOf(getStack(prev, x, y, z), vocabulary);
      const after = autotileInputOf(getStack(next, x, y, z), vocabulary);
      if (before !== after) restyling.push(key);
    }
    if (restyling.length === 0) return out;
    for (const key of withNeighbourRing(restyling)) out.add(key);
    return out;
  }

  private patchChunkSeparates(prev: MapFile, next: MapFile, entry: ChunkGeometry) {
    const { z, chunk } = entry;
    const changed = changedCellsInChunk(prev, next, z, chunk);
    for (const key of changed) {
      const { x, y } = parseCoordKey(key);
      this.removeSeparatesAt(entry, x, y);
      this.removeTileEmittersAt(entry, x, y);
    }
    for (const key of changed) {
      const { x, y } = parseCoordKey(key);
      for (const item of this.cellItems(next, z, x, y, getStack(next, x, y, z))) {
        if (item.emitter) {
          entry.emitters.push(item.emitter);
          this.tileEmittersStale = true;
        }
        if (!item.anim && !item.tileKey) continue;
        this.installSeparate(entry, item);
      }
    }
  }

  private dropChunk(key: string) {
    const entry = this.chunkGeometry.get(key);
    if (!entry) return;

    for (const movableKey of entry.movableKeys) {
      this.movableMeshes.delete(movableKey);
      this.movableBasePos.delete(movableKey);
      this.movableBaseBox.delete(movableKey);
      this.disposeMotionGhost(movableKey);
    }
    entry.group.parent?.remove(entry.group);
    disposeObject3D(entry.group);
    this.chunkGeometry.delete(key);
    if (entry.emitters.length > 0) this.tileEmittersStale = true;
  }

  private buildChunk(map: MapFile, z: number, chunk: string) {
    const cells = getChunk(map, z, chunk);
    if (!cells) return;

    const items: BuildItem[] = [];
    for (const cellKey in cells) {
      const { x, y } = parseCoordKey(cellKey);
      for (const item of this.cellItems(map, z, x, y, cells[cellKey]!)) {
        items.push(item);
      }
    }
    if (items.length === 0) return;

    const group = new THREE.Group();
    group.name = `chunk:${z}:${chunk}`;
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    this.ensureLevelGroup(z).add(group);

    const entry: ChunkGeometry = {
      group,
      z,
      chunk,
      animated: [],
      emitters: [],
      movableKeys: new Set(),
    };
    this.chunkGeometry.set(chunkAddressKey(z, chunk), entry);

    const animTable = this.ensureAnimTable(z);
    const staticByTex = new Map<THREE.Texture, Quad[]>();
    for (const item of items) {
      if (item.emitter) entry.emitters.push(item.emitter);
      if (item.anim || item.tileKey) {
        this.installSeparate(entry, item);
      } else {
        if (item.mergedAnim) {
          item.animRow = animTable.add(item.mergedAnim.frames, item.mergedAnim.tileset);
          item.animPhaseMs = item.mergedAnim.phaseMs;
        }
        let list = staticByTex.get(item.texture);
        if (!list) {
          list = [];
          staticByTex.set(item.texture, list);
        }
        list.push(item);
      }
    }

    this.publishAnimTable(z);

    for (const [tex, quads] of staticByTex) {
      const geo = buildMergedQuadGeometry(quads);
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, this.materialFor(tex, z));
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
    }

    if (entry.emitters.length > 0) this.tileEmittersStale = true;
  }

  private mergedSignatureAt(map: MapFile, z: number, x: number, y: number): string {
    let sig = "";
    for (const item of this.cellItems(map, z, x, y, getStack(map, x, y, z))) {
      if (item.anim || item.tileKey) continue;
      const b = item.box;
      const a = item.mergedAnim;
      sig += `${item.x},${item.y},${item.w},${item.h}|${item.u0},${item.v0},${item.u1},${item.v1}|${b.eastPx},${b.southPx},${b.foot},${b.top}|${item.stackBias}|${item.unlit ? 1 : 0}|${item.texture.uuid}|${a ? `${a.frames.length},${a.phaseMs}` : ""}~`;
    }
    return sig;
  }

  private removeSeparatesAt(entry: ChunkGeometry, x: number, y: number) {
    const prefix = `${entry.z}:${x},${y}:`;
    for (const key of entry.movableKeys) {
      if (!key.startsWith(prefix)) continue;
      const mesh = this.movableMeshes.get(key);
      if (mesh) {
        mesh.parent?.remove(mesh);
        mesh.geometry.dispose();
      }
      this.movableMeshes.delete(key);
      this.movableBasePos.delete(key);
      this.movableBaseBox.delete(key);
      this.disposeMotionGhost(key);
      entry.movableKeys.delete(key);
    }
    const kept = entry.animated.filter((inst) => !inst.key.startsWith(prefix));
    if (kept.length !== entry.animated.length) entry.animated = kept;
  }

  private removeTileEmittersAt(entry: ChunkGeometry, x: number, y: number) {
    const prefix = tileEmitterPrefix(entry.z, x, y);
    const kept = entry.emitters.filter((spec) => !spec.id.startsWith(prefix));
    if (kept.length === entry.emitters.length) return;
    entry.emitters = kept;
    this.tileEmittersStale = true;
  }

  private refreshTileEmitters() {
    this.tileEmittersStale = false;
    this.tileEmittersByLevel.clear();
    for (const entry of this.chunkGeometry.values()) {
      if (entry.emitters.length === 0) continue;
      let list = this.tileEmittersByLevel.get(entry.z);
      if (!list) {
        list = [];
        this.tileEmittersByLevel.set(entry.z, list);
      }
      for (const spec of entry.emitters) list.push(spec);
    }
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

  private cellItems(
    map: MapFile,
    z: number,
    x: number,
    y: number,
    stack: PlacedTile[],
  ): BuildItem[] {
    const items: BuildItem[] = [];
    const extents = clumpExtents(stack, this.tilesById);
    let elev = 0;

    stack.forEach((placed, stackIndex) => {
      elev = footElevation(elev, placed);

      const def = this.tilesById[placed.tileId];
      if (!def) return;

      const instanceKey = this.tileKey({ x, y, z, stackIndex });
      const state = this.spriteStates?.get(instanceKey) ?? "idle";
      const sprite = resolveTileSprite(def, {
        state,
        direction: placed.direction,
        variant: placed.variant,
        map,
        x,
        y,
        z,
      });
      const frames = sprite?.frames;
      const frameIdx = frames ? frameIndexAtTime(frames, this.animClock) : 0;
      const live = frames?.[frameIdx];
      if (!live || !frames) return;

      const tileset = this.tilesetById.get(def.anchor.tilesetId);
      if (!tileset) return;

      const animates = frames.length > 1;
      const forming = this.formingTransitionAt(x, y, z, stackIndex, placed);
      const moves = isMobileTile(def);
      const separate = moves || forming !== undefined;
      const mergedAnim =
        !separate && animates && tableCanHold(frames)
          ? {
              frames,
              tileset,
              phaseMs: sprite ? cellPhaseMs(sprite, x, y) : 0,
            }
          : undefined;
      const art = mergedAnim ? frames[0]! : live;

      const foot = absoluteElevation(z, elev);
      const baseOrigin = baseCellWorldOrigin(x, y, z, elev);
      const origin = spriteWorldOrigin(baseOrigin, art.sprite.base);
      const rect = spriteRect(def.anchor, art.sprite);
      const w = rect.w * CELL_SIZE;
      const h = rect.h * CELL_SIZE;
      const u0 = (rect.x * CELL_SIZE) / tileset.width;
      const u1 = ((rect.x + rect.w) * CELL_SIZE) / tileset.width;
      const v1 = 1 - (rect.y * CELL_SIZE) / tileset.height;
      const v0 = 1 - ((rect.y + rect.h) * CELL_SIZE) / tileset.height;
      const texture = this.textures.get(tileset.id) ?? this.magentaTex;
      const animKey = animationKey(def, placed, x, y, z, state);

      const offsets = separate ? NO_PILE_OFFSET : pileOffsets(countOf(placed));
      const stackBias = depthStackBias(z, stackIndex);
      const extent = extents[stackIndex] ?? { foot: elev, top: elev };
      const boxFoot = absoluteElevation(z, extent.foot);
      const boxTop = absoluteElevation(z, extent.top);
      const box = depthBox(
        x,
        y,
        boxFoot,
        offsets.length > 1 ? Math.max(boxTop, boxFoot + DEPTH_LEAST_BODY) : boxTop,
      );

      const emitter: ParticleEmitterSpec | undefined = def.particles
        ? {
            id: tileEmitterId(instanceKey),
            config: def.particles,
            cx: x + CELL_CENTRE,
            cy: y + CELL_CENTRE,
            footElev: foot,
            z,
            box,
            stackBias,
            taper: 1,
          }
        : undefined;

      for (let i = 0; i < offsets.length; i++) {
        const offset = offsets[i]!;
        items.push({
          x: origin.x + offset.dx,
          y: origin.y + offset.dy,
          w,
          h,
          u0,
          v0,
          u1,
          v1,
          box,
          stackBias: stackBias + pileDepthNudge(i, offsets.length),
          texture,
          lightX0: x,
          lightY0: y,
          lightX1: x + 1,
          lightY1: y + 1,
          unlit: tileCanEmitLight(def),
          tileKey: separate ? instanceKey : undefined,
          moves,
          stackIndex,
          transitionId: forming,
          pivotX: baseOrigin.x + CELL_SIZE / 2 + offset.dx,
          pivotY: baseOrigin.y + CELL_SIZE / 2 + offset.dy,
          mergedAnim,
          emitter: i === 0 ? emitter : undefined,
          anim:
            separate && (animates || hasSpriteStates(def))
              ? {
                  frames,
                  tileset,
                  animKey,
                  def,
                  placed,
                  cell: { x, y, z },
                  state,
                  frameIdx,
                }
              : undefined,
        });
      }

      elev += terrainHeight(placed, this.tilesById);
    });

    return items;
  }

  private ingestTransitions(view: WorldView) {
    const heard = view.transitions?.filter((held) => !this.liveTransitions.has(held.note.id));
    if (!heard?.length) return;
    const window = this.meshedWindow;
    const admitted = admitTransitions(heard, {
      clockMs: this.animClock,
      live: this.liveTransitions.size,
      transitionOf: (note) =>
        note.struckBy
          ? projectileEffect(view.tilesById[note.struckBy], "hit")
          : transitionOf(view.tilesById[note.tileId], note.side),
      inWindow: (note) => window !== null && cellInMeshWindow(window, note.x, note.y, note.z),
    });
    for (const live of admitted) {
      const state: TransitionState = {
        live,
        uniforms: null,
        material: null,
        meshes: [],
        gridAtStart: this.staticLightGrid,
        plumeId: null,
        plume: null,
        burst: null,
      };
      const played =
        live.note.side === "appear"
          ? this.markForming(state, view.map) || this.throwStruckBurst(state)
          : this.playOutCopy(state);
      if (played) this.liveTransitions.set(live.note.id, state);
    }
  }

  private markForming(state: TransitionState, map: MapFile): boolean {
    const { note } = state.live;
    const stack = getStack(map, note.x, note.y, note.z);
    const slot = resolveTransitionSlot(stack, note);
    const placed = slot === undefined ? undefined : stack[slot];
    if (slot === undefined || !placed) return false;
    const identity = placementIdentity(placed);
    if (identity) this.formingByPlacement.set(identity, note.id);
    else this.formingAt.set(transitionAddress({ ...note, stackIndex: slot }), note.id);
    state.plumeId = tileEmitterId(
      this.tileKey({ x: note.x, y: note.y, z: note.z, stackIndex: slot }),
    );
    const prev = this.prevMap;
    if (prev && resolveTransitionSlot(getStack(prev, note.x, note.y, note.z), note) !== undefined) {
      this.queueChunkRebuild(note.x, note.y, note.z);
    }
    return true;
  }

  private playOutCopy(state: TransitionState): boolean {
    const prev = this.prevMap;
    const { note } = state.live;
    if (!prev) return false;
    const stack = getStack(prev, note.x, note.y, note.z);
    const slot = resolveTransitionSlot(stack, note);
    if (slot === undefined) return false;
    const items = this.cellItems(prev, note.z, note.x, note.y, stack).filter(
      (item) => item.stackIndex === slot,
    );
    state.plume = items.find((item) => item.emitter)?.emitter ?? null;
    for (const item of items) {
      const mesh = this.addQuadMesh(this.transitionGroup, item, item.texture, note.z);
      mesh.visible = !cutHidesWholeLevel(this.roofCut, note.z);
      this.attachTransition(state, mesh, item, note.z, true);
    }
    return items.length > 0;
  }

  private throwStruckBurst(state: TransitionState): boolean {
    const prev = this.prevMap;
    const { note } = state.live;
    if (!prev) return false;
    const stack = getStack(prev, note.x, note.y, note.z);
    const slot = struckRemainsSlot(note, stack);
    if (slot === undefined) return false;
    const item = this.cellItems(prev, note.z, note.x, note.y, stack).find(
      (candidate) => candidate.stackIndex === slot,
    );
    if (!item) return false;
    state.burst = this.burstFor(state.live, item);
    return state.burst !== null;
  }

  private formingTransitionAt(
    x: number,
    y: number,
    z: number,
    stackIndex: number,
    placed: { tileId: string; owner?: string; itemId?: string },
  ): string | undefined {
    if (this.formingAt.size === 0 && this.formingByPlacement.size === 0) {
      return undefined;
    }
    const identity = placementIdentity(placed);
    const id = identity
      ? this.formingByPlacement.get(identity)
      : this.formingAt.get(transitionAddress({ x, y, z, stackIndex }));
    if (!id) return undefined;
    const tileId = this.liveTransitions.get(id)?.live.note.tileId;
    return tileId === placed.tileId ? id : undefined;
  }

  private attachTransition(
    state: TransitionState,
    mesh: THREE.Mesh,
    item: BuildItem,
    z: number,
    copy: boolean,
  ) {
    const centreX = item.x + item.w / 2;
    if (!state.material) {
      state.uniforms = transitionUniforms(state.live, {
        centreX,
        centreY: item.y + item.h / 2,
        w: item.w,
        h: item.h,
      });
      state.uniforms.uFxShown.value = liveShown(state.live, this.animClock);
      state.material = this.transitionMaterial(item.texture, z, state.uniforms);
      state.burst = this.burstFor(state.live, item);
    }
    mesh.material = state.material;
    const held: TransitionMesh = {
      mesh,
      texture: item.texture,
      z,
      centreX,
      centreY: item.y + item.h / 2,
      pivotX: item.pivotX,
      pivotY: item.pivotY,
      w: item.w,
      h: item.h,
      copy,
      box: item.box,
      stackBias: item.stackBias,
      moves: !copy && item.moves === true,
      tileKey: copy ? undefined : item.tileKey,
    };
    state.meshes.push(held);
    if (!copy) this.transitioningMeshes.add(mesh);
    const { scale, drop } = state.live.transition;
    if (scale || drop) {
      poseTransitionMesh(
        held,
        transitionPose(state.live.transition, liveShown(state.live, this.animClock)),
        Boolean(drop),
        this.motionOf(held),
      );
    }
  }

  private transitionMaterial(
    texture: THREE.Texture,
    z: number,
    uniforms: TransitionUniforms,
  ): THREE.MeshBasicMaterial {
    const lightUniforms = this.ensureLightUniforms(z);
    const cutUniforms = this.ensureCutUniforms(z);
    const mat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
    mat.onBeforeCompile = (shader) => {
      injectWorldShader(
        shader,
        lightUniforms,
        noTintUniforms(),
        cutUniforms,
        this.ensureAnimUniforms(z),
        uniforms,
      );
    };
    mat.customProgramCacheKey = () => WORLD_SHADER_CACHE_KEY;
    mat.alphaTest = 0.5;
    mat.transparent = true;
    mat.depthTest = true;
    mat.depthWrite = true;
    return mat;
  }

  private advanceTransitions() {
    for (const [id, state] of this.liveTransitions) {
      if (this.transitionIsOver(state)) {
        this.retireTransition(id, state);
        continue;
      }
      state.meshes = state.meshes.filter((held) => this.stillDrawn(held));
      const shown = liveShown(state.live, this.animClock);
      if (state.uniforms) state.uniforms.uFxShown.value = shown;
      const { scale, drop } = state.live.transition;
      const pose = transitionPose(state.live.transition, shown);
      for (const held of state.meshes) {
        if (scale || drop) {
          poseTransitionMesh(held, pose, Boolean(drop), this.motionOf(held));
        }
        if (held.copy) held.mesh.visible = !cutHidesWholeLevel(this.roofCut, held.z);
      }
    }
    this.flushChunkRebuilds();
  }

  private transitionIsOver(state: TransitionState): boolean {
    if (!isFinished(state.live, this.animClock)) return false;
    if (state.live.note.side !== "disappear") return true;
    return fadingLightScale(state.live, this.animClock) <= 0;
  }

  private retireTransition(id: string, state: TransitionState) {
    this.liveTransitions.delete(id);
    for (const [key, formingId] of this.formingAt) {
      if (formingId === id) this.formingAt.delete(key);
    }
    for (const [key, formingId] of this.formingByPlacement) {
      if (formingId === id) this.formingByPlacement.delete(key);
    }
    for (const held of state.meshes) this.retireMesh(state, held);
    state.material?.dispose();
    const merged = state.meshes.some(rejoinsBatch);
    if (state.live.note.side === "appear" && merged) {
      const { x, y, z } = state.live.note;
      this.queueChunkRebuild(x, y, z);
    }
  }

  private retireMesh(state: TransitionState, held: TransitionMesh) {
    this.transitioningMeshes.delete(held.mesh);
    if (held.copy) {
      held.mesh.parent?.remove(held.mesh);
      held.mesh.geometry.dispose();
      return;
    }
    if (rejoinsBatch(held) || !held.mesh.parent) return;
    const { scale, drop } = state.live.transition;
    if (scale || drop) {
      poseTransitionMesh(held, WHOLE_POSE, Boolean(drop), this.motionOf(held));
    }
    held.mesh.material = this.materialFor(held.texture, held.z);
  }

  private stillDrawn(held: TransitionMesh): boolean {
    if (held.mesh.parent !== null) return true;
    this.transitioningMeshes.delete(held.mesh);
    return false;
  }

  private motionOf(held: TransitionMesh): TileMotion | undefined {
    return held.tileKey ? this.currentMotions.get(held.tileKey) : undefined;
  }

  private retireAllTransitions() {
    for (const [id, state] of [...this.liveTransitions]) {
      for (const held of state.meshes) {
        if (!held.copy) continue;
        held.mesh.parent?.remove(held.mesh);
        held.mesh.geometry.dispose();
      }
      state.material?.dispose();
      this.liveTransitions.delete(id);
    }
    this.formingAt.clear();
    this.formingByPlacement.clear();
    this.transitioningMeshes.clear();
    this.chunksToRebuild.clear();
  }

  private queueChunkRebuild(x: number, y: number, z: number) {
    this.chunksToRebuild.add(chunkAddressKey(z, chunkKeyFor(x, y)));
  }

  private flushChunkRebuilds() {
    const map = this.prevMap;
    if (this.chunksToRebuild.size === 0 || !map) return;
    for (const key of this.chunksToRebuild) {
      if (!this.chunkGeometry.has(key)) continue;
      const { z, chunk } = parseChunkAddress(key);
      this.dropChunk(key);
      this.buildChunk(map, z, chunk);
    }
    this.chunksToRebuild.clear();
    this.rebuildAnimatedIndex();
    this.world.updateMatrixWorld(true);
  }

  private withFadingLights(view: WorldView, base: PackedLightGrid): EmitterOverride[] | undefined {
    let out: EmitterOverride[] | undefined;
    for (const { live, gridAtStart } of this.liveTransitions.values()) {
      if (live.note.side !== "disappear") continue;
      if (gridAtStart !== null && base === gridAtStart) continue;
      const def = view.tilesById[live.note.tileId];
      const light = def ? resolveLight(def, {}, 0) : undefined;
      if (!def || !light) continue;
      const scale = fadingLightScale(live, this.animClock);
      if (scale <= 0) continue;
      const { x, y, z } = live.note;
      const stack = getStack(view.map, x, y, z);
      const at = emitterCenter(x, y, z, stack, stack.length, view.tilesById);
      out ??= [...(view.emitterOverrides ?? [])];
      out.push({
        x,
        y,
        z,
        fx: at.fx,
        fy: at.fy,
        fz: at.fz + (def.height ?? 0) / 2 / HEIGHT_PER_LEVEL,
        lights: [{ ...light, intensity: light.intensity * scale }],
      });
    }
    return out ?? view.emitterOverrides;
  }

  private burstFor(live: LiveTransition, item: BuildItem): ParticleEmitterSpec | null {
    const config = live.transition.particles;
    if (!config) return null;
    const { x, y, z } = live.note;
    return {
      id: `transition:${live.note.id}`,
      config,
      cx: x + CELL_CENTRE,
      cy: y + CELL_CENTRE,
      footElev: item.box.foot,
      z,
      box: item.box,
      stackBias: item.stackBias,
      taper: 1,
    };
  }

  private installSeparate(entry: ChunkGeometry, item: BuildItem) {
    const mesh = this.addQuadMesh(entry.group, item, item.texture, entry.z);
    if (item.tileKey) {
      entry.movableKeys.add(item.tileKey);
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
      entry.animated.push({ mesh, key: item.tileKey ?? "", ...item.anim });
    }
    if (item.transitionId) {
      const state = this.liveTransitions.get(item.transitionId);
      if (state) this.attachTransition(state, mesh, item, entry.z, false);
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
    let changed = false;
    for (const [z, u] of this.animUniformsByZ) {
      if (u.uAnimEnabled.value === 0) continue;
      const table = this.animTablesByZ.get(z);
      if (table?.crossedFrame(u.uAnimClockMs.value, this.animClock)) {
        changed = true;
      }
      u.uAnimClockMs.value = this.animClock;
    }
    if (this.animatedByKey.size === 0) return changed;

    for (const [key, instances] of this.animatedByKey) {
      const sample = instances[0]!;
      const idx = frameIndexAtTime(sample.frames, this.animClock);
      this.frameIndices.set(key, idx);

      const frame = sample.frames[idx];
      if (!frame) continue;
      for (const inst of instances) {
        if (inst.frameIdx === idx) continue;
        inst.frameIdx = idx;
        writeFrameUvs(inst.mesh, sample.def.anchor, frame, sample.tileset);
        changed = true;
      }
    }
    return changed;
  }

  private applySpriteTints(tints: ReadonlyMap<string, StatusTint> | undefined) {
    if (!tints?.size && this.tintedMeshes.size === 0) return;

    for (const [key, worn] of this.tintedMeshes) {
      if (tints?.has(key)) continue;
      const drawn = this.movableMeshes.get(key) === worn.mesh;
      if (drawn && !this.transitioningMeshes.has(worn.mesh)) {
        worn.mesh.material = this.materialFor(worn.texture, worn.z, null);
      }
      this.tintedMeshes.delete(key);
    }

    for (const [key, tint] of tints ?? EMPTY_TINTS) {
      const mesh = this.movableMeshes.get(key);
      if (!mesh || this.transitioningMeshes.has(mesh)) continue;
      const tintKey = tintCacheKey(tint);
      const held = this.tintedMeshes.get(key);
      if (held && held.mesh === mesh && held.tintKey === tintKey) continue;

      const texture = held?.texture ?? (mesh.material as THREE.MeshBasicMaterial).map;
      if (!texture) continue;
      const z = tileInstanceLevel(key);
      mesh.material = this.materialFor(texture, z, tint);
      this.tintedMeshes.set(key, { mesh, texture, z, tintKey });
    }
  }

  private applySpriteStates(states: ReadonlyMap<string, SpriteState> | undefined) {
    if (this.animated.length === 0) return;
    let swapped = false;

    for (const inst of this.animated) {
      const next = states?.get(inst.key) ?? "idle";
      if (next === inst.state) continue;

      const { x, y, z } = inst.cell;
      const frames = getFrames(inst.def, {
        state: next,
        direction: inst.placed.direction,
        variant: inst.placed.variant,
        map: this.prevMap ?? undefined,
        x,
        y,
        z,
      });
      if (!frames?.length) continue;

      const idx = frameIndexAtTime(frames, this.animClock);
      inst.state = next;
      inst.frames = frames;
      inst.animKey = animationKey(inst.def, inst.placed, x, y, z, next);
      inst.frameIdx = idx;
      writeFrameUvs(inst.mesh, inst.def.anchor, frames[idx]!, inst.tileset);
      swapped = true;
    }

    if (!swapped) return;
    this.rebuildAnimatedIndex();
    this.needsRender = true;
  }
}

function frameUvs(
  anchor: SpriteAnchor,
  frame: Frame,
  tileset: TilesetDef,
): { u0: number; v0: number; u1: number; v1: number } {
  const rect = spriteRect(anchor, frame.sprite);
  return {
    u0: (rect.x * CELL_SIZE) / tileset.width,
    u1: ((rect.x + rect.w) * CELL_SIZE) / tileset.width,
    /**
     * v is flipped: the rect's y grows downward and uv's v grows upward, so
     * the sprite's top edge (the smaller rect.y) is the larger v.
     */
    v1: 1 - (rect.y * CELL_SIZE) / tileset.height,
    v0: 1 - ((rect.y + rect.h) * CELL_SIZE) / tileset.height,
  };
}

function writeFrameUvs(
  mesh: THREE.Mesh,
  anchor: SpriteAnchor,
  frame: Frame,
  tileset: TilesetDef,
): void {
  const { u0, v0, u1, v1 } = frameUvs(anchor, frame, tileset);
  const uvs = mesh.geometry.attributes.uv!;
  uvs.setXY(0, u0, v0);
  uvs.setXY(1, u1, v0);
  uvs.setXY(2, u0, v1);
  uvs.setXY(3, u1, v1);
  uvs.needsUpdate = true;
}
