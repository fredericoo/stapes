import * as THREE from "three";
import { hexToRgb01, srgbToOklab } from "../lib/palette";
import type { StatusTint } from "../lib/statusVfx";

/**
 * Wearing a status's colour: the uniforms, and the OKLab mix that spends them.
 *
 * ## Why a uniform and not a vertex attribute
 *
 * The obvious shape is a per-quad tint attribute, and it is the wrong one. Almost
 * nothing in a map is ever tinted — a poisoned rat, and thirty thousand tiles
 * that are not — so an attribute is four floats per vertex of a map-sized buffer
 * to carry zero, and it has to be re-uploaded on the frame a status lands.
 *
 * A uniform costs nothing on the frames nobody is poisoned, because the mix is
 * behind `uTintStrength > 0` and a uniform branch is coherent across the whole
 * draw. What it costs instead is a **material per tint**, which is the trade this
 * makes deliberately: the population of distinct tints is the population of
 * authored statuses, so the cache is single digits and the meshes that need one
 * are the ones that already have their own mesh — see `WorldRenderer.materialFor`.
 *
 * The consequence worth stating plainly: **only a separately-meshed tile can be
 * tinted.** In practice that is every actor, because a tile that can move gets
 * its own mesh (see `cellItems`). A bush cannot yet — it is merged into its
 * floor's batch, and tinting it would mean promoting it out of that batch. The
 * status editor's preview draws its subject as its own mesh, so a bush on fire
 * can be *designed* now and lit later.
 *
 * ## Why OKLab
 *
 * A tint in sRGB drags the darks towards the tint faster than the lights, so a
 * half-strength purple wash turns a rat's shadows lilac while its highlights stay
 * white — it reads as fog rather than as poison. OKLab is perceptually even, so
 * an even mix looks even, and pulling the lightness back out ({@link
 * StatusTint.keepLuma}) leaves every shading step the artist drew intact. That is
 * what makes the strong case a *palette swap* rather than a wash.
 *
 * The tint's own OKLab is computed here, on the CPU, once per material — the
 * fragment shader converts only the pixel it is given.
 */

/** The tint half of a world material's uniforms. @see injectWorldShader */
export type TintUniforms = {
  /** The tint colour, in OKLab. Only read when the strength is above zero. */
  uTintLab: { value: THREE.Vector3 };
  /** How far towards it a pixel is dragged. Zero is the branch that costs nothing. */
  uTintStrength: { value: number };
  /** How much of the pixel's own lightness is put back. @see StatusTint.keepLuma */
  uTintKeepLuma: { value: number };
};

/** Uniforms for a material that is not tinted, which is almost all of them. */
export function noTintUniforms(): TintUniforms {
  return {
    uTintLab: { value: new THREE.Vector3(0, 0, 0) },
    uTintStrength: { value: 0 },
    uTintKeepLuma: { value: 1 },
  };
}

/** Uniforms for one authored tint. */
export function tintUniforms(tint: StatusTint): TintUniforms {
  const [L, a, b] = tintOklab(tint);
  return {
    uTintLab: { value: new THREE.Vector3(L, a, b) },
    uTintStrength: { value: tint.strength },
    uTintKeepLuma: { value: tint.keepLuma },
  };
}

/**
 * Point an existing set of uniforms at a different tint, or at none.
 *
 * Written in place rather than rebuilt, because `injectWorldShader` binds these
 * holder objects into the compiled shader by reference — so the status editor
 * can retint on every keystroke without discarding a material and asking the
 * driver to look at a program again.
 */
export function writeTintUniforms(
  target: TintUniforms,
  tint: StatusTint | null,
) {
  if (!tint || tint.strength <= 0) {
    target.uTintStrength.value = 0;
    return;
  }
  const [L, a, b] = tintOklab(tint);
  target.uTintLab.value.set(L, a, b);
  target.uTintStrength.value = tint.strength;
  target.uTintKeepLuma.value = tint.keepLuma;
}

/** A tint's colour in OKLab. Shared with the mirror so the two cannot disagree. */
export function tintOklab(tint: StatusTint): readonly [number, number, number] {
  const [r, g, b] = hexToRgb01(tint.color);
  return srgbToOklab(r, g, b);
}

/**
 * How a tint is keyed in the material cache.
 *
 * Rounded, so two tints that differ below what a 29-colour palette can express
 * share one material instead of compiling two programs that draw the same pixel.
 */
export function tintCacheKey(tint: StatusTint | null): string {
  if (!tint || tint.strength <= 0) return "";
  return `${tint.color}:${tint.strength.toFixed(TINT_KEY_PRECISION)}:${tint.keepLuma.toFixed(TINT_KEY_PRECISION)}`;
}

const TINT_KEY_PRECISION = 3;

/**
 * OKLab conversions and the mix, as GLSL.
 *
 * From **linear** RGB rather than sRGB, which is not a shortcut — OKLab is
 * defined on linear sRGB, and `diffuseColor` at this point in the shader is
 * already linear because three decoded the texture on sample. Going out through
 * sRGB and back would be six extra transcendentals to arrive at the same numbers.
 */
export const TINT_GLSL_COMMON = /* glsl */ `
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

/**
 * The mix itself, spliced in before the light.
 *
 * Before, and not after, because the tint is a fact about the *sprite* and the
 * light is a fact about the room: a purple rat standing in the dark is a dark
 * purple rat, and tinting after the light would give it a rat-shaped glow.
 */
export const TINT_GLSL_FRAGMENT = /* glsl */ `
if (uTintStrength > 0.0) {
  vec3 ownLab = linearRgbToOklab(diffuseColor.rgb);
  vec3 mixedLab = mix(ownLab, uTintLab, uTintStrength);
  mixedLab.x = mix(mixedLab.x, ownLab.x, uTintKeepLuma);
  diffuseColor.rgb = max(vec3(0.0), oklabToLinearRgb(mixedLab));
}
`;
