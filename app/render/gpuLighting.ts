import type * as THREE from "three";
import type { MapFile, TileDef } from "../lib/types";
import {
  type EmitterOverride,
  type LightGrid,
  composeLightGrid,
  overlayEmitterOverrides,
} from "../lib/lighting";
import { computeLightingFlood, MAX_LIGHT_LEVEL } from "../lib/lightingFlood";

export type GpuLightingOptions = {
  useGpuJacobi?: boolean;
  renderer?: THREE.WebGLRenderer;
};

/** Always bakes on the CPU. The `useGpuJacobi` option is accepted and ignored. */
export class GpuLighting {
  private opts: GpuLightingOptions;

  constructor(opts: GpuLightingOptions = {}) {
    this.opts = opts;
  }

  bake(
    map: MapFile,
    tilesById: Record<string, TileDef>,
    ambient: [number, number, number],
    omitLightTileIds?: ReadonlySet<string>,
  ): LightGrid {
    void this.opts.useGpuJacobi;
    void this.opts.renderer;
    return composeLightGrid(
      computeLightingFlood(map, tilesById, undefined, omitLightTileIds),
      ambient,
    );
  }

  overlay(
    base: LightGrid,
    map: MapFile,
    tilesById: Record<string, TileDef>,
    overrides: ReadonlyArray<EmitterOverride>,
  ): LightGrid {
    return overlayEmitterOverrides(base, map, tilesById, overrides);
  }
}

export { MAX_LIGHT_LEVEL };
