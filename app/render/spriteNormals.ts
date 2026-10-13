import type * as THREE from "three";

export type SpriteNormalUniforms = {
  uSpriteNormal: { value: THREE.Texture };
};

/** A direction in the world: east, north, up. Normal maps store this, not screen space. */
export type Vec3 = readonly [number, number, number];

/**
 * The art is painted lit from the north-west and above, so the shader relights
 * rather than lights: a pixel's shade is how much more a light reaches its
 * normal than this one did, which keeps sprites as painted under it.
 */
export const BAKED_LIGHT: Vec3 = normalize([-0.45, 0.55, 0.7]);
/** Share of a painted surface's brightness that does not depend on facing the light. */
export const NORMAL_AMBIENT = 0.45;
export const NORMAL_SHADE_MIN = 0.55;
export const NORMAL_SHADE_MAX = 1.8;
/**
 * The light grid has no direction in it, only brightness per cell. The way it
 * brightens across neighbouring cells points at the source; this scales that
 * relative slope into how far the light leans from straight overhead.
 */
export const BLOCK_LIGHT_TILT = 2.0;
export const MIN_BLOCK_BRIGHTNESS = 0.05;

export const UP: Vec3 = [0, 0, 1];

export function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function reach(n: Vec3, toLight: Vec3): number {
  return NORMAL_AMBIENT + (1 - NORMAL_AMBIENT) * Math.max(dot(n, toLight), 0);
}

/**
 * Divided by the same ratio for open ground, so a floor is never changed and a
 * sheet with a normal map sits beside one without.
 */
export function normalShade(n: Vec3, toLight: Vec3): number {
  const relit = reach(n, toLight) / reach(n, BAKED_LIGHT);
  const ground = reach(UP, toLight) / reach(UP, BAKED_LIGHT);
  return Math.min(NORMAL_SHADE_MAX, Math.max(NORMAL_SHADE_MIN, relit / ground));
}

function glsl(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

const BAKED_GLSL = `vec3(${BAKED_LIGHT.map(glsl).join(", ")})`;

export const SPRITE_NORMAL_GLSL_COMMON = `
uniform sampler2D uSpriteNormal;
float lightBrightness(vec3 c) {
  return max(c.r, max(c.g, c.b));
}
float normalReach(vec3 n, vec3 toLight) {
  return ${glsl(NORMAL_AMBIENT)} + ${glsl(1 - NORMAL_AMBIENT)} * max(dot(n, toLight), 0.0);
}
float normalShade(vec3 n, vec3 toLight) {
  float relit = normalReach(n, toLight) / normalReach(n, ${BAKED_GLSL});
  float ground = normalReach(vec3(0.0, 0.0, 1.0), toLight) /
    normalReach(vec3(0.0, 0.0, 1.0), ${BAKED_GLSL});
  return clamp(relit / ground, ${glsl(NORMAL_SHADE_MIN)}, ${glsl(NORMAL_SHADE_MAX)});
}
// The light map's v grows southward, so the slope's y is negated to point north.
vec3 blockLightDirection(vec2 lightUv, vec3 centre) {
  vec2 cell = 1.0 / uLightSize;
  float east = lightBrightness(texture2D(uLightMap, lightUv + vec2(cell.x, 0.0)).rgb);
  float west = lightBrightness(texture2D(uLightMap, lightUv - vec2(cell.x, 0.0)).rgb);
  float south = lightBrightness(texture2D(uLightMap, lightUv + vec2(0.0, cell.y)).rgb);
  float north = lightBrightness(texture2D(uLightMap, lightUv - vec2(0.0, cell.y)).rgb);
  vec2 slope = vec2(east - west, north - south) /
    max(lightBrightness(centre), ${glsl(MIN_BLOCK_BRIGHTNESS)});
  return normalize(vec3(slope * ${glsl(BLOCK_LIGHT_TILT)}, 1.0));
}`;

/**
 * Sky light is the light the art was painted under, so only block light is
 * relit, in proportion to its share of the total. It is applied after the
 * light is capped at 1, or a pixel beside a fire would have no room to brighten.
 */
export const SPRITE_NORMAL_GLSL_FRAGMENT = `
  vec3 spriteNormal = normalize(texture2D(uSpriteNormal, vMapUv).rgb * 2.0 - 1.0);
  float blockShare = lightBrightness(block) /
    max(lightBrightness(sky + block), ${glsl(MIN_BLOCK_BRIGHTNESS)});
  float relit = normalShade(spriteNormal, blockLightDirection(lightUv, block));
  light *= mix(1.0, relit, clamp(blockShare, 0.0, 1.0));`;
