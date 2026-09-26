import * as THREE from "three";
import { hexToRgb01, srgbToOklab } from "../lib/palette";
import type { StatusTint } from "../lib/statusVfx";

export type TintUniforms = {
  uTintLab: { value: THREE.Vector3 };
  uTintStrength: { value: number };
  uTintKeepLuma: { value: number };
};

export function noTintUniforms(): TintUniforms {
  return {
    uTintLab: { value: new THREE.Vector3(0, 0, 0) },
    uTintStrength: { value: 0 },
    uTintKeepLuma: { value: 1 },
  };
}

export function tintUniforms(tint: StatusTint): TintUniforms {
  const [L, a, b] = tintOklab(tint);
  return {
    uTintLab: { value: new THREE.Vector3(L, a, b) },
    uTintStrength: { value: tint.strength },
    uTintKeepLuma: { value: tint.keepLuma },
  };
}

export function writeTintUniforms(target: TintUniforms, tint: StatusTint | null) {
  if (!tint || tint.strength <= 0) {
    target.uTintStrength.value = 0;
    return;
  }
  const [L, a, b] = tintOklab(tint);
  target.uTintLab.value.set(L, a, b);
  target.uTintStrength.value = tint.strength;
  target.uTintKeepLuma.value = tint.keepLuma;
}

export function tintOklab(tint: StatusTint): readonly [number, number, number] {
  const [r, g, b] = hexToRgb01(tint.color);
  return srgbToOklab(r, g, b);
}

export function tintCacheKey(tint: StatusTint | null): string {
  if (!tint || tint.strength <= 0) return "";
  return `${tint.color}:${tint.strength.toFixed(TINT_KEY_PRECISION)}:${tint.keepLuma.toFixed(TINT_KEY_PRECISION)}`;
}

const TINT_KEY_PRECISION = 3;

export const TINT_GLSL_COMMON = `
uniform vec3 uTintLab;
uniform float uTintStrength;
uniform float uTintKeepLuma;

vec3 linearRgbToOklab(vec3 c) {
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  float l_ = pow(max(l, 0.0), 1.0 / 3.0);
  float m_ = pow(max(m, 0.0), 1.0 / 3.0);
  float s_ = pow(max(s, 0.0), 1.0 / 3.0);
  return vec3(
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
  );
}

vec3 oklabToLinearRgb(vec3 lab) {
  float l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  float m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  float s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
  float l = l_ * l_ * l_;
  float m = m_ * m_ * m_;
  float s = s_ * s_ * s_;
  return vec3(
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  );
}
`;

export const TINT_GLSL_FRAGMENT = `
if (uTintStrength > 0.0) {
  vec3 ownLab = linearRgbToOklab(diffuseColor.rgb);
  vec3 mixedLab = mix(ownLab, uTintLab, uTintStrength);
  mixedLab.x = mix(mixedLab.x, ownLab.x, uTintKeepLuma);
  diffuseColor.rgb = max(vec3(0.0), oklabToLinearRgb(mixedLab));
}
`;
