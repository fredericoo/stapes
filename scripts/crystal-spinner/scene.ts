import * as THREE from "three";

export type SceneParams = {
  size: number;
  frames: number;
  sweepDeg: number;
  sides: number;
  radius: number;
  topHeight: number;
  bottomHeight: number;
  girdle: number;
  pitchDeg: number;
  tiltDeg: number;
  viewExtent: number;
  frontOpacityMin: number;
  frontOpacityMax: number;
  filmFrequency: number;
};

declare global {
  interface Window {
    renderCrystal: (p: SceneParams) => number[][];
  }
}

function crystalGeometry(p: SceneParams): THREE.BufferGeometry {
  const pos: number[] = [];
  const ring = (y: number, i: number): THREE.Vector3 => {
    const a = (i / p.sides) * Math.PI * 2;
    return new THREE.Vector3(Math.cos(a) * p.radius, y, Math.sin(a) * p.radius);
  };
  const top = new THREE.Vector3(0, p.topHeight, 0);
  const bottom = new THREE.Vector3(0, -p.bottomHeight, 0);
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void => {
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };
  for (let i = 0; i < p.sides; i++) {
    const ua = ring(p.girdle, i);
    const ub = ring(p.girdle, i + 1);
    const la = ring(-p.girdle, i);
    const lb = ring(-p.girdle, i + 1);
    tri(top, ub, ua);
    if (p.girdle > 0) {
      tri(ua, ub, lb);
      tri(ua, lb, la);
    }
    tri(bottom, la, lb);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

const vertexShader = `
  varying vec3 vNormal;
  varying vec3 vWorld;
  varying float vHeight;
  void main() {
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vHeight = position.y;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const SATURATED = [
  "#010728",
  "#021652",
  "#03257e",
  "#0334bb",
  "#0450e9",
  "#098cf6",
  "#16d3fb",
  "#aae3f8",
  "#e0f9fd",
];
const PERIWINKLE = [
  "#021652",
  "#163d8a",
  "#2d52a1",
  "#406cbd",
  "#558bd5",
  "#69abe7",
  "#7cd1f5",
  "#aae3f8",
  "#e0f9fd",
];

const fragmentShader = `
  #define RAMP_LENGTH ${SATURATED.length}
  uniform vec3 uLight;
  uniform float uInterior;
  uniform float uOpacityMin;
  uniform float uOpacityMax;
  uniform float uFilm;
  varying vec3 vNormal;
  varying vec3 vWorld;
  varying float vHeight;

  uniform vec3 uSaturated[RAMP_LENGTH];
  uniform vec3 uPeriwinkle[RAMP_LENGTH];

  vec3 ramp(vec3 stops[RAMP_LENGTH], float t) {
    t = clamp(t, 0.0, 1.0) * float(RAMP_LENGTH - 1);
    int i = int(min(floor(t), float(RAMP_LENGTH - 2)));
    vec3 a = stops[0];
    vec3 b = stops[1];
    for (int k = 0; k < RAMP_LENGTH - 1; k++) {
      if (k == i) {
        a = stops[k];
        b = stops[k + 1];
      }
    }
    return mix(a, b, t - float(i));
  }
  vec3 saturated(float t) { return ramp(uSaturated, t); }
  vec3 periwinkle(float t) { return ramp(uPeriwinkle, t); }

  void main() {
    vec3 n = normalize(vNormal);
    if (!gl_FrontFacing) n = -n;
    vec3 v = normalize(cameraPosition - vWorld);
    float ndv = clamp(dot(n, v), 0.0, 1.0);
    float fresnel = pow(1.0 - ndv, 2.0);
    float diffuse = clamp(dot(n, uLight), 0.0, 1.0);
    float spec = pow(clamp(dot(n, normalize(uLight + v)), 0.0, 1.0), 24.0);

    float film = 0.5 + 0.5 * sin(ndv * uFilm + n.y * 2.5 + vHeight * 1.5);

    vec3 col;
    float alpha;
    if (uInterior > 0.5) {
      float lum = 0.35 + 0.35 * diffuse + 0.25 * (1.0 - abs(vHeight) * 0.6);
      col = mix(saturated(lum), periwinkle(lum), 0.35 * film);
      alpha = 1.0;
    } else {
      float lum = 0.1 + 0.65 * diffuse + 0.25 * fresnel + 1.2 * spec;
      col = mix(saturated(lum), periwinkle(lum), film);
      alpha = mix(uOpacityMin, uOpacityMax, max(fresnel, spec));
    }
    gl_FragColor = vec4(col, alpha);
  }
`;

window.renderCrystal = (p: SceneParams): number[][] => {
  const canvas = document.createElement("canvas");
  canvas.width = p.size;
  canvas.height = p.size;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

  const e = p.viewExtent;
  const camera = new THREE.OrthographicCamera(-e, e, e, -e, 0.1, 20);
  const pitch = THREE.MathUtils.degToRad(p.pitchDeg);
  camera.position.set(0, Math.sin(pitch) * 8, Math.cos(pitch) * 8);
  camera.lookAt(0, 0, 0);

  const light = new THREE.Vector3(-0.6, 0.8, 0.55).normalize();
  const geometry = crystalGeometry(p);
  const uniforms = (interior: boolean) => ({
    uLight: { value: light },
    uInterior: { value: interior ? 1 : 0 },
    uOpacityMin: { value: p.frontOpacityMin },
    uOpacityMax: { value: p.frontOpacityMax },
    uFilm: { value: p.filmFrequency },
    uSaturated: {
      value: SATURATED.map((h) => new THREE.Color().setStyle(h, THREE.LinearSRGBColorSpace)),
    },
    uPeriwinkle: {
      value: PERIWINKLE.map((h) => new THREE.Color().setStyle(h, THREE.LinearSRGBColorSpace)),
    },
  });
  const back = new THREE.Mesh(
    geometry,
    new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: uniforms(true),
      side: THREE.BackSide,
    }),
  );
  const front = new THREE.Mesh(
    geometry,
    new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: uniforms(false),
      side: THREE.FrontSide,
      transparent: true,
    }),
  );
  back.renderOrder = 0;
  front.renderOrder = 1;

  const spin = new THREE.Group();
  spin.add(back, front);
  const tilt = new THREE.Group();
  tilt.rotation.z = -THREE.MathUtils.degToRad(p.tiltDeg);
  tilt.add(spin);
  const scene = new THREE.Scene();
  scene.add(tilt);

  const target = new THREE.WebGLRenderTarget(p.size, p.size, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  const frames: number[][] = [];
  const buf = new Uint8Array(p.size * p.size * 4);
  for (let f = 0; f < p.frames; f++) {
    spin.rotation.y = THREE.MathUtils.degToRad((f / p.frames) * p.sweepDeg);
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, p.size, p.size, buf);
    const flipped: number[] = Array.from({ length: buf.length });
    const row = p.size * 4;
    for (let y = 0; y < p.size; y++) {
      for (let i = 0; i < row; i++) flipped[y * row + i] = buf[(p.size - 1 - y) * row + i]!;
    }
    frames.push(flipped);
  }
  renderer.dispose();
  return frames;
};
