import { normalize, UP, type Vec3 } from "../../app/render/spriteNormals";
import { PX_PER_HEIGHT } from "../../app/lib/geometry";
import {
  CELL_SIZE,
  type Octant,
  type StateSprites,
  type TileDef,
  type TileSprite,
  spriteRect,
} from "../../app/lib/types";
import type { Face, Rule, Shape, TileSpec } from "./spec";

const RGBA = 4;
const OPAQUE_ALPHA = 128;
const CHANNEL_MAX = 255;
/** How many pixels in from the silhouette edge an inflated sprite reaches full height. */
const INFLATE_RADIUS_PX = 3;
const DEFAULT_DETAIL = 1.5;

export type Sheet = { width: number; height: number; data: Uint8Array };
type PxRect = { x: number; y: number; w: number; h: number };

export type SpriteUse = {
  tileId: string;
  facing: string;
  rect: PxRect;
  base: { x: number; y: number };
  heightUnits: number;
  footprint: { w: number; d: number };
};

/**
 * The camera looks down from the south-east at 45° in both, so a point
 * `(x, y, z)` in pixels draws at `(x - z, y - z)`. These are the world
 * directions (east, north, up) of facing it, and of screen right and up.
 */
const TO_CAMERA: Vec3 = normalize([1, -1, 1]);
const SCREEN_RIGHT: Vec3 = normalize([2, 1, -1]);
const SCREEN_UP: Vec3 = normalize([0, 1, 1]);

const NAMED_FACES: Record<string, Vec3> = {
  top: UP,
  south: [0, -1, 0],
  north: [0, 1, 0],
  east: [1, 0, 0],
  west: [-1, 0, 0],
  camera: TO_CAMERA,
};

const DOWNHILL: Record<string, [number, number]> = {
  n: [0, 1],
  s: [0, -1],
  e: [1, 0],
  w: [-1, 0],
};

export function faceNormal(face: Face): Vec3 {
  if (typeof face === "string") return NAMED_FACES[face]!;
  if ("normal" in face) return normalize(face.normal);
  const [dx, dy] = DOWNHILL[face.slope]!;
  const pitch = (face.pitch * Math.PI) / 180;
  return [dx * Math.sin(pitch), dy * Math.sin(pitch), Math.cos(pitch)];
}

function fromCamera(right: number, up: number, out: number): Vec3 {
  return normalize([
    right * SCREEN_RIGHT[0] + up * SCREEN_UP[0] + out * TO_CAMERA[0],
    right * SCREEN_RIGHT[1] + up * SCREEN_UP[1] + out * TO_CAMERA[1],
    right * SCREEN_RIGHT[2] + up * SCREEN_UP[2] + out * TO_CAMERA[2],
  ]);
}

export function isOpaque(sheet: Sheet, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= sheet.width || y >= sheet.height) return false;
  return sheet.data[(y * sheet.width + x) * RGBA + 3]! >= OPAQUE_ALPHA;
}

export function hexAt(sheet: Sheet, x: number, y: number): string {
  const i = (y * sheet.width + x) * RGBA;
  const hex = (n: number) => sheet.data[i + n]!.toString(16).padStart(2, "0");
  return `#${hex(0)}${hex(1)}${hex(2)}`;
}

/** Rec. 601 weights on the sRGB values; a bump only needs relative brightness. */
function luma(sheet: Sheet, x: number, y: number): number {
  const i = (y * sheet.width + x) * RGBA;
  const d = sheet.data;
  return (0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!) / CHANNEL_MAX;
}

function spritesOf(states: StateSprites): [string, TileSprite][] {
  const out: [string, TileSprite][] = [];
  if (states.sprite) out.push(["default", states.sprite]);
  for (const [octant, s] of Object.entries(states.sprites ?? {})) {
    if (s) out.push([octant, s]);
  }
  for (const s of Object.values(states.slices ?? {})) {
    if (s) out.push(["default", s]);
  }
  for (const s of Object.values(states.variants ?? {})) out.push(["default", s]);
  for (const s of states.scatter ?? []) out.push(["default", s]);
  return out;
}

const SIDEWAYS: ReadonlySet<string> = new Set<Octant>(["e", "w"]);

