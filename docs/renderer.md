# Renderer and lighting

## Coordinates and depth

- Sheet rows and UVs run in opposite directions: a frame further down the sheet has a smaller v. `AnimationTable.bake` (`app/render/animTable.ts`) stores a negative `dv` for it, and `frameUvs` (`app/render/WorldRenderer.ts`) uses the same convention for the level build, animation pass and projectile pass. The GLSL in `app/render/overlayMeshes.ts` flips y for the same reason.
- The animated-frame lookup in `injectWorldShader` (`app/render/worldQuads.ts`) adds its UV offset straight onto `vMapUv`. That is correct only while no texture transform is set on the world material; if one is added, the offset must go through `mapTransform`.
- The depth-bias constants in `app/lib/geometry.ts` (`DEPTH_STACK_BIAS`, `DEPTH_PLANE_BIAS`, `DEPTH_PLANE_EAST_WEIGHT`, `DEPTH_OVERHANG_BIAS`, `DEPTH_BIAS_PER_LEVEL`) are ordered by magnitude, each only large enough to break ties between coplanar fragments. Changing one without keeping their relative sizes corrupts draw order silently.
- `DepthBox` planes are world pixels of the unshifted grid, `(cell + 1) * CELL_SIZE`. Do not use `baseCellWorldOrigin`, which already includes the elevation shift the depth shader recovers.
- `snapToWholePixels` (`app/render/GameRenderer.ts`) rounds a moving sprite to whole world pixels so its texels line up with the static scenery.
- `WorldRenderer`'s scenes set `matrixWorldAutoUpdate = false`. A mesh added to them needs `updateMatrixWorld(true)` or it draws at the origin.
- `makeRectOutline` (`app/render/overlayMeshes.ts`) builds a five-point line because `EdgesGeometry` is unreliable under the Y-down orthographic camera.
- `OCTANTS` (`app/lib/types.ts`) must stay clockwise from north; angle-to-octant code indexes into it.
- `renderGrid` (`app/lib/voxel.ts`) depends on iterating in flat-index order (z, y, x ascending) for painter-order overdraw.

## Shaders and colour

- `injectParticleShader` (`app/render/particleLayer.ts`) must run after `injectWorldShader`: both replace the `#include <common>` anchor, and the later patch has to land ahead of the earlier one's declarations.
- `TINT_GLSL_COMMON` (`app/render/spriteTint.ts`) converts to OKLab from linear RGB, because `diffuseColor` is already linear at that point.
- `app/render/palettePass.ts` samples an sRGB render target as linear, and re-encodes to sRGB before comparing against palette hex values and before the level-fade composite writes to the canvas.
- `STAPES_PALETTE` (`app/lib/palette.ts`) is append-only. Index 0 is read directly as the status preview's backdrop, and reordering changes which pixels quantise to which entry.

## Input

- `onPointerDown` (`app/render/GameRenderer.ts`) does not call `preventDefault()` on a touch press. Doing so suppresses the compatibility `mousedown`, which is what keeps a chat input focused through a walk-click.
- Picking (`app/render/pick.ts`) tests a tile's foot square on the ground, not the sprite's bounds, so tall art does not take clicks meant for what stands behind it.

## Items on the ground

- `pileOffsets` (`app/render/pileLayout.ts`) depends only on the pile's `count`. The count is all clients share, so any randomness would draw the same pile differently on each.

## Lighting

- `litReach` (`app/lib/lightingChunks.ts`) is `Math.ceil(radius) - 1` because the flood reaches zero exactly at `radius`. Using `Math.ceil(radius)` charges chunks the emitter never lights, and they rebake on every flicker frame.
- `LightBakerClient.syncMap` (`app/lib/lightBakerClient.ts`) must be posted before a bake request for the same frame; the worker handles messages in order.
- `GpuLighting` (`app/render/gpuLighting.ts`) always bakes on the CPU. The `useGpuJacobi` option is accepted and ignored.
