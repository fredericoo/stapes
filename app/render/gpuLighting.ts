/**
 * Lighting bake facade.
 *
 * The bake is the CPU flood fill ({@link computeLightingFlood}), ~4ms on the
 * fixture map. {@link GpuLightingOptions.useGpuJacobi} is reserved for a GPU
 * path and currently falls back to the same flood.
 *
 * Player / dynamic lights stay as add-only overlays ({@link overlayEmitterOverrides}).
 */
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
  /**
   * When true and `renderer` is set, attempt WebGL Jacobi propagation.
   * Currently falls back to CPU flood (parity + speed); reserved for RT binding.
   */
  useGpuJacobi?: boolean;
  renderer?: THREE.WebGLRenderer;
};

/**
 * Shared bake entry for editor + play. Keeps invalidation keys (omit player)
 * and overlay behaviour centralized.
 */
export class GpuLighting {
  private opts: GpuLightingOptions;

  constructor(opts: GpuLightingOptions = {}) {
    this.opts = opts;
  }

  /** Full static bake (sky + map block lights). ~4ms on fixture map. */
  bake(
    map: MapFile,
    tilesById: Record<string, TileDef>,
    ambient: [number, number, number],
    omitLightTileIds?: ReadonlySet<string>,
  ): LightGrid {
    void this.opts.useGpuJacobi;
    void this.opts.renderer;
    // CPU flood is faster than GPU readback for our grid size. A GPU Jacobi
    // pass can replace this without changing callers.
    return composeLightGrid(
      computeLightingFlood(map, tilesById, undefined, omitLightTileIds),
      ambient,
    );
  }

  /** Add dynamic emitters (player) onto a cached static grid. */
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