export function spriteUses(def: TileDef): SpriteUse[] {
  const all = [def, ...Object.values(def.states ?? {})].flatMap(spritesOf);
  const fp = def.footprint ?? { w: 1, d: 1 };
  return all.flatMap(([facing, sprite]) =>
    sprite.frames.map((frame) => {
      const r = spriteRect(def.anchor, frame.sprite);
      return {
        tileId: def.id,
        facing,
        rect: { x: r.x * CELL_SIZE, y: r.y * CELL_SIZE, w: r.w * CELL_SIZE, h: r.h * CELL_SIZE },
        base: { x: frame.sprite.base.x * CELL_SIZE, y: frame.sprite.base.y * CELL_SIZE },
        heightUnits: def.height,
        footprint: SIDEWAYS.has(facing) ? { w: fp.d, d: fp.w } : fp,
      };
    }),
  );
}

function ruleMatches(rule: Rule, colour: string, lx: number, ly: number): boolean {
  if (rule.colors && !rule.colors.includes(colour)) return false;
  const r = rule.region;
  if (r && (lx < r.x || ly < r.y || lx >= r.x + r.w || ly >= r.y + r.h)) return false;
  return true;
}

export function shapeAt(spec: TileSpec, use: SpriteUse, colour: string, lx: number, ly: number) {
  const facing = spec.facings?.[use.facing];
  const rules = [...(facing?.rules ?? []), ...(spec.rules ?? [])];
  const hit = rules.find((rule) => ruleMatches(rule, colour, lx, ly));
  return hit?.shape ?? facing?.shape ?? spec.shape;
}

/**
 * The first face of the tile's own box a pixel's ray meets, coming from the
 * camera: the one highest up, as the world shader's depth ray also decides.
 */
function boxFace(use: SpriteUse, lx: number, ly: number): Vec3 {
  const px = lx + 0.5;
  const py = ly + 0.5;
  const x1 = use.base.x + CELL_SIZE;
  const y1 = use.base.y + CELL_SIZE;
  const x0 = x1 - use.footprint.w * CELL_SIZE;
  const y0 = y1 - use.footprint.d * CELL_SIZE;
  const top = use.heightUnits * PX_PER_HEIGHT;
  const inside = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  if (inside(px + top, py + top)) return UP;
  const southZ = y1 - py;
  const eastZ = x1 - px;
  const southHit = southZ >= 0 && southZ <= top && px + southZ >= x0 && px + southZ <= x1;
  const eastHit = eastZ >= 0 && eastZ <= top && py + eastZ >= y0 && py + eastZ <= y1;
  if (southHit && (!eastHit || southZ >= eastZ)) return NAMED_FACES.south!;
  if (eastHit) return NAMED_FACES.east!;
  return TO_CAMERA;
}

/** Height of a rounded silhouette: a quarter circle rising over the first few pixels in. */
function roundedHeight(insetPx: number): number {
  const t = Math.min(insetPx, INFLATE_RADIUS_PX) / INFLATE_RADIUS_PX;
  return Math.sqrt(1 - (1 - t) * (1 - t));
}

function insetIn(sheet: Sheet, rect: PxRect, x: number, y: number, rowOnly: boolean): number {
  for (let r = 1; r <= INFLATE_RADIUS_PX; r++) {
    if (ringHasGap(sheet, rect, x, y, r, rowOnly)) return r - 0.5;
  }
  return INFLATE_RADIUS_PX;
}

function inRect(rect: PxRect, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h;
}

function ringHasGap(
  sheet: Sheet,
  rect: PxRect,
  x: number,
  y: number,
  r: number,
  rowOnly: boolean,
): boolean {
  const reach = rowOnly ? 0 : r;
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const qx = x + dx;
      const qy = y + dy;
      if (!inRect(rect, qx, qy) || !isOpaque(sheet, qx, qy)) return true;
    }
  }
  return false;
}

