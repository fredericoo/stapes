import * as THREE from "three";
import {
  absoluteElevation,
  baseCellWorldOrigin,
  spriteWorldOrigin,
  tileDepth,
} from "../lib/geometry";
import {
  AMBIENT_PRESETS,
  computeLighting,
  type LevelLightMap,
  type LightGrid,
  type TimeOfDay,
} from "../lib/lighting";
import { elevationAt, getStack, listCoords } from "../lib/mapData";
import type { Frame, MapFile, TileDef, TilesetDef } from "../lib/types";
import {
  CELL_SIZE,
  MAX_LEVEL,
  MIN_LEVEL,
  getFrames,
  levelKey,
} from "../lib/types";

type AnimatedInstance = {
  mesh: THREE.Mesh;
  frames: Frame[];
  tileset: TilesetDef;
  animKey: string;
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
  depth: number;
  lightX0: number;
  lightY0: number;
  lightX1: number;
  lightY1: number;
  unlit: boolean;
};

type LevelLightUniforms = {
  uLightMap: { value: THREE.Texture };
  uLightOrigin: { value: THREE.Vector2 };
  uLightSize: { value: THREE.Vector2 };
  uLightingEnabled: { value: number };
};

const BACKGROUND_COLOR = 0xb8b09e;
const LIGHT_MAP_CELL_OFFSET = 0.5;

/** Map cell + stack slot identifying a placed tile instance. */
export type TileInstanceKey = {
  x: number;
  y: number;
  z: number;
  stackIndex: number;
};

/**
 * Per-frame motion for a placed tile (walk/fall lerp, push, etc.).
 * Not player-specific — any tile can move. While moving, `sortAt` is combined
 * with the origin depth via max() so south/east clear the dest floor and
 * north/west stay above the tile being left.
 */
export type TileMotion = TileInstanceKey & {
  ox: number;
  oy: number;
  sortAt?: TileInstanceKey;
};

export type WorldView = {
  map: MapFile;
  tilesById: Record<string, TileDef>;
  camera: { x: number; y: number };
  zoom: number;
  timeOfDay: TimeOfDay;
  /** Active lerps; depth uses `sortAt` when set, else the tile’s built depth. */
  tileMotions?: TileMotion[];
};

