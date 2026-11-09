import * as THREE from "three";

/**
 * The ortho camera is Y-down (top < bottom), which reverses face winding, so flat sprite quads
 * need DoubleSide. three.js draws a transparent DoubleSide material twice, back faces then front,
 * unless `forceSinglePass` is set; each quad has one winding, so one of those draws covers nothing.
 */
export const SINGLE_PASS_DOUBLE_SIDE = {
  side: THREE.DoubleSide,
  forceSinglePass: true,
} as const;
