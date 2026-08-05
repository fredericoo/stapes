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
 * Editor ghost-level flatten: nearest palette, then Bayer discard by opacity.
 * Writes full palette pixels (or nothing) so the later fullscreen pass
 * identity-matches instead of inventing muddy translucent colours.
 */
export function createPaletteDitherCompositeMaterial(): THREE.ShaderMaterial {
  const paletteRgb = paletteVec3Array(PALETTE_RGB01);
  const paletteLab = paletteVec3Array(PALETTE_LAB);

  return new THREE.ShaderMaterial({
    uniforms: {
      tLevel: { value: null as THREE.Texture | null },
      uOpacity: { value: 1 },
      /** Canvas pixels per art/world pixel (= editor zoom). */
      uPixelScale: { value: 1 },
      uCamera: { value: new THREE.Vector2(0, 0) },
      uCanvasSize: { value: new THREE.Vector2(1, 1) },
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

      uniform sampler2D tLevel;
      uniform float uOpacity;
      uniform float uPixelScale;
      uniform vec2 uCamera;
      uniform vec2 uCanvasSize;
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

      // 4×4 Bayer, values in [0, 1).
      float bayer4(vec2 frag) {
        int x = int(mod(frag.x, 4.0));
        int y = int(mod(frag.y, 4.0));
        int index = x + y * 4;
        //  0  8  2 10 / 16
        // 12  4 14  6
        //  3 11  1  9
        // 15  7 13  5
        int v =
          index == 0 ? 0 :
          index == 1 ? 8 :
          index == 2 ? 2 :
          index == 3 ? 10 :
          index == 4 ? 12 :
          index == 5 ? 4 :
          index == 6 ? 14 :
          index == 7 ? 6 :
          index == 8 ? 3 :
          index == 9 ? 11 :
          index == 10 ? 1 :
          index == 11 ? 9 :
          index == 12 ? 15 :
          index == 13 ? 7 :
          index == 14 ? 13 : 5;
        return (float(v) + 0.5) / 16.0;
      }

      void main() {
        vec4 texel = texture2D(tLevel, vUv);
        if (texel.a < 0.01 || uOpacity <= 0.001) discard;

        // One Bayer cell per art/world pixel — scales with zoom, tracks pan.
        float scale = max(uPixelScale, 1.0);
        vec2 screenTopLeft = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
        vec2 artPixel = floor(screenTopLeft / scale + uCamera);
        if (bayer4(artPixel) >= uOpacity) discard;

        // SRGBColorSpace RT samples as linear — match in sRGB/OKLab.
        vec3 lab = srgbToOklab(linearToSrgb(texel.rgb));
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
        // Premultiplied opaque write for CustomBlending below.
        gl_FragColor = vec4(uPalette[best], 1.0);
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
