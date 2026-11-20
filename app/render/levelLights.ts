import * as THREE from "three";
import type { PackedLevelLight, PackedLightGrid, SunLight } from "../lib/lighting";
import { SUN_SPAN_NEVER_HI, SUN_SPAN_NEVER_LO } from "../lib/sunSpan";
import { type LevelLightUniforms, noSunUniforms } from "./worldQuads";

/**
 * A light texel is sampled at its centre, so a map whose first texel is cell
 * `x0` starts half a cell before it.
 */
const LIGHT_MAP_CELL_OFFSET = 0.5;

function lightTexture(data: Uint8Array, w: number, h: number, format: THREE.PixelFormat) {
  const tex = new THREE.DataTexture(data, w, h, format);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The per-level light uniforms a world material binds, and the packed light
 * and sun textures uploaded into them. Shared by the play renderer and the
 * map editor, which light the same window the same way.
 */
export class LevelLights {
  private readonly uniformsByZ = new Map<number, LevelLightUniforms>();
  private readonly lightTextures = new Map<number, THREE.DataTexture>();
  private readonly sunTextures = new Map<number, THREE.DataTexture>();
  private enabled = true;
  private ambientRgb: [number, number, number] | null = null;
  private sunLight: SunLight | null = null;

  constructor(private readonly placeholder: THREE.Texture) {}

  get ambient(): [number, number, number] | null {
    return this.ambientRgb;
  }

  get sun(): SunLight | null {
    return this.sunLight;
  }

  /**
   * Held by reference: a material binds this object once at shader compile
   * time, so an upload mutates what is inside it.
   */
  uniformsFor(z: number): LevelLightUniforms {
    let u = this.uniformsByZ.get(z);
    if (!u) {
      u = {
        uLightMap: { value: this.placeholder },
        uLightOrigin: { value: new THREE.Vector2(0, 0) },
        uLightSize: { value: new THREE.Vector2(1, 1) },
        uLightingEnabled: { value: this.enabled ? 1 : 0 },
        uAmbient: { value: new THREE.Vector3(0, 0, 0) },
        ...noSunUniforms(this.placeholder),
      };
      this.uniformsByZ.set(z, u);
    }
    return u;
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    for (const u of this.uniformsByZ.values()) u.uLightingEnabled.value = enabled ? 1 : 0;
  }

  setIllumination(ambient: [number, number, number], sun: SunLight) {
    this.ambientRgb = ambient;
    this.sunLight = sun;
    for (const u of this.uniformsByZ.values()) this.applyIllumination(u);
  }

  /** A level with uniforms and no plane in `grid` is uploaded dark. */
  upload(grid: PackedLightGrid) {
    for (const [z, level] of grid.levels) this.uploadLevel(z, level);
    for (const z of this.uniformsByZ.keys()) {
      if (!grid.levels.has(z)) this.uploadDark(z);
    }
  }

  dispose() {
    for (const tex of this.lightTextures.values()) tex.dispose();
    for (const tex of this.sunTextures.values()) tex.dispose();
    this.lightTextures.clear();
    this.sunTextures.clear();
  }

  private applyIllumination(u: LevelLightUniforms) {
    const a = this.ambientRgb;
    if (a) u.uAmbient.value.set(a[0], a[1], a[2]);
    const sun = this.sunLight;
    if (!sun) return;
    u.uSunColor.value.set(sun.color[0], sun.color[1], sun.color[2]);
    u.uSunArc.value = sun.arc;
  }

  private uploadDark(z: number) {
    const u = this.uniformsFor(z);
    u.uLightMap.value = this.write(
      this.lightTextures,
      THREE.RGBAFormat,
      z,
      new Uint8Array([0, 0, 0, 0]),
      1,
      1,
    );
    u.uLightOrigin.value.set(0, 0);
    u.uLightSize.value.set(1, 1);
    u.uSunMap.value = this.write(
      this.sunTextures,
      THREE.RGFormat,
      z,
      new Uint8Array([SUN_SPAN_NEVER_LO, SUN_SPAN_NEVER_HI]),
      1,
      1,
    );
  }

  private uploadLevel(z: number, level: PackedLevelLight) {
    const u = this.uniformsFor(z);
    this.applyIllumination(u);
    u.uSunMap.value = this.write(this.sunTextures, THREE.RGFormat, z, level.sun, level.w, level.h);
    u.uLightOrigin.value.set(level.x0 - LIGHT_MAP_CELL_OFFSET, level.y0 - LIGHT_MAP_CELL_OFFSET);
    u.uLightSize.value.set(level.w, level.h);
    u.uLightMap.value = this.write(
      this.lightTextures,
      THREE.RGBAFormat,
      z,
      level.rgba,
      level.w,
      level.h,
    );
  }

  private write(
    textures: Map<number, THREE.DataTexture>,
    format: THREE.PixelFormat,
    z: number,
    data: Uint8Array,
    w: number,
    h: number,
  ): THREE.DataTexture {
    let tex = textures.get(z);
    if (!tex || tex.image.width !== w || tex.image.height !== h) {
      tex?.dispose();
      tex = lightTexture(data.slice(), w, h, format);
      textures.set(z, tex);
    } else {
      (tex.image as { data: Uint8Array }).data.set(data);
      tex.needsUpdate = true;
    }
    return tex;
  }
}
