import * as THREE from "three";
import {
  makeSpriteMesh,
  makeSpriteOutline,
  OVERLAY_RENDER_ORDER,
} from "./overlayMeshes";
import {
  loadPixelFont,
  PIXEL_TEXT_LINE_PX,
  rasterizePixelText,
  type PixelTextRaster,
} from "./pixelText";
import type { SpriteQuad } from "./spriteQuad";

/**
 * Who is who, drawn over their head.
 *
 * In the world rather than in the DOM: a name has to sit at the same whole-pixel
 * scale as the sprite it belongs to and move with it every frame, and an HTML
 * element chasing a canvas position is a second, slightly-late copy of the
 * camera. It is chrome, though — drawn after the palette pass, so the yellow is
 * the yellow asked for rather than the nearest colour the world's ramp has.
 */

/** EarthBound's dialogue yellow, near enough. */
export const NAME_COLOR = 0xffd23f;
export const NAME_OUTLINE_COLOR = 0x000000;

/** Clear air between the top of the head and the bottom of the text. */
const HEAD_GAP_PX = 3;

/**
 * A name and the point it hangs above — the top of an actor's head in world
 * pixels, motion offsets and all.
 */
export type NameLabel = {
  /** Actor id: identity for caching, not what gets drawn. */
  id: string;
  text: string;
  x: number;
  y: number;
};

/**
 * Where a label's texture lands, in world pixels.
 *
 * Rounded, because a texel has to cover exactly one world pixel: half a pixel
 * of offset is the difference between crisp 1-bit text and a blurred smear of
 * it across two columns. Odd-width names therefore sit a half pixel off centre,
 * which nobody can see, rather than being drawn between pixels, which everybody
 * can.
 */
export function labelRect(
  anchorX: number,
  anchorY: number,
  widthPx: number,
  heightPx: number = PIXEL_TEXT_LINE_PX,
): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.round(anchorX - widthPx / 2),
    y: Math.round(anchorY - HEAD_GAP_PX - heightPx),
    w: widthPx,
    h: heightPx,
  };
}

type LabelEntry = {
  text: string;
  raster: PixelTextRaster;
  text3d: THREE.Mesh;
  outline: THREE.Mesh;
};

/**
 * The label meshes, kept between frames.
 *
 * Rebuilt only when a name changes, which is close to never — a walking actor
 * just moves the meshes it already has. The chrome overlays next door are
 * rebuilt from a signature every time one changes, which is fine for a hover
 * outline that flickers on and off and wrong for something that moves every
 * single frame.
 */
export class NameLabelLayer {
  readonly group = new THREE.Group();
  private readonly entries = new Map<string, LabelEntry>();
  private fontReady = false;

  constructor() {
    this.group.matrixAutoUpdate = false;
    void loadPixelFont().then((ok) => {
      this.fontReady = ok;
    });
  }

  /**
   * Nothing to draw until the font lands. Deliberately silent: the fallback at
   * 8px is unreadable, and a name that appears a frame late reads as loading
   * while a mush of grey reads as broken.
   */
  set(labels: NameLabel[]) {
    if (!this.fontReady) {
      if (this.entries.size > 0) this.clear();
      return;
    }

    const live = new Set<string>();
    for (const label of labels) {
      live.add(label.id);
      const entry = this.entry(label);
      if (!entry) continue;
      const rect = labelRect(label.x, label.y, entry.raster.widthPx);
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      place(entry.text3d, cx, cy);
      place(entry.outline, cx, cy);
    }

    for (const [id, entry] of this.entries) {
      if (live.has(id)) continue;
      this.remove(id, entry);
    }
  }

  /** The meshes for this label, built or rebuilt if the name changed. */
  private entry(label: NameLabel): LabelEntry | null {
    const existing = this.entries.get(label.id);
    if (existing?.text === label.text) return existing;
    if (existing) this.remove(label.id, existing);

    const raster = rasterizePixelText(label.text);
    if (!raster) return null;

    // Anchored at the origin and moved by `place`: the geometry is the glyphs,
    // not where they happen to be standing this frame.
    const quad: SpriteQuad = {
      x: -raster.widthPx / 2,
      y: -raster.heightPx / 2,
      w: raster.widthPx,
      h: raster.heightPx,
      texture: raster.texture,
      u0: 0,
      v0: 0,
      u1: 1,
      v1: 1,
    };

    const text3d = makeSpriteMesh(quad, {
      color: NAME_COLOR,
      opacity: 1,
      blending: THREE.NormalBlending,
      renderOrder: OVERLAY_RENDER_ORDER.label,
    });
    const outline = makeSpriteOutline(quad, NAME_OUTLINE_COLOR);
    outline.renderOrder = OVERLAY_RENDER_ORDER.labelOutline;

    this.group.add(outline);
    this.group.add(text3d);
    const entry: LabelEntry = { text: label.text, raster, text3d, outline };
    this.entries.set(label.id, entry);
    return entry;
  }

  private remove(id: string, entry: LabelEntry) {
    this.group.remove(entry.text3d);
    this.group.remove(entry.outline);
    disposeMesh(entry.text3d);
    disposeMesh(entry.outline);
    entry.raster.texture.dispose();
    this.entries.delete(id);
  }

  private clear() {
    for (const [id, entry] of this.entries) this.remove(id, entry);
  }

  get isEmpty(): boolean {
    return this.entries.size === 0;
  }

  dispose() {
    this.clear();
  }
}

/** Sprite meshes hold their own matrix, so moving one is two lines, not a tree. */
function place(mesh: THREE.Mesh, x: number, y: number) {
  mesh.position.set(x, y, 0);
  mesh.updateMatrix();
}

function disposeMesh(mesh: THREE.Mesh) {
  mesh.geometry.dispose();
  const material = mesh.material;
  if (Array.isArray(material)) for (const m of material) m.dispose();
  else material.dispose();
}
