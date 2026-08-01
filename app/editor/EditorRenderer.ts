import * as THREE from "three";
import {
  baseCellWorldOrigin,
  drawOrder,
  screenToCoord,
  spriteWorldOrigin,
} from "../lib/geometry";
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
  CHUNK_SIZE,
  MAX_LEVEL,
  MIN_LEVEL,
  getFrames,
} from "../lib/types";
import { canReplaceStack } from "../lib/validation";
import { useEditorStore, type ToolId } from "./store";

type AnimatedInstance = {
  mesh: THREE.Mesh;
  tileId: string;
  direction?: string;
  tilesetId: string;
  frames: Frame[];
  tileset: TilesetDef;
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

const BACKGROUND_COLOR = 0xb8b09e;

const GHOST_OPACITY = 0.55;
/** Big shapes fall back to outlines only — one mesh per sprite gets costly. */
const MAX_GHOST_CELLS = 256;

function chunkId(z: number, cx: number, cy: number) {
  return `${z}:${cx},${cy}`;
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
 * The target holds premultiplied linear colour, so we encode to the output
 * colour space first and then scale the whole (already premultiplied) texel.
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
        gl_FragColor = texture2D(tLevel, vUv);
        #include <colorspace_fragment>
        gl_FragColor *= uOpacity;
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
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
  private tilesets: TilesetDef[] = [];
  private tilesById: Record<string, TileDef> = {};
  private chunkMeshes = new Map<string, THREE.Group>();
  private levelGroups = new Map<number, THREE.Group>();
  private levelTarget: THREE.WebGLRenderTarget | null = null;
  private compositeScene: THREE.Scene;
  private compositeCamera: THREE.Camera;
  private compositeMaterial: THREE.ShaderMaterial;
  private drawBufferSize = new THREE.Vector2();
  private animated: AnimatedInstance[] = [];
  private animClock = 0;
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
  private rebuildKey = "";
  private gridLevel = Number.NaN;

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

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1000, 1000);
    this.camera.position.z = 10;

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

    this.bindEvents();
    this.unsub = useEditorStore.subscribe(() => {
      this.syncFromStore();
    });
    this.syncFromStore(true);
    this.loop();
  }

  setAssets(tilesets: TilesetDef[], tilesById?: Record<string, TileDef>) {
    this.tilesets = tilesets;
    if (tilesById) this.tilesById = tilesById;
    void this.preloadTextures()
      .then(() => {
        // Always rebuild from the live store so we don't race hydrate.
        this.tilesById = useEditorStore.getState().tilesById;
        this.rebuildKey = "";
        this.rebuildAll();
      })
      .catch((err) => {
        console.error("Failed to load tileset textures", err);
      });
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.unsub?.();
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
    this.magentaTex.dispose();
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
      this.rebuildKey = key;
      this.rebuildAll();
    }
  }

  private applyCamera(camX: number, camY: number, zoom: number) {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(w, h, false);
    const viewW = w / zoom;
    const viewH = h / zoom;
    this.camera.left = camX;
    this.camera.right = camX + viewW;
    // Y grows down in our world. top < bottom flips Y to match screen space.
    // That also reverses face winding — tile materials use DoubleSide to compensate.
    this.camera.top = camY;
    this.camera.bottom = camY + viewH;
    this.camera.scale.set(1, 1, 1);
    this.camera.updateProjectionMatrix();
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
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.renderOrder = -1000;
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
      }),
    );
    axis.renderOrder = -999;
    this.grid.add(axis);
  }

  private drawOverlays(s: ReturnType<typeof useEditorStore.getState>) {
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

    const tileset = this.tilesets.find((t) => t.id === frame.sprite.tilesetId);
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

  private rebuildAll() {
    // Clear world
    while (this.world.children.length) {
      const g = this.world.children.pop()!;
      g.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        mesh.geometry?.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[];
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose?.();
      });
    }
    this.chunkMeshes.clear();
    this.levelGroups.clear();
    this.animated = [];

    const s = useEditorStore.getState();
    for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
      this.buildLevel(s.map, z);
    }
  }

  private buildLevel(map: MapFile, z: number) {
    const coords = listCoords(map, z);
    if (coords.length === 0) return;
    const levelGroup = new THREE.Group();
    levelGroup.name = `level:${z}`;
    this.world.add(levelGroup);
    this.levelGroups.set(z, levelGroup);
    // Group by chunk
    const byChunk = new Map<
      string,
      Array<{ x: number; y: number; stack: typeof coords[0]["stack"] }>
    >();
    for (const c of coords) {
      const cx = Math.floor(c.x / CHUNK_SIZE);
      const cy = Math.floor(c.y / CHUNK_SIZE);
      const key = chunkId(z, cx, cy);
      if (!byChunk.has(key)) byChunk.set(key, []);
      byChunk.get(key)!.push(c);
    }

    for (const [key, cells] of byChunk) {
      const group = new THREE.Group();
      group.name = key;

      type Quad = {
        x: number;
        y: number;
        w: number;
        h: number;
        u0: number;
        v0: number;
        u1: number;
        v1: number;
        order: number;
      };
      const staticByTileset = new Map<string, Quad[]>();

      for (const cell of cells) {
        let elev = 0;
        cell.stack.forEach((placed, stackIndex) => {
          const def = this.tilesById[placed.tileId];
          const order = (z + 8) * 10_000_000 + drawOrder(cell.x, cell.y, stackIndex);

          if (!def) {
            // Magenta placeholder
            const origin = baseCellWorldOrigin(cell.x, cell.y, z, elev);
            this.addQuadMesh(
              group,
              origin.x,
              origin.y,
              CELL_SIZE,
              CELL_SIZE,
              this.magentaTex,
              0,
              0,
              1,
              1,
              order,
            );
            return;
          }

          const frames = getFrames(def, placed.direction);
          const first = frames?.[0];
          if (!first) return;

          const tileset = this.tilesets.find(
            (t) => t.id === first.sprite.tilesetId,
          );
          if (!tileset) return;

          const baseOrigin = baseCellWorldOrigin(cell.x, cell.y, z, elev);
          const origin = spriteWorldOrigin(baseOrigin, first.sprite.base);
          const { rect } = first.sprite;
          const w = rect.w * CELL_SIZE;
          const h = rect.h * CELL_SIZE;
          const u0 = (rect.x * CELL_SIZE) / tileset.width;
          const u1 = ((rect.x + rect.w) * CELL_SIZE) / tileset.width;
          // flipY texture: v=0 at bottom
          const v1 = 1 - (rect.y * CELL_SIZE) / tileset.height;
          const v0 = 1 - ((rect.y + rect.h) * CELL_SIZE) / tileset.height;

          const animated = (frames?.length ?? 0) > 1;
          if (animated && frames) {
            const mesh = this.addQuadMesh(
              group,
              origin.x,
              origin.y,
              w,
              h,
              this.textures.get(tileset.id) ?? this.magentaTex,
              u0,
              v0,
              u1,
              v1,
              order,
            );
            this.animated.push({
              mesh,
              tileId: def.id,
              direction: placed.direction,
              tilesetId: tileset.id,
              frames,
              tileset,
            });
          } else {
            if (!staticByTileset.has(tileset.id)) {
              staticByTileset.set(tileset.id, []);
            }
            staticByTileset.get(tileset.id)!.push({
              x: origin.x,
              y: origin.y,
              w,
              h,
              u0,
              v0,
              u1,
              v1,
              order,
            });
          }

          elev += def.height;
        });
      }

      for (const [tilesetId, quads] of staticByTileset) {
        const tex = this.textures.get(tilesetId) ?? this.magentaTex;
        // Individual meshes per quad to keep correct renderOrder (merged would lose per-quad order).
        // At editor scale this is fine; can merge later with depth tricks.
        for (const q of quads) {
          this.addQuadMesh(
            group,
            q.x,
            q.y,
            q.w,
            q.h,
            tex,
            q.u0,
            q.v0,
            q.u1,
            q.v1,
            q.order,
          );
        }
      }

      levelGroup.add(group);
      this.chunkMeshes.set(key, group);
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
    renderOrder: number,
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

    // Always fully opaque — level dimming is applied to the flattened level,
    // otherwise overlapping sprites within a level ghost through each other.
    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      // Ortho camera uses top < bottom for Y-down, which reverses winding.
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x + w / 2, y + h / 2, 0);
    mesh.renderOrder = renderOrder;
    parent.add(mesh);
    return mesh;
  }

  private updateAnimations(dt: number) {
    this.animClock += dt;
    // Global frame index per tileId+direction key
    const keys = new Set(
      this.animated.map((a) => `${a.tileId}:${a.direction ?? "default"}`),
    );
    for (const key of keys) {
      const sample = this.animated.find(
        (a) => `${a.tileId}:${a.direction ?? "default"}` === key,
      );
      if (!sample) continue;
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
      this.frameIndices.set(key, idx);
    }

    for (const inst of this.animated) {
      const key = `${inst.tileId}:${inst.direction ?? "default"}`;
      const idx = this.frameIndices.get(key) ?? 0;
      const frame = inst.frames[idx]!;
      const { rect } = frame.sprite;
      const u0 = (rect.x * CELL_SIZE) / inst.tileset.width;
      const u1 = ((rect.x + rect.w) * CELL_SIZE) / inst.tileset.width;
      const v1 = 1 - (rect.y * CELL_SIZE) / inst.tileset.height;
      const v0 = 1 - ((rect.y + rect.h) * CELL_SIZE) / inst.tileset.height;
      const uvs = inst.mesh.geometry.attributes.uv!;
      uvs.setXY(0, u0, v0);
      uvs.setXY(1, u1, v0);
      uvs.setXY(2, u0, v1);
      uvs.setXY(3, u1, v1);
      uvs.needsUpdate = true;
    }
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    this.updateAnimations(1000 / 60);
    // Resize
    const s = useEditorStore.getState();
    this.applyCamera(s.camera.x, s.camera.y, s.zoom);
    this.renderFrame(s);
  };

  private levelRenderTarget(): THREE.WebGLRenderTarget {
    const { x: w, y: h } = this.renderer.getDrawingBufferSize(
      this.drawBufferSize,
    );
    if (!this.levelTarget) {
      // The target holds linear colour, which bands visibly at 8 bits.
      const halfFloat =
        this.renderer.extensions.has("EXT_color_buffer_half_float") ||
        this.renderer.extensions.has("EXT_color_buffer_float");
      this.levelTarget = new THREE.WebGLRenderTarget(w, h, {
        depthBuffer: false,
        stencilBuffer: false,
        type: halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
        magFilter: THREE.NearestFilter,
        minFilter: THREE.NearestFilter,
        generateMipmaps: false,
      });
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
    r.setRenderTarget(null);
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
      r.clear(true, false, false);
      r.render(this.scene, this.camera);
      r.setRenderTarget(null);
      r.setClearColor(BACKGROUND_COLOR, 1);
      group.visible = false;

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

    this.painting = false;

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