function buildMergedQuadGeometry(quads: Quad[]): THREE.BufferGeometry {
  const n = quads.length;
  const positions = new Float32Array(n * 4 * 3);
  const uvs = new Float32Array(n * 4 * 2);
  const lightUvs = new Float32Array(n * 4 * 2);
  const unlit = new Float32Array(n * 4);
  const indices = n * 4 > 65535 ? new Uint32Array(n * 6) : new Uint16Array(n * 6);

  for (let i = 0; i < n; i++) {
    const q = quads[i]!;
    const x0 = q.x;
    const y0 = q.y;
    const x1 = q.x + q.w;
    const y1 = q.y + q.h;
    const z = q.depth;
    const pb = i * 12;
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

    lightUvs[ub] = q.lightX0;
    lightUvs[ub + 1] = q.lightY1;
    lightUvs[ub + 2] = q.lightX1;
    lightUvs[ub + 3] = q.lightY1;
    lightUvs[ub + 4] = q.lightX0;
    lightUvs[ub + 5] = q.lightY0;
    lightUvs[ub + 6] = q.lightX1;
    lightUvs[ub + 7] = q.lightY0;

    const u = q.unlit ? 1 : 0;
    unlit[i * 4] = u;
    unlit[i * 4 + 1] = u;
    unlit[i * 4 + 2] = u;
    unlit[i * 4 + 3] = u;

    const ib = i * 6;
    const v = i * 4;
    indices[ib] = v;
    indices[ib + 1] = v + 1;
    indices[ib + 2] = v + 2;
    indices[ib + 3] = v + 1;
    indices[ib + 4] = v + 3;
    indices[ib + 5] = v + 2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute("aLightUv", new THREE.BufferAttribute(lightUvs, 2));
  geo.setAttribute("aUnlit", new THREE.BufferAttribute(unlit, 1));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
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
  private movableBaseDepth = new Map<string, number>();
  /** Instance keys that must stay unmerged this build (active motions). */
  private motionKeys = new Set<string>();
  private animClock = 0;
  private lastAnimTime = 0;
  private frameIndices = new Map<string, number>();
  private disposed = false;
  private magentaTex: THREE.DataTexture;
  private whiteTex: THREE.DataTexture;
  private lightTextures = new Map<number, THREE.DataTexture>();
  private lightUniformsByZ = new Map<number, LevelLightUniforms>();
  private lightingKey = "";
  private lastLitMap: MapFile | null = null;
  private prevMap: MapFile | null = null;
  private needsRender = true;
  private canvasW = 0;
  private canvasH = 0;
  private resizeObserver: ResizeObserver | null = null;
  private assetsReady = false;
  private view: WorldView | null = null;
  private looping = false;
  private raf = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
    });
    this.renderer.setClearColor(BACKGROUND_COLOR, 1);
    this.renderer.setPixelRatio(1);
    this.renderer.autoClear = true;

    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = false;
    this.camera = new THREE.OrthographicCamera(0, 1, 0, 1, -10, 50);
    this.camera.position.z = 25;

    this.world = new THREE.Group();
    this.scene.add(this.world);

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
      if (this.view) this.applyMap(this.view.map, true);
      this.assetsReady = true;
      this.needsRender = true;
    });
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

    this.applyMap(view.map, motionSetChanged);
    this.updateLighting(view);
    this.applyTileMotions(view.tileMotions);
    this.needsRender = true;
  }

  /** Advance sprite animations; call from the host rAF loop. */
  tick(dt: number) {
    if (this.updateAnimations(dt)) this.needsRender = true;
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
    this.renderer.setClearColor(BACKGROUND_COLOR, 1);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
  }

  isReady(): boolean {
    return !this.disposed && this.assetsReady && this.prevMap !== null;
  }

  getCameraSize(): { canvasW: number; canvasH: number } {
    return { canvasW: this.canvasW, canvasH: this.canvasH };
  }

  dispose() {
    this.disposed = true;
    this.stop();
    this.resizeObserver?.disconnect();
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

    for (const [key, mesh] of this.movableMeshes) {
      const base = this.movableBasePos.get(key);
      const baseDepth = this.movableBaseDepth.get(key);
      if (!base || baseDepth == null) continue;

      const motion = byKey.get(key);
      if (motion) {
        mesh.position.x = base.x + motion.ox;
        mesh.position.y = base.y + motion.oy;
        // max(origin, dest): south/east use dest (clear dest floor);
        // north/west keep origin (don't slip under the tile you're leaving).
        if (motion.sortAt) {
          const destDepth = this.depthForSort(
            motion.sortAt.z,
            motion.sortAt.x,
            motion.sortAt.y,
            motion.sortAt.stackIndex,
          );
          mesh.position.z = Math.max(baseDepth, destDepth);
        } else {
          mesh.position.z = baseDepth;
        }
      } else {
        mesh.position.x = base.x;
        mesh.position.y = base.y;
        mesh.position.z = baseDepth;
      }
      // Scene has matrixWorldAutoUpdate=false — must push local → world or the
      // mesh never moves on screen despite position changing.
      mesh.updateMatrix();
      mesh.updateMatrixWorld(true);
    }
  }

  /**
   * Depth a tile would get with its feet at (x,y,z) stackIndex
   * (absolute elevation, same formula as buildLevel).
   */
  private depthForSort(
    z: number,
    x: number,
    y: number,
    stackIndex: number,
  ): number {
    const map = this.view?.map ?? this.prevMap;
    const stack = map ? getStack(map, x, y, z) : [];
    const elev = elevationAt(
      stack,
      Math.min(stackIndex, stack.length),
      this.tilesById,
    );
    return tileDepth(x, y, absoluteElevation(z, elev), stackIndex);
  }

  private applyMap(map: MapFile, force: boolean) {
    if (!force && map === this.prevMap) return;
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
        Object.assign(shader.uniforms, lightUniforms);
        shader.vertexShader = shader.vertexShader
          .replace(
            "#include <common>",
            /* glsl */ `#include <common>
attribute vec2 aLightUv;
attribute float aUnlit;
varying vec2 vLightUv;
varying float vUnlit;`,
          )
          .replace(
            "#include <uv_vertex>",
            /* glsl */ `#include <uv_vertex>
vLightUv = aLightUv;
vUnlit = aUnlit;`,
          );
        shader.fragmentShader = shader.fragmentShader
          .replace(
            "#include <common>",
            /* glsl */ `#include <common>
uniform sampler2D uLightMap;
uniform vec2 uLightOrigin;
uniform vec2 uLightSize;
uniform float uLightingEnabled;
varying vec2 vLightUv;
varying float vUnlit;`,
          )
          .replace(
            "#include <map_fragment>",
            /* glsl */ `#include <map_fragment>
if (uLightingEnabled > 0.5 && vUnlit < 0.5) {
  vec2 lightUv = (vLightUv - uLightOrigin) / uLightSize;
  vec3 light = texture2D(uLightMap, lightUv).rgb;
  diffuseColor.rgb *= light;
}`,
          );
      };
      mat.customProgramCacheKey = () => "stapes-lit-world-v1";
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

  private updateLighting(view: WorldView) {
    const key = `${view.timeOfDay}|${Object.keys(view.tilesById).length}`;
    if (view.map === this.lastLitMap && key === this.lightingKey) return;
    this.lastLitMap = view.map;
    this.lightingKey = key;

    const ambient = AMBIENT_PRESETS[view.timeOfDay];
    const grid = computeLighting(view.map, view.tilesById, [...ambient]);
    this.uploadLightGrid(grid, view.timeOfDay);
  }

  private uploadLightGrid(grid: LightGrid, timeOfDay: TimeOfDay) {
    const seen = new Set<number>();
    for (const [z, level] of grid.levels) {
      seen.add(z);
      this.uploadLevelLight(z, level);
    }
    for (const z of this.lightUniformsByZ.keys()) {
      if (seen.has(z)) continue;
      const u = this.ensureLightUniforms(z);
      u.uLightingEnabled.value = 1;
      const ambient = AMBIENT_PRESETS[timeOfDay];
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
      u.uLightOrigin.value.set(0, 0);
      u.uLightSize.value.set(1, 1);
    }
  }

  private uploadLevelLight(z: number, level: LevelLightMap) {
    const u = this.ensureLightUniforms(z);
    u.uLightingEnabled.value = 1;
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

  private rebuildAll(map: MapFile) {
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
    this.movableBaseDepth.clear();

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
        this.movableBaseDepth.delete(key);
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

        const frames = getFrames(def, placed.direction);
        const first = frames?.[0];
        if (!first) return;

        const tileset = this.tilesetById.get(first.sprite.tilesetId);
        if (!tileset) return;

        const absElev = absoluteElevation(z, elev);
        const depth = tileDepth(cell.x, cell.y, absElev, stackIndex);
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

        items.push({
          x: origin.x,
          y: origin.y,
          w,
          h,
          u0,
          v0,
          u1,
          v1,
          depth,
          texture,
          lightX0: cell.x,
          lightY0: cell.y,
          lightX1: cell.x + 1,
          lightY1: cell.y + 1,
          unlit: Boolean(
            def.light && def.light.radius > 0 && def.light.intensity > 0,
          ),
          tileKey: separate ? instanceKey : undefined,
          anim:
            isAnimated && frames
              ? {
                  frames,
                  tileset,
                  animKey: `${def.id}:${placed.direction ?? "default"}`,
                }
              : undefined,
        });

        elev += def.height;
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
          item.unlit,
        );
        if (item.tileKey) {
          this.movableMeshes.set(item.tileKey, mesh);
          this.movableBasePos.set(item.tileKey, {
            x: mesh.position.x,
            y: mesh.position.y,
          });
          this.movableBaseDepth.set(item.tileKey, item.depth);
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
    unlitFlag: boolean,
  ): THREE.Mesh {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array([
      -w / 2,
      h / 2,
      0,
      w / 2,
      h / 2,
      0,
      -w / 2,
      -h / 2,
      0,
      w / 2,
      -h / 2,
      0,
    ]);
    const uvs = new Float32Array([u0, v0, u1, v0, u0, v1, u1, v1]);
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
    const unlit = new Float32Array(4).fill(unlitFlag ? 1 : 0);
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute("aLightUv", new THREE.BufferAttribute(lightUvs, 2));
    geo.setAttribute("aUnlit", new THREE.BufferAttribute(unlit, 1));
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 1, 3, 2]), 1));

    const mat = this.materialFor(texture, z);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x + w / 2, y + h / 2, depth);
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