function roundedNormal(sheet: Sheet, rect: PxRect, x: number, y: number, rowOnly: boolean): Vec3 {
  const h = (qx: number, qy: number) =>
    inRect(rect, qx, qy) && isOpaque(sheet, qx, qy)
      ? roundedHeight(insetIn(sheet, rect, qx, qy, rowOnly))
      : 0;
  const right = (h(x + 1, y) - h(x - 1, y)) / 2;
  const up = rowOnly ? 0 : (h(x, y - 1) - h(x, y + 1)) / 2;
  return fromCamera(-right * INFLATE_RADIUS_PX, -up * INFLATE_RADIUS_PX, 1);
}

export function baseNormal(shape: Shape, sheet: Sheet, use: SpriteUse, x: number, y: number) {
  if (shape === "box") return boxFace(use, x - use.rect.x, y - use.rect.y);
  if (shape === "inflate") return roundedNormal(sheet, use.rect, x, y, false);
  if (shape === "cylinder") return roundedNormal(sheet, use.rect, x, y, true);
  return faceNormal(shape);
}

/** The surface's own screen-right and screen-up directions, for tilting it by a bump. */
function tangents(n: Vec3): [Vec3, Vec3] {
  const along = n[0];
  const flatRight: Vec3 = [1 - along * n[0], -along * n[1], -along * n[2]];
  const right = Math.hypot(...flatRight) < 0.2 ? ([0, 0, -1] as Vec3) : normalize(flatRight);
  const up = normalize([
    n[1] * right[2] - n[2] * right[1],
    n[2] * right[0] - n[0] * right[2],
    n[0] * right[1] - n[1] * right[0],
  ]);
  return [right, up];
}

export type DetailContext = {
  sheet: Sheet;
  use: SpriteUse;
  spec: TileSpec;
  groupAt: (x: number, y: number) => string | null;
};

function wrapInCell(x: number, y: number, qx: number, qy: number): [number, number] {
  const cx = Math.floor(x / CELL_SIZE) * CELL_SIZE;
  const cy = Math.floor(y / CELL_SIZE) * CELL_SIZE;
  const wrap = (v: number, c: number) => c + ((((v - c) % CELL_SIZE) + CELL_SIZE) % CELL_SIZE);
  return [wrap(qx, cx), wrap(qy, cy)];
}

/**
 * Brightness read as height, compared only with pixels of the same surface. A
 * seamless tile reads across its own cell's opposite edge instead of past it,
 * which is the pixel its repeat puts there.
 */
export function withDetail(n: Vec3, ctx: DetailContext, x: number, y: number): Vec3 {
  const strength = ctx.spec.detail ?? DEFAULT_DETAIL;
  if (strength === 0) return n;
  const own = luma(ctx.sheet, x, y);
  const group = ctx.groupAt(x, y);
  const heightAt = (qx: number, qy: number) => {
    const [wx, wy] = ctx.spec.seamless ? wrapInCell(x, y, qx, qy) : [qx, qy];
    if (!inRect(ctx.use.rect, wx, wy) || ctx.groupAt(wx, wy) !== group) return own;
    return luma(ctx.sheet, wx, wy);
  };
  const right = (heightAt(x + 1, y) - heightAt(x - 1, y)) / 2;
  const up = (heightAt(x, y - 1) - heightAt(x, y + 1)) / 2;
  const [t1, t2] = tangents(n);
  const k = strength;
  return normalize([
    n[0] - k * (right * t1[0] + up * t2[0]),
    n[1] - k * (right * t1[1] + up * t2[1]),
    n[2] - k * (right * t1[2] + up * t2[2]),
  ]);
}

export function encodeNormal(n: Vec3): [number, number, number] {
  return [
    Math.round((n[0] * 0.5 + 0.5) * CHANNEL_MAX),
    Math.round((n[1] * 0.5 + 0.5) * CHANNEL_MAX),
    Math.round((n[2] * 0.5 + 0.5) * CHANNEL_MAX),
  ];
}

export function decodeNormal(data: Uint8Array, i: number): Vec3 {
  return normalize([
    (data[i]! / CHANNEL_MAX) * 2 - 1,
    (data[i + 1]! / CHANNEL_MAX) * 2 - 1,
    (data[i + 2]! / CHANNEL_MAX) * 2 - 1,
  ]);
}

export { TO_CAMERA };
