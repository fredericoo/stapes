/**
 * Fullscreen palette quantisation pass (editor + play).
 * Nearest OKLab match — no dither. Exact art colours snap; everything else
 * lands on the closest of the 29 opaque stapes.pal entries.
 */
import * as THREE from "three";
import {
  PALETTE_SIZE,
  STAPES_PALETTE,
  paletteOklab,
  paletteRgb01,
} from "../lib/palette";

const PALETTE_RGB01 = paletteRgb01(STAPES_PALETTE);
const PALETTE_LAB = paletteOklab(STAPES_PALETTE);

function paletteVec3Array(flat: Float32Array): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < flat.length; i += 3) {
    out.push(new THREE.Vector3(flat[i], flat[i + 1], flat[i + 2]));
  }
  return out;
}

/** Fullscreen nearest-OKLab palette match. */
export function createPaletteMaterial(): THREE.ShaderMaterial {
  const paletteRgb = paletteVec3Array(PALETTE_RGB01);
  const paletteLab = paletteVec3Array(PALETTE_LAB);

  return new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: null as THREE.Texture | null },
      uPalette: { value: paletteRgb },
      uPaletteLab: { value: paletteLab },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      #define PALETTE_SIZE ${PALETTE_SIZE}

      uniform sampler2D tScene;
      uniform vec3 uPalette[PALETTE_SIZE];
      uniform vec3 uPaletteLab[PALETTE_SIZE];
      varying vec2 vUv;

      float srgbChannelToLinear(float c) {
        return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
      }

      float linearChannelToSrgb(float c) {
        return c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
      }

      vec3 linearToSrgb(vec3 c) {
        return vec3(
          linearChannelToSrgb(c.r),
          linearChannelToSrgb(c.g),
          linearChannelToSrgb(c.b)
        );
      }

      vec3 srgbToOklab(vec3 c) {
        float lr = srgbChannelToLinear(c.r);
        float lg = srgbChannelToLinear(c.g);
        float lb = srgbChannelToLinear(c.b);
        float l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
        float m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
        float s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
        float l_ = pow(l, 1.0 / 3.0);
        float m_ = pow(m, 1.0 / 3.0);
        float s_ = pow(s, 1.0 / 3.0);
        return vec3(
          0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
          1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
          0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
        );
      }

      void main() {
        // SRGBColorSpace RT samples as linear — re-encode for hex/255 compare.
        vec3 lab = srgbToOklab(linearToSrgb(texture2D(tScene, vUv).rgb));
        float bestD = 1e20;
        int best = 0;
        for (int i = 0; i < PALETTE_SIZE; i++) {
          vec3 d = lab - uPaletteLab[i];
          float dist = dot(d, d);
          if (dist < bestD) {
            bestD = dist;
            best = i;
          }
        }
        gl_FragColor = vec4(uPalette[best], 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    transparent: false,
  });
}

/**
 * Editor "other levels" flatten: one faded copy of a whole stack of floors.
 *
 * Takes a rendered image rather than a level, because that is the only way the
 * fade can be applied once. Every floor above the one being edited is drawn
 * into a single depth-sorted target first and arrives here as one picture, so
 * what fades is the silhouette of the stack — not each floor over the last,
 * which showed every interior wall in the building at once.
 *
 * Runs after the quantise, over the finished frame, and is the one thing in the
 * editor allowed off the ramp. Blended into the scene target it would be
 * quantised with everything else, and a quantised translucent pixel is not
 * translucent — it is whichever solid palette entry sits nearest the blend,
 * which is a colour that merely *looks* faded. Here the alpha survives.
 */
export function createLevelFadeCompositeMaterial(): THREE.ShaderMaterial {
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

      float linearChannelToSrgb(float c) {
        return c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
      }

      vec3 linearToSrgb(vec3 c) {
        return vec3(
          linearChannelToSrgb(c.r),
          linearChannelToSrgb(c.g),
          linearChannelToSrgb(c.b)
        );
      }

      void main() {
        vec4 texel = texture2D(tLevel, vUv);
        float alpha = texel.a * uOpacity;
        if (alpha < 0.004) discard;
        // The level target samples as linear; the canvas holds sRGB bytes, so
        // encode back before writing. Premultiplied for the CustomBlending
        // below.
        gl_FragColor = vec4(linearToSrgb(texel.rgb) * alpha, alpha);
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
}

/**
 * Owns the offscreen scene RT + fullscreen quantise quad.
 * Caller renders the world into {@link sceneTarget}, then
 * {@link blitToCanvas} samples it onto the drawing buffer.
 */
export class PalettePass {
  readonly material: THREE.ShaderMaterial;
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly drawBufferSize = new THREE.Vector2();

  constructor() {
    this.material = createPaletteMaterial();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(quad);
    this.camera = new THREE.Camera();
  }

  sceneTarget(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
    const { x: w, y: h } = renderer.getDrawingBufferSize(this.drawBufferSize);
    if (
      this.target &&
      (!this.target.depthBuffer ||
        this.target.texture.type !== THREE.UnsignedByteType ||
        this.target.texture.colorSpace !== THREE.SRGBColorSpace)
    ) {
      this.target.dispose();
      this.target = null;
    }
    if (!this.target) {
      this.target = new THREE.WebGLRenderTarget(w, h, {
        depthBuffer: true,
        stencilBuffer: false,
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        magFilter: THREE.NearestFilter,
        minFilter: THREE.NearestFilter,
        generateMipmaps: false,
      });
      this.target.texture.colorSpace = THREE.SRGBColorSpace;
    } else if (this.target.width !== w || this.target.height !== h) {
      this.target.setSize(w, h);
    }
    return this.target;
  }

  /** Bind the scene RT and blit the quantised result to the canvas. */
  blitToCanvas(renderer: THREE.WebGLRenderer): void {
    this.material.uniforms.tScene!.value = this.target?.texture ?? null;
    renderer.setRenderTarget(null);
    renderer.clear(true, true, false);
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
    this.material.dispose();
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose();
    });
  }
}
